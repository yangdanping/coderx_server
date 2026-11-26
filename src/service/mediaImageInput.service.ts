import sharp, { type Metadata, type Sharp, type SharpOptions } from 'sharp';
import BusinessError from '../errors/BusinessError.js';
import {
  FLOW_IMAGE_MIME_TYPES,
  FLOW_IMAGE_FORMAT_LIMIT_MESSAGE,
  FLOW_IMAGE_SIZE_LIMIT_MESSAGE,
  MAX_FLOW_IMAGE_FILE_SIZE,
  MAX_FLOW_IMAGE_PIXELS,
} from '../constants/upload.js';

const decodedMimeTypes = new Map([
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

type ImageMetadata = Pick<Metadata, 'format' | 'width' | 'height'>;
type OpenImage = (input: Buffer, options: SharpOptions) => {
  metadata(): Promise<ImageMetadata>;
  rotate: Sharp['rotate'];
};

function formatError() {
  return new BusinessError(FLOW_IMAGE_FORMAT_LIMIT_MESSAGE, 400);
}

function pixelLimitError() {
  return new BusinessError('图片像素不能超过 40,000,000', 400);
}

/** Decode and prepare the original image using the same checks as legacy normalization. */
export async function decodeMediaImageBuffer(buffer: unknown, declaredMimeType: unknown, openImage: OpenImage = sharp) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw formatError();
  if (buffer.length > MAX_FLOW_IMAGE_FILE_SIZE) throw new BusinessError(FLOW_IMAGE_SIZE_LIMIT_MESSAGE, 400);
  if (typeof declaredMimeType !== 'string' || !FLOW_IMAGE_MIME_TYPES.has(declaredMimeType)) throw formatError();

  let image: ReturnType<OpenImage>;
  let metadata: ImageMetadata;
  try {
    image = openImage(buffer, { failOn: 'warning', limitInputPixels: MAX_FLOW_IMAGE_PIXELS });
    metadata = await image.metadata();
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
    if (/input image exceeds pixel limit/i.test(String(message || error))) {
      throw pixelLimitError();
    }
    throw formatError();
  }

  if (!metadata.format || decodedMimeTypes.get(metadata.format) !== declaredMimeType) throw formatError();
  const pixels = Number(metadata.width) * Number(metadata.height);
  if (!Number.isSafeInteger(pixels) || pixels > MAX_FLOW_IMAGE_PIXELS) throw pixelLimitError();

  try {
    // Reading headers alone can succeed on images with truncated pixel data.
    return await image
      .rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw formatError();
  }
}

export async function decodeMediaImage(file: { buffer: unknown; mimetype: unknown } | undefined, openImage: OpenImage = sharp) {
  if (!Buffer.isBuffer(file?.buffer)) throw new BusinessError('请选择要上传的图片', 400);
  return decodeMediaImageBuffer(file.buffer, file.mimetype, openImage);
}
