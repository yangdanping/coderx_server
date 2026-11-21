import { resolve } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import BusinessError from '../errors/BusinessError.js';
import type { AppEnv } from '../http/types.js';
import { createMultipartParser, isMultipart, MULTIPART_OVERHEAD_BYTES, multipartFieldLimits, readMultipart } from '../http/upload/multipart.js';
import { TempFiles } from '../http/upload/tempFiles.js';
import type { DiskUpload } from '../http/upload/uploadedFile.js';

type DiskUploadOptions = {
  root: string;
  field: 'avatar' | 'img' | 'video';
  maxCount?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
} & ({ mimePrefix: 'image/' | 'video/'; mimeError: string } | { mimePrefix?: undefined; mimeError?: undefined });

const AVATAR_BODY_BUDGET = 20 * 1024 * 1024 + MULTIPART_OVERHEAD_BYTES;

export function createDiskUpload({
  root, field, maxCount, maxBytes, mimePrefix, mimeError,
  maxRequestBytes = maxBytes === undefined ? AVATAR_BODY_BUDGET : (maxCount ?? 1) * maxBytes + MULTIPART_OVERHEAD_BYTES,
}: DiskUploadOptions): MiddlewareHandler<AppEnv> {
  const destination = resolve(root);
  return async (c, next) => {
    if (!isMultipart(c)) return next();
    if (!c.env?.incoming) throw new Error('Disk multipart uploads require the Node HTTP adapter');

    const tempFiles = new TempFiles(destination);
    const parse = createMultipartParser<Omit<DiskUpload, 'kind'>>(field, maxCount, {
      limits: {
        ...multipartFieldLimits,
        parts: multipartFieldLimits.fields + (maxCount ?? 1),
        ...(maxBytes === undefined ? {} : { fileSize: maxBytes }),
      },
      fileFilter: mimePrefix === undefined ? undefined : (_request, file, done) => {
        if (file.mimetype.startsWith(mimePrefix)) done(null, true);
        else done(new BusinessError(mimeError, 400, 400));
      },
      storage: {
        _handleFile(_request, file, done) {
          void tempFiles.write(file.originalname, file.stream).then(info => done(null, info), done);
        },
        _removeFile(_request, file, done) {
          // Release completed files before Multer drains the rejected request.
          void tempFiles.discardFile(file.path).then(() => done(), done);
        },
      },
    });

    try {
      const { files } = await readMultipart(c, parse, maxRequestBytes);
      c.set('diskUploads', files.map(file => ({ ...file, kind: 'disk' })));
    } catch (error) {
      await tempFiles.discard();
      throw error;
    }
    try {
      await next();
    } finally {
      // The mutation service now owns committed-file retention and compensation.
      c.set('diskUploads', undefined);
    }
  };
}
