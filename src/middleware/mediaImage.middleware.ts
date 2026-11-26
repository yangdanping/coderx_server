import type { MiddlewareHandler } from 'hono';
import BusinessError from '../errors/BusinessError.js';
import { FLOW_IMAGE_FORMAT_LIMIT_MESSAGE, FLOW_IMAGE_MIME_TYPES, FLOW_IMAGE_SIZE_LIMIT_MESSAGE, MAX_FLOW_IMAGE_FILE_SIZE } from '../constants/upload.js';
import type { AppEnv } from '../http/types.js';
import { createMultipartParser, isMultipart, MULTIPART_OVERHEAD_BYTES, multipartFieldLimits, readMultipart } from '../http/upload/multipart.js';
import type { MemoryUpload } from '../http/upload/uploadedFile.js';

const parseSingleImage = createMultipartParser<Omit<MemoryUpload, 'kind'>>('image', undefined, {
  limits: { ...multipartFieldLimits, parts: multipartFieldLimits.fields + 1, fileSize: MAX_FLOW_IMAGE_FILE_SIZE },
  fileFilter(_request, file, callback) {
    if (FLOW_IMAGE_MIME_TYPES.has(file.mimetype)) callback(null, true);
    else callback(new BusinessError(FLOW_IMAGE_FORMAT_LIMIT_MESSAGE, 400));
  },
});

/** The file and fields are available only while downstream handlers are running. */
export const mediaImageUpload: MiddlewareHandler<AppEnv> = async (c, next) => {
  const previousBody = c.get('parsedBody');
  c.set('mediaImageUploadActive', true);
  try {
    if (isMultipart(c)) {
      const { fields, files: [file] } = await readMultipart(c, parseSingleImage, MAX_FLOW_IMAGE_FILE_SIZE + MULTIPART_OVERHEAD_BYTES);
      if (fields) c.set('parsedBody', fields);
      if (file) c.set('mediaImageFile', { ...file, kind: 'memory' });
    }
    await next();
  } catch (error) {
    // Hono dispatches downstream errors to onError before leaving the scope.
    if (error instanceof Error && 'code' in error && error.code === 'LIMIT_FILE_SIZE') {
      throw new BusinessError(FLOW_IMAGE_SIZE_LIMIT_MESSAGE, 400);
    }
    throw error;
  } finally {
    c.set('mediaImageUploadActive', undefined);
    c.set('mediaImageFile', undefined);
    c.set('parsedBody', previousBody);
  }
};
