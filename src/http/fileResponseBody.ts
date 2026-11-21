import { constants, createReadStream, type ReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { Context } from 'hono';
import type { AppEnv } from './types.js';

function fileResponseBody(stream: ReadStream): ReadableStream<Uint8Array> {
  const reader: ReadableStreamDefaultReader<unknown> = Readable.toWeb(stream, {
    strategy: { highWaterMark: 1 },
  }).getReader();
  let cancelled = false;

  // Bridge Node's stream declarations to the response body without adding a second queue.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!(value instanceof Uint8Array)) {
          await reader.cancel();
          throw new TypeError('Expected bytes from the file stream');
        }
        controller.enqueue(value);
      } catch (error) {
        if (cancelled) return;
        reader.releaseLock();
        throw error;
      }
    },
    async cancel(reason: unknown) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });
}

export function isLocalMediaFilename(filename: string): boolean {
  return !!filename && filename !== '.' && filename !== '..' && !/[\\/\0]/.test(filename);
}

export async function openLocalMedia(root: string, filename: string) {
  if (!isLocalMediaFilename(filename)) return null;
  const path = resolve(root, filename);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (stat.isFile()) return { handle, path, size: stat.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

/** Stream the same regular file whose descriptor was checked, including for Range reads. */
export async function localFileResponse(
  c: Context<AppEnv>,
  { handle, path }: NonNullable<Awaited<ReturnType<typeof openLocalMedia>>>,
  contentType: string,
  status: 200 | 206 = 200,
  range?: { start: number; end: number },
): Promise<Response> {
  const outgoing = c.env?.outgoing;
  let stream: ReadStream | undefined;
  try {
    c.header('Content-Type', contentType);
    if (c.req.method === 'HEAD' || outgoing?.destroyed) {
      await handle.close();
      return c.body(null, status);
    }
    if (c.env?.incoming?.httpVersionMajor === 1 && !c.res.headers.has('content-length')) {
      c.header('Transfer-Encoding', 'chunked');
    }
    const input = createReadStream(path, { fd: handle, ...range });
    stream = input;
    if (outgoing) {
      const close = () => input.destroy();
      outgoing.once('close', close);
      input.once('close', () => outgoing.off('close', close));
    }
    return c.body(fileResponseBody(input), status);
  } catch (error) {
    stream?.destroy();
    await handle.close();
    throw error;
  }
}
