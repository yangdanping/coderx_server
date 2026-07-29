const dns = require('node:dns');
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPublicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second, third] = parts;

  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false;
  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length));
  }
  return true;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Remote target must be an HTTP URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Remote target must be an HTTP URL');
  }
  if (url.username || url.password) {
    throw new Error('Remote target must not include credentials');
  }
  return url;
}

async function assertPublicHttpUrl(value, { lookup = dns.promises.lookup } = {}) {
  const url = parseHttpUrl(value);
  const hostnameFamily = net.isIP(url.hostname);
  const addresses = hostnameFamily
    ? [{ address: url.hostname, family: hostnameFamily }]
    : await lookup(url.hostname, {
        all: true,
        verbatim: true,
      });
  const normalizedAddresses = Array.isArray(addresses) ? addresses : [addresses];

  if (normalizedAddresses.length === 0 || normalizedAddresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('Remote target must resolve only to a public internet address');
  }
  return url;
}

function contentTypeAllowed(contentType, allowedContentTypes) {
  return allowedContentTypes.some((allowed) => contentType.toLowerCase().startsWith(allowed.toLowerCase()));
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Remote response exceeds maximum size of ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Remote response exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function safeRemoteFetch(
  value,
  {
    fetchImpl = globalThis.fetch,
    lookup = dns.promises.lookup,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowedContentTypes = ['text/html', 'application/xhtml+xml'],
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');
  let currentUrl = (await assertPublicHttpUrl(value, { lookup })).toString();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: allowedContentTypes.includes('image/') ? 'image/jpeg,image/png,image/webp' : 'text/html,application/xhtml+xml',
          'user-agent': 'CoderXContentFetcher/1.0',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Remote redirect ${response.status} is missing a location`);
      if (redirectCount === maxRedirects) throw new Error(`Remote response exceeded ${maxRedirects} redirects`);
      currentUrl = (await assertPublicHttpUrl(new URL(location, currentUrl).toString(), { lookup })).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Remote request failed with HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentTypeAllowed(contentType, allowedContentTypes)) {
      throw new Error(`Remote response has unsupported content type: ${contentType || '(missing)'}`);
    }
    const buffer = await readLimitedBody(response, maxBytes);
    return {
      url: currentUrl,
      contentType,
      buffer,
    };
  }

  throw new Error('Remote request failed');
}

module.exports = {
  assertPublicHttpUrl,
  isPublicAddress,
  safeRemoteFetch,
};
