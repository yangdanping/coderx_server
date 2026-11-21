import { Readable, Transform, type TransformCallback, type Writable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import type { ReadableStream } from 'node:stream/web';
import type { Context } from 'hono';
import multerModule from 'multer';
import typeis from 'type-is';
import BusinessError from '../../errors/BusinessError.js';
import type { AppEnv } from '../types.js';

export const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const multipartFieldLimits = {
  fields: 32,
  fieldSize: 16 * 1024,
  fieldNameSize: 128,
  fieldNestingDepth: 8,
  fieldArrayIndexLimit: 256,
};

type MultipartLimits = typeof multipartFieldLimits & { fileSize?: number; parts?: number };
type FilePart = { fieldname: string; originalname: string; mimetype: string; stream: Readable };
type FileInfo = { destination: string; filename: string; path: string; size: number };
type Done = (error?: Error) => void;
type Storage = {
  _handleFile(request: MultipartRequest<unknown>, file: FilePart, done: (error: Error | null, result?: FileInfo) => void): void;
  _removeFile(request: MultipartRequest<unknown>, file: { path?: string }, done: Done): void;
};
type Parse<File> = (request: MultipartRequest<File>, response: undefined, done: Done) => void;

// Type the locked Multer stream and storage interfaces used by this adapter.
const multer = multerModule as {
  <File>(options: {
    storage: unknown;
    limits: MultipartLimits;
    fileFilter?: (request: MultipartRequest<File>, file: FilePart, done: (error: Error | null, accepted?: boolean) => void) => void;
    streamHandler: (request: MultipartRequest<File>, parser: Writable) => void;
  }): {
    single(field: string): Parse<File>;
    array(field: string, maximum: number): Parse<File>;
  };
  memoryStorage(): unknown;
};

class MultipartBudgetError extends BusinessError {
  constructor() { super('上传请求体超过大小限制', 413); }
}

class MultipartRequest<File> extends Transform {
  body?: Record<string, unknown>;
  file?: File;
  files?: File[];
  parser?: Writable;
  private bytes = 0;

  constructor(readonly headers: IncomingHttpHeaders, private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) callback(new MultipartBudgetError());
    else callback(null, chunk);
  }
}

export function isMultipart(c: Context<AppEnv>): boolean {
  return Boolean(typeis.is(c.req.header('content-type') ?? '', ['multipart/*']));
}

export function createMultipartParser<File>(field: string, maxCount: number | undefined, options: {
  storage?: Storage;
  limits: MultipartLimits;
  fileFilter?: (request: MultipartRequest<File>, file: FilePart, done: (error: Error | null, accepted?: boolean) => void) => void;
}): Parse<File> {
  const parser = multer<File>({
    ...options,
    storage: options.storage ?? multer.memoryStorage(),
    streamHandler(request, parser) {
      request.parser = parser;
      request.pipe(parser);
    },
  });
  return maxCount === undefined ? parser.single(field) : parser.array(field, maxCount);
}

/** Borrow Node's stream once, using a counting transform for bounded, backpressured parsing. */
export async function readMultipart<File>(c: Context<AppEnv>, parse: Parse<File>, maxBytes: number) {
  const incoming = c.env?.incoming;
  const headers = incoming?.headers ?? Object.fromEntries(c.req.raw.headers);
  const webBody = incoming ? null : c.req.raw.body as ReadableStream<Uint8Array> | null;
  const declared = headers['content-length'];
  if (typeof declared === 'string' && Number(declared) > maxBytes) {
    if (incoming?.httpVersionMajor === 1) c.header('Connection', 'close');
    if (webBody && !webBody.locked) void webBody.cancel().catch(() => {});
    throw new MultipartBudgetError();
  }
  // Fetch requests can supply multipart bytes without HTTP framing headers.
  const request = new MultipartRequest<File>(webBody && declared === undefined && headers['transfer-encoding'] === undefined
    ? { ...headers, 'transfer-encoding': 'chunked' }
    : headers, maxBytes);
  let source: Readable | undefined;
  let budgetError: MultipartBudgetError | undefined;
  const signal = incoming ? undefined : c.req.raw.signal;
  const fail = (error: Error) => { request.destroy(error); };
  const aborted = () => fail(new Error('Request aborted'));
  const closed = () => { if (!source?.readableEnded) aborted(); };
  request.on('error', error => {
    if (error instanceof MultipartBudgetError) budgetError = error;
  });

  try {
    const parsed = new Promise<void>((resolve, reject) => {
      parse(request, undefined, error => error ? reject(error) : resolve());
    });
    if (request.parser) {
      try {
        source = incoming ?? (webBody ? Readable.fromWeb(webBody) : Readable.from([]));
        source.on('error', fail);
        source.on('aborted', aborted);
        source.on('close', closed);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted || source.destroyed) aborted();
        else source.pipe(request);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
    await parsed;
    if (budgetError) throw budgetError;
    return { fields: request.body, files: request.files ?? (request.file ? [request.file] : []) };
  } catch (error) {
    // A parser error may already be waiting for the request to drain.
    if (budgetError && incoming?.httpVersionMajor === 1) c.header('Connection', 'close');
    throw budgetError ?? error;
  } finally {
    signal?.removeEventListener('abort', aborted);
    source?.unpipe(request);
    source?.off('aborted', aborted);
    source?.off('close', closed);
    if (incoming || source?.closed) source?.off('error', fail);
    else if (source) {
      source.once('close', () => source?.off('error', fail));
      source.destroy();
    } else if (request.body && webBody && !webBody.locked) {
      // Multer recognized multipart but could not construct a parser.
      void webBody.cancel().catch(() => {});
    }
    if (request.parser && !request.parser.destroyed) {
      request.unpipe(request.parser);
      request.parser.on('error', () => {});
      request.parser.destroy();
    }
    request.destroy();
  }
}
