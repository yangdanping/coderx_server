import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp, type SharpOptions } from 'sharp';
import { FLOW_IMAGE_FORMAT_LIMIT_MESSAGE } from '../../constants/upload.js';
import BusinessError from '../../errors/BusinessError.js';
import { decodeMediaImage, decodeMediaImageBuffer } from '../mediaImageInput.service.js';

interface ImageTransaction {
  beginTransaction(): Promise<void>;
  execute(sql: string, params: unknown[]): Promise<readonly [result: unknown, fields: unknown]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface ImageDatabase {
  getConnection(): Promise<ImageTransaction>;
}

interface ImageFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: 'wx'): Promise<{
    writeFile(buffer: Buffer): Promise<void>;
    close(): Promise<void>;
  }>;
  unlink(path: string): Promise<void>;
}

export type ImageVariant = 'original' | 'small';
type ImageUrlResolver = (fileId: number, options: { variant: ImageVariant }) => Promise<unknown>;
type ImageInput = Parameters<typeof decodeMediaImage>[0];
type SharpFactory = (buffer: Buffer, options?: SharpOptions) =>
  ReturnType<NonNullable<Parameters<typeof decodeMediaImage>[1]>> & Pick<Sharp, 'resize'>;

interface Options {
  database: ImageDatabase;
  imageRoot: string;
  fsPromises?: ImageFileSystem;
  publicApiOrigin: string;
  resolveImageUrl: ImageUrlResolver;
  randomUUID?: () => string;
  sharp?: SharpFactory;
}

export function normalizePositiveId(value: unknown, name: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new BusinessError(`参数错误: ${name} 必须是正整数`, 400);
  }
  return normalized;
}

export function createMediaImageUploadService({
  database, imageRoot, publicApiOrigin, resolveImageUrl,
  fsPromises = fs, sharp: openImage = sharp, randomUUID: makeId = randomUUID,
}: Options) {
  const root = path.resolve(imageRoot);

  function imagePath(filename: string): string {
    const resolved = path.resolve(root, filename);
    if (path.dirname(resolved) !== root) throw new TypeError('image path escaped its configured root');
    return resolved;
  }

  async function prepareVariants(original: Awaited<ReturnType<typeof decodeMediaImage>>) {
    let small: Buffer;
    try {
      small = await openImage(original.data)
        .resize({ width: 640, withoutEnlargement: true })
        .webp({ quality: 76 })
        .toBuffer();
    } catch {
      throw new BusinessError(FLOW_IMAGE_FORMAT_LIMIT_MESSAGE, 400);
    }

    const baseName = makeId();
    return {
      filename: `${baseName}.webp`,
      smallFilename: `${baseName}-small.webp`,
      original: original.data,
      small,
      mimeType: 'image/webp' as const,
      sizeBytes: original.data.length,
      width: Number(original.info.width),
      height: Number(original.info.height),
    };
  }

  async function normalizeImage(buffer: unknown, declaredMimeType: unknown) {
    return prepareVariants(await decodeMediaImageBuffer(buffer, declaredMimeType, openImage));
  }

  async function unlinkGenerated(paths: string[]): Promise<void> {
    await Promise.all(paths.map(async (filePath) => {
      try {
        await fsPromises.unlink(filePath);
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') {
          console.error(`media image compensation failed for ${filePath}:`, error);
        }
      }
    }));
  }

  async function writeOwnedFile(filePath: string, buffer: Buffer, ownedPaths: string[]): Promise<void> {
    const handle = await fsPromises.open(filePath, 'wx');
    ownedPaths.push(filePath);
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
  }

  async function resolveUrl(fileId: number, filename: string, variant: ImageVariant): Promise<string> {
    try {
      const url = await resolveImageUrl(fileId, { variant });
      if (typeof url === 'string' && url) return url;
    } catch (error) {
      console.error(`media image URL resolution fell back to local ${variant}:`, error instanceof Error ? error.message : error);
    }
    const original = `${publicApiOrigin.replace(/\/$/, '')}/article/images/${encodeURIComponent(filename)}`;
    return variant === 'small' ? `${original}?type=small` : original;
  }

  async function createPendingImage(userId: unknown, file: ImageInput) {
    const normalizedUserId = normalizePositiveId(userId, 'userId');
    const { filename, smallFilename, original, small, mimeType, sizeBytes, width, height } =
      await prepareVariants(await decodeMediaImage(file, openImage));
    const originalPath = imagePath(filename);
    const smallPath = imagePath(smallFilename);
    const ownedPaths: string[] = [];
    let conn: ImageTransaction | undefined;
    let transactionStarted = false;
    let commitAttempted = false;
    let fileId: number;

    try {
      await fsPromises.mkdir(root, { recursive: true });
      await writeOwnedFile(originalPath, original, ownedPaths);
      await writeOwnedFile(smallPath, small, ownedPaths);

      conn = await database.getConnection();
      await conn.beginTransaction();
      transactionStarted = true;
      // Pending files have no article, draft, or Flow association.
      const [result] = await conn.execute(
        "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'image') RETURNING id;",
        [normalizedUserId, filename, mimeType, sizeBytes],
      );
      fileId = typeof result === 'object' && result !== null && 'insertId' in result ? Number(result.insertId) : 0;
      if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error('image file insert did not return an id');
      await conn.execute('INSERT INTO image_meta (file_id, width, height, is_cover) VALUES (?,?,?,FALSE);', [fileId, width, height]);
      commitAttempted = true;
      await conn.commit();
    } catch (error) {
      if (conn && transactionStarted) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error('media image transaction rollback failed:', rollbackError);
        }
      }
      // A lost COMMIT acknowledgement can still leave a row referencing both variants.
      if (!commitAttempted) await unlinkGenerated(ownedPaths);
      throw error;
    } finally {
      conn?.release();
    }

    // URL lookups can need a fresh pool connection. Committed files are no
    // longer eligible for compensation even if response preparation fails.
    return {
      id: fileId,
      url: await resolveUrl(fileId, filename, 'original'),
      thumbnailUrl: await resolveUrl(fileId, filename, 'small'),
      mimeType,
      sizeBytes,
      width,
      height,
    };
  }

  return { createPendingImage, normalizeImage };
}

export type MediaImageUploadService = ReturnType<typeof createMediaImageUploadService>;
