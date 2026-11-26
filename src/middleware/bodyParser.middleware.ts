import { PassThrough, Readable, Writable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import coBody from 'co-body';
import typeis from 'type-is';
import type { AppEnv } from '../http/types.js';

type ParserRequest = Readable & Pick<IncomingMessage, 'headers'>;
// The parser accepts the stream and headers used by ParserStream.
const parse = coBody as {
  json(request: ParserRequest): Promise<unknown>;
  form(request: ParserRequest): Promise<unknown>;
};
const hasBody = typeis.hasBody as (request: Pick<IncomingMessage, 'headers'>) => boolean;
const jsonTypes = ['application/json', 'application/json-patch+json', 'application/vnd.api+json', 'application/csp-report', 'application/scim+json'];

class ParserStream extends PassThrough {
  private destinations: NodeJS.WritableStream[] = [];
  constructor() {
    super();
    // Node's pipe does not forward source errors to inflation's decompressor.
    this.on('error', error => {
      for (const destination of this.destinations) {
        if (destination instanceof Writable && !destination.destroyed) destination.destroy(error);
      }
    });
  }
  override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    this.destinations.push(destination);
    return super.pipe(destination, options);
  }
  dispose() {
    for (const destination of this.destinations) {
      this.unpipe(destination);
      if ('destroy' in destination && typeof destination.destroy === 'function') destination.destroy();
    }
    this.destroy();
  }
}

/** Parsed data belongs to this context; downstream handlers should use c.get('parsedBody'). */
export const bodyParser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const headers = Object.fromEntries(c.req.raw.headers.entries());
  const contentType = headers['content-type'] ?? '';
  const json = typeis.is(contentType.replace(/;$/, ''), jsonTypes);
  const form = hasBody({ headers }) && typeis.is(contentType, ['application/x-www-form-urlencoded']);
  let body: unknown = {};
  if (json || form) {
    const borrowed = (c.req.method === 'GET' || c.req.method === 'HEAD') ? c.env?.incoming : undefined;
    const source = borrowed ?? (c.req.raw.body ? Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream) : Readable.from([]));
    const stream = new ParserStream();
    const request = Object.assign(stream, { headers });
    const onError = (error: Error) => stream.destroy(error);
    source.on('error', onError);
    source.pipe(stream);
    try {
      body = json ? await parse.json(request) : await parse.form(request);
    } finally {
      source.unpipe(stream);
      source.removeListener('error', onError);
      stream.dispose();
      if (borrowed) { if (!borrowed.destroyed) borrowed.resume(); }
      else source.destroy();
    }
  }
  c.set('parsedBody', body);
  await next();
};
