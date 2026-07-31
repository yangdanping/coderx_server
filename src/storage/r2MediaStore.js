const { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { IMMUTABLE_CACHE_CONTROL } = require('@/constants/mediaStorage');

function isNotFound(error) {
  return error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;
}

function encodeKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\')) {
    throw new TypeError('R2 media key must be a relative object key');
  }
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('R2 media key contains an unsafe path segment');
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

class R2MediaStore {
  constructor({ client, bucket, publicBaseUrl }) {
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

  async put({ key, body, contentType, sizeBytes, sha256, cacheControl = IMMUTABLE_CACHE_CONTROL }) {
    const existing = await this.head(key);
    if (existing) {
      if (existing.sizeBytes === sizeBytes && existing.sha256 === sha256) {
        return { ...existing, skipped: true };
      }
      throw new Error(`R2 object conflict for key "${key}"; existing content will not be overwritten`);
    }

    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: sizeBytes,
        CacheControl: cacheControl,
        Metadata: { sha256 },
      }),
    );

    return {
      key,
      sizeBytes,
      sha256,
      etag: result?.ETag ?? null,
      skipped: false,
    };
  }

  async head(key) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return {
        key,
        sizeBytes: Number(result.ContentLength),
        sha256: result.Metadata?.sha256 ?? result.Metadata?.SHA256 ?? null,
        etag: result.ETag ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key) {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  publicUrl(key) {
    const encodedKey = encodeKey(key);
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${encodedKey}` : `/${encodedKey}`;
  }
}

function createR2MediaStore(options) {
  return new R2MediaStore(options);
}

function createR2Client({ accountId, accessKeyId, secretAccessKey }) {
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

module.exports = {
  R2MediaStore,
  createR2Client,
  createR2MediaStore,
};
