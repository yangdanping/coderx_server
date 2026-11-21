import { unlink } from 'node:fs/promises';
import { format, parse } from 'node:path';
import { Jimp } from 'jimp';
import type { ImageService } from './image.service.js';

type UploadedImage = { path: string; filename: string; mimetype: string; size: number };

export function imageThumbnailPath(originalPath: string): string {
  const { dir, name, ext } = parse(originalPath);
  return format({ dir, name: `${name}-small`, ext });
}

export async function makeImageThumbnail(originalPath: string): Promise<void> {
  const image = await Jimp.read(originalPath);
  image.resize({ w: 320 });
  await image.write(imageThumbnailPath(originalPath) as `${string}.${string}`);
}

async function discardUpload(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      console.error('Image upload cleanup failed');
    }
  }
}

export async function saveUploadedImages(
  service: Pick<ImageService, 'addImage'>,
  userId: unknown,
  files: UploadedImage[],
  publicApiOrigin: string,
) {
  const [first] = files;
  if (first) {
    try {
      await makeImageThumbnail(first.path);
    } catch (error) {
      await Promise.all([...files.map(file => discardUpload(file.path)), discardUpload(imageThumbnailPath(first.path))]);
      throw error;
    }
  }

  const saved: { result: unknown; url: string }[] = [];
  for (const file of files) {
    try {
      const result = await service.addImage(userId, file.filename, file.mimetype, file.size, null, null, async () => {
        await discardUpload(file.path);
        if (file === first) await discardUpload(imageThumbnailPath(file.path));
      });
      if (result) {
        saved.push({ result, url: `${publicApiOrigin}/article/images/${file.filename}` });
      }
    } catch {
      console.error('Image upload metadata could not be saved');
    }
  }
  return saved;
}
