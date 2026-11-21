import type { Hono } from 'hono';
import { TrieRouter } from 'hono/router/trie-router';
import { getPath } from 'hono/utils/url';
import { isStrictHandler } from './registerRoutes.js';
import type { AppEnv } from './types.js';

type HttpRouter = Hono<AppEnv>['router'];
type RouteEntry = Parameters<HttpRouter['add']>[2];
type LegacyPath = { pattern: RegExp; parts: string[] | null };
type LegacyRegistration = { method: string; path: LegacyPath };

export function rawRequestPath(request: Request, env?: AppEnv['Bindings']): string {
  // The Node adapter may already have normalized dot segments in Request.url.
  const target = env?.incoming?.url ?? request.url;
  return target.replace(/^https?:\/\/[^/?#]+/i, '').split(/[?#]/, 1)[0];
}

function encodeLegacyParameter(value: string) {
  // Keep valid escapes so an encoded parameter cannot become a static route.
  // Koa leaves the entire segment untouched when one escape is malformed.
  try { decodeURIComponent(value); return value; }
  catch { return encodeURIComponent(value); }
}

/** Preserve Koa's optional trailing slash per registration, without rewriting the request. */
export class CompatibilityRouter implements HttpRouter {
  name = 'LegacyCompatibleTrieRouter';
  private routes = new TrieRouter<RouteEntry>();
  private methods = new TrieRouter<string>();
  private legacyPaths = new Map<string, LegacyPath>();
  private legacyRegistrations: LegacyRegistration[] = [];

  /** Match these Koa literal paths case-insensitively against the raw URL. */
  preserveLegacyLiteralPath(path: string): void {
    this.preserveLegacyParameterPath(path);
  }

  /** Match Koa's raw path while keeping parameter case and one-pass decoding. */
  preserveLegacyParameterPath(path: string): void {
    const parts = path.split('/');
    const pattern = parts.map(part => part.startsWith(':') ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    this.legacyPaths.set(path, { pattern: new RegExp(`^${pattern}/?$`, 'i'), parts });
  }

  /** Match a strict Koa RegExp registration without decoding or normalizing its path. */
  preserveLegacyRegexPath(path: string, pattern: RegExp): void {
    this.legacyPaths.set(path, { pattern, parts: null });
  }

  isLegacyPath(path: string): boolean {
    return [...this.legacyPaths.values()].some(({ pattern }) => pattern.test(path));
  }

  getPath(request: Request, env?: AppEnv['Bindings']): string {
    const decoded = getPath(request);
    const rawPath = rawRequestPath(request, env);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const matching = this.legacyRegistrations.filter(({ path }) => path.pattern.test(rawPath));
    const selected = matching.find(route => route.method === method || route.method === 'ALL') ?? matching[0];
    if (selected) {
      const { parts, pattern } = selected.path;
      if (parts === null) return rawPath;
      const match = pattern.exec(rawPath)!;
      let index = 1;
      const path = parts.map(part => part.startsWith(':') ? encodeLegacyParameter(match[index++]) : part).join('/');
      return rawPath.endsWith('/') ? `${path}/` : path;
    }
    // Decoding fixed segments would accept encoded literals that Koa did not match.
    return this.isLegacyPath(decoded) ? rawPath : decoded;
  }

  add(method: string, path: string, entry: RouteEntry): void {
    const legacyPath = this.legacyPaths.get(path);
    const strict = isStrictHandler(entry[0]);
    if (legacyPath && (legacyPath.parts === null) === strict) this.legacyRegistrations.push({ method, path: legacyPath });
    // Wildcards already include trailing slashes. Strict registrations receive no alias.
    const paths = strict || path.endsWith('*') ? [path] : [path, `${path}/`];
    for (const eligiblePath of paths) {
      this.routes.add(method, eligiblePath, entry);
      if (method !== 'ALL') this.methods.add('ALL', eligiblePath, method);
    }
  }

  match(method: string, path: string) {
    return this.routes.match(method, path);
  }

  allowedMethods(path: string, rawPath = path): string[] {
    const allowed = new Set<string>();
    const methods = this.isLegacyPath(rawPath)
      ? this.legacyRegistrations.filter(({ path }) => path.pattern.test(rawPath)).map(route => route.method)
      : this.methods.match('ALL', path)[0].map(([method]) => method);
    for (const method of methods) {
      if (method === 'GET') allowed.add('HEAD');
      allowed.add(method);
    }
    return [...allowed];
  }
}
