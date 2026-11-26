import type { Hono } from 'hono';
import type { HttpBindings, Http2Bindings } from '@hono/node-server';
import type { DiskUpload, MemoryUpload } from './upload/uploadedFile.js';
/** Preserve the payload returned by JWT verification without asserting application claim types. */
export type AuthUser = string | number | boolean | Record<string, unknown> | unknown[];
export function authUserId(user: AuthUser | undefined): unknown {
  return typeof user === 'object' && user !== null && !Array.isArray(user) ? user.id : undefined;
}
export type AppEnv = {
  Bindings: Partial<HttpBindings | Http2Bindings>;
  Variables: {
    user: AuthUser;
    parsedBody: unknown;
    diskUploads?: DiskUpload[];
    mediaImageFile?: MemoryUpload;
    mediaImageUploadActive?: true;
  };
};
export interface HttpAppOptions {
  developmentErrors?: boolean;
  logRequest?: (record: { method: string; status: number; durationMs: number }) => void;
  buildId: string;
  checkReady: () => Promise<boolean>;
  registerRoutes: (app: Hono<AppEnv>) => void;
  readinessTimeoutMs?: number;
  allowedOrigins?: readonly string[];
}
