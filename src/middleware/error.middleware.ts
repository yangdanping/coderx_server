import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../http/types.js';
import { LegacyEmittedError } from '../http/legacyError.js';
import { legacyJson } from '../http/legacyResponse.js';
import { rawRequestPath } from '../http/compatibility.router.js';
import BusinessError from '../errors/BusinessError.js';
import { FLOW_IMAGE_SIZE_LIMIT_MESSAGE, IMAGE_SIZE_LIMIT_MESSAGE, VIDEO_SIZE_LIMIT_MESSAGE, IMAGE_BATCH_COUNT_LIMIT_MESSAGE, IMAGE_TYPE_LIMIT_MESSAGE, VIDEO_TYPE_LIMIT_MESSAGE } from '../constants/upload.js';

function validStatus(value: unknown): value is ContentfulStatusCode {
  return typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 599 && value !== 204 && value !== 205 && value !== 304;
}
function property(error: Error, key: string): unknown { return Reflect.get(error, key); }
export function errorHandler(development: boolean): ErrorHandler<AppEnv> {
  return (error, c) => {
    const business = error instanceof BusinessError;
    const rawStatus = property(error, 'httpStatus');
    const rawCode = property(error, 'bizCode');
    const code = property(error, 'code');
    // The legacy upload middleware remaps this code even when thrown by its controller.
    if (code === 'LIMIT_FILE_SIZE' && c.get('mediaImageUploadActive')) {
      return legacyJson(c, { msg: FLOW_IMAGE_SIZE_LIMIT_MESSAGE, code: 400 }, 400);
    }
    const field = property(error, 'field');
    const invalid = (rawStatus !== undefined && !validStatus(rawStatus)) || (rawCode !== undefined && (typeof rawCode !== 'number' || !Number.isSafeInteger(rawCode)));
    let message = business || error instanceof LegacyEmittedError ? error.message : development ? `[DEV] ${error.message}` : '服务器内部错误';
    let uploadError = false;
    if (!business) {
      const path = rawRequestPath(c.req.raw, c.env);
      if (code === 'LIMIT_FILE_SIZE' && (field === 'video' || path.startsWith('/video'))) { message = VIDEO_SIZE_LIMIT_MESSAGE; uploadError = true; }
      else if (code === 'LIMIT_FILE_SIZE' && (field === 'img' || path.startsWith('/img'))) { message = IMAGE_SIZE_LIMIT_MESSAGE; uploadError = true; }
      else if (code === 'LIMIT_UNEXPECTED_FILE' && (field === 'img' || path.startsWith('/img'))) { message = IMAGE_BATCH_COUNT_LIMIT_MESSAGE; uploadError = true; }
      else if (error.message === IMAGE_TYPE_LIMIT_MESSAGE || error.message === VIDEO_TYPE_LIMIT_MESSAGE) { message = error.message; uploadError = true; }
    }
    if (invalid) return legacyJson(c, { msg: '服务器内部错误', code: 500 }, 500);
    const status = validStatus(rawStatus) ? rawStatus : uploadError ? 400 : 500;
    return legacyJson(c, { msg: message, code: typeof rawCode === 'number' && rawCode ? rawCode : status }, status);
  };
}
