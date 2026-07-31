const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

function normalizeKey(key) {
  if (typeof key !== 'string' || !key || path.isAbsolute(key) || key.includes('\\')) {
    throw new TypeError('media key must be a non-absolute path inside the configured root');
  }

  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('media key must not escape the configured root');
  }
  return segments.join('/');
}

function encodeKey(key) {
  return normalizeKey(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

class LocalMediaStore {
  constructor({ rootPath, publicBaseUrl }) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
      throw new TypeError('rootPath is required');
    }
    this.rootPath = path.resolve(rootPath);
    this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/+$/, '');
  }

  resolveKey(key) {
    const normalizedKey = normalizeKey(key);
    const resolvedPath = path.resolve(this.rootPath, ...normalizedKey.split('/'));
    if (!resolvedPath.startsWith(`${this.rootPath}${path.sep}`)) {
      throw new TypeError('media key escapes the configured root');
    }
    return { normalizedKey, resolvedPath };
  }

  async ensureSafeParent(normalizedKey, { create }) {
    await fsPromises.mkdir(this.rootPath, { recursive: true });
    let currentPath = this.rootPath;
    const parentSegments = normalizedKey.split('/').slice(0, -1);

    for (const segment of parentSegments) {
      currentPath = path.join(currentPath, segment);
      if (create) {
        await fsPromises.mkdir(currentPath).catch((error) => {
          if (error?.code !== 'EEXIST') throw error;
        });
      }

      let stats;
      try {
        stats = await fsPromises.lstat(currentPath);
      } catch (error) {
        if (!create && error?.code === 'ENOENT') return false;
        throw error;
      }

      if (stats.isSymbolicLink()) {
        throw new Error(`Local media key crosses a symbolic link outside the configured root: ${normalizedKey}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Local media key parent is not a directory: ${normalizedKey}`);
      }
    }
    return true;
  }

  async put({ key, body, sizeBytes, sha256 }) {
    const { normalizedKey, resolvedPath } = this.resolveKey(key);
    await this.ensureSafeParent(normalizedKey, { create: true });
    const existing = await this.head(normalizedKey);
    if (existing) {
      if (existing.sizeBytes === sizeBytes && existing.sha256 === sha256) {
        return existing;
      }
      throw new Error(`Local media object conflict for key "${normalizedKey}"; existing content will not be overwritten`);
    }

    const temporaryPath = `${resolvedPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

    try {
      if (body && typeof body.pipe === 'function') {
        await pipeline(body, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
      } else {
        await fsPromises.writeFile(temporaryPath, body, { flag: 'wx' });
      }

      const stats = await fsPromises.stat(temporaryPath);
      const actualSha256 = await sha256File(temporaryPath);
      if (stats.size !== sizeBytes || actualSha256 !== sha256) {
        throw new Error(`Local media object verification failed for "${normalizedKey}": expected ${sizeBytes}/${sha256}, got ${stats.size}/${actualSha256}`);
      }

      await fsPromises.rename(temporaryPath, resolvedPath);
      return {
        key: normalizedKey,
        sizeBytes: stats.size,
        sha256: actualSha256,
        etag: null,
      };
    } finally {
      await fsPromises.rm(temporaryPath, { force: true });
    }
  }

  async head(key) {
    const { normalizedKey, resolvedPath } = this.resolveKey(key);
    const parentExists = await this.ensureSafeParent(normalizedKey, { create: false });
    if (!parentExists) return null;
    try {
      const stats = await fsPromises.lstat(resolvedPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Local media key resolves to a symbolic link: ${normalizedKey}`);
      }
      if (!stats.isFile()) return null;
      return {
        key: normalizedKey,
        sizeBytes: stats.size,
        sha256: await sha256File(resolvedPath),
        etag: null,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key) {
    const { normalizedKey, resolvedPath } = this.resolveKey(key);
    const parentExists = await this.ensureSafeParent(normalizedKey, { create: false });
    if (!parentExists) return;
    await fsPromises.rm(resolvedPath, { force: true });
  }

  publicUrl(key) {
    const encodedKey = encodeKey(key);
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${encodedKey}` : `/${encodedKey}`;
  }
}

function createLocalMediaStore(options) {
  return new LocalMediaStore(options);
}

module.exports = {
  LocalMediaStore,
  createLocalMediaStore,
};
