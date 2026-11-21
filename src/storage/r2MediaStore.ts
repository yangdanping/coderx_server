import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { IMMUTABLE_CACHE_CONTROL } from '../constants/mediaStorage.js';

type R2Body = NonNullable<PutObjectCommandInput['Body']>;
type R2PutSource = { body: R2Body; bodyFactory?: () => R2Body } | { body?: R2Body | null; bodyFactory: () => R2Body };

export type R2MediaPutInput = R2PutSource & {
  key: string;
  contentType?: string;
  sizeBytes: number;
  sha256: string;
  contentMd5?: string;
  cacheControl?: string;
};

export interface R2MediaMetadata {
  key: string;
  sizeBytes: number;
  sha256: string | null;
  etag: string | null;
}

export interface R2MediaPutResult extends R2MediaMetadata {
  sha256: string;
  skipped: boolean;
}

export interface R2MediaListOptions {
  continuationToken?: string | null;
  prefix?: string;
  maxKeys?: number | string;
}

export interface R2MediaListPage {
  objects: { key: string; sizeBytes: number; etag: string | null; lastModified: Date | null }[];
  continuationToken: string | null;
}

type R2HeadResponse = Pick<HeadObjectCommandOutput, 'ContentLength' | 'Metadata' | 'ETag'>;
type R2PutResponse = Pick<PutObjectCommandOutput, 'ETag'>;
type R2ListResponse = Pick<ListObjectsV2CommandOutput, 'Contents' | 'IsTruncated' | 'NextContinuationToken'>;

export interface R2StoreClient {
  send(command: HeadObjectCommand): R2HeadResponse | Promise<R2HeadResponse>;
  send(command: PutObjectCommand): R2PutResponse | Promise<R2PutResponse>;
  send(command: ListObjectsV2Command): R2ListResponse | Promise<R2ListResponse>;
  send(command: DeleteObjectCommand): unknown;
}

export interface R2MediaStoreOptions {
  client: R2StoreClient;
  bucket: string;
  publicBaseUrl?: string | null;
}

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function errorProperty(error: unknown, property: string): unknown {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  return Reflect.get(error, property);
}

function isNotFound(error: unknown): boolean {
  const name = errorProperty(error, 'name');
  return name === 'NotFound' || name === 'NoSuchKey' || errorProperty(error, 'Code') === 'NoSuchKey' || errorProperty(errorProperty(error, '$metadata'), 'httpStatusCode') === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    errorProperty(error, 'name') === 'PreconditionFailed' ||
    errorProperty(error, 'Code') === 'PreconditionFailed' ||
    errorProperty(errorProperty(error, '$metadata'), 'httpStatusCode') === 412
  );
}

function normalizeKey(key: unknown): string {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\')) {
    throw new TypeError('R2 media key must be a relative object key');
  }
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('R2 media key contains an unsafe path segment');
  }
  return segments.join('/');
}

function encodeKey(key: string): string {
  return normalizeKey(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function matchesExpected(existing: R2MediaMetadata | null, { sizeBytes, sha256 }: Pick<R2MediaPutInput, 'sizeBytes' | 'sha256'>): existing is R2MediaMetadata & { sha256: string } {
  return existing?.sizeBytes === sizeBytes && existing?.sha256 === sha256;
}

function disposeUnusedBody(body: R2Body | null | undefined): void {
  if (
    body !== null &&
    (typeof body === 'object' || typeof body === 'function') &&
    'destroy' in body &&
    typeof body.destroy === 'function' &&
    !('destroyed' in body && body.destroyed)
  ) {
    body.destroy();
  }
}

export class R2MediaStore {
  declare client: R2StoreClient;
  declare bucket: string;
  declare publicBaseUrl: string;

  constructor({ client, bucket, publicBaseUrl }: R2MediaStoreOptions) {
    if (!client || typeof client.send !== 'function') {
      throw new TypeError('an injected S3-compatible client is required');
    }
    if (typeof bucket !== 'string' || !bucket.trim()) {
      throw new TypeError('bucket is required');
    }

    this.client = client;
    this.bucket = bucket;
    this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/+$/, '');
  }

  async put({ key, body, bodyFactory, contentType, sizeBytes, sha256, contentMd5, cacheControl = IMMUTABLE_CACHE_CONTROL }: R2MediaPutInput): Promise<R2MediaPutResult> {
    const normalizedKey = normalizeKey(key);
    if (body == null && typeof bodyFactory !== 'function') {
      throw new TypeError('body or bodyFactory is required');
    }

    const existing = await this.head(normalizedKey);
    if (existing) {
      disposeUnusedBody(body);
      if (matchesExpected(existing, { sizeBytes, sha256 })) {
        return { ...existing, skipped: true };
      }
      throw new Error(`R2 object conflict for key "${normalizedKey}"; existing content will not be overwritten`);
    }

    const uploadBody = typeof bodyFactory === 'function' ? bodyFactory() : (body ?? undefined);
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: normalizedKey,
          Body: uploadBody,
          ContentType: contentType,
          ContentLength: sizeBytes,
          CacheControl: cacheControl,
          ...(contentMd5 ? { ContentMD5: contentMd5 } : {}),
          IfNoneMatch: '*',
          Metadata: { sha256 },
        }),
      );

      return {
        key: normalizedKey,
        sizeBytes,
        sha256,
        etag: result?.ETag ?? null,
        skipped: false,
      };
    } catch (error) {
      disposeUnusedBody(uploadBody);
      if (!isPreconditionFailed(error)) throw error;

      const winner = await this.head(normalizedKey);
      if (matchesExpected(winner, { sizeBytes, sha256 })) {
        return { ...winner, skipped: true };
      }
      throw new Error(`R2 object conflict for key "${normalizedKey}"; a concurrent writer stored different content`, {
        cause: error,
      });
    }
  }

  async head(key: string): Promise<R2MediaMetadata | null> {
    const normalizedKey = normalizeKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: normalizedKey,
        }),
      );
      return {
        key: normalizedKey,
        sizeBytes: Number(result.ContentLength),
        sha256: result.Metadata?.sha256 ?? result.Metadata?.SHA256 ?? null,
        etag: result.ETag ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const normalizedKey = normalizeKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: normalizedKey,
        }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async list({ continuationToken, prefix = '', maxKeys = 1_000 }: R2MediaListOptions = {}): Promise<R2MediaListPage> {
    if (typeof prefix !== 'string' || prefix.includes('\\') || prefix.startsWith('/')) {
      throw new TypeError('R2 list prefix must be a relative object-key prefix');
    }
    const normalizedMaxKeys = Number(maxKeys);
    if (!Number.isSafeInteger(normalizedMaxKeys) || normalizedMaxKeys <= 0 || normalizedMaxKeys > 1_000) {
      throw new TypeError('R2 list maxKeys must be an integer between 1 and 1000');
    }
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        ...(prefix ? { Prefix: prefix } : {}),
        MaxKeys: normalizedMaxKeys,
      }),
    );
    return {
      objects: (result.Contents || [])
        .filter((object): object is typeof object & { Key: string } => typeof object.Key === 'string' && object.Key.length > 0)
        .map((object) => ({
          key: object.Key,
          sizeBytes: Number(object.Size || 0),
          etag: object.ETag ?? null,
          lastModified: object.LastModified ?? null,
        })),
      continuationToken: result.IsTruncated ? result.NextContinuationToken || null : null,
    };
  }

  publicUrl(key: string): string {
    const encodedKey = encodeKey(key);
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${encodedKey}` : `/${encodedKey}`;
  }
}

export function createR2MediaStore(options: R2MediaStoreOptions): R2MediaStore {
  return new R2MediaStore(options);
}

export function createR2Client({ accountId, accessKeyId, secretAccessKey }: R2Credentials): S3Client {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new TypeError('R2 account ID and S3 credentials are required');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}
