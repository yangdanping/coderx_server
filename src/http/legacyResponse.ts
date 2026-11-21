import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './types.js';

export function legacyJson(c: Context<AppEnv>, data: unknown, status: ContentfulStatusCode = 200): Response {
  const body = JSON.stringify(data);
  return c.body(body, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
}

export function legacyText(c: Context<AppEnv>, body: string, status: ContentfulStatusCode): Response {
  return c.body(body, status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
}
