// Real startup tests may read only explicitly selected temporary env/key files.
// This guard must be preloaded in every subprocess as well as its test runner.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const net = require('node:net');
const tempRoot = path.resolve(require('node:os').tmpdir());
const envExample = path.resolve(__dirname, '../../.env.example');

function checkRead(file) {
  if (typeof file === 'number') return;
  const resolved = path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
  if (resolved === envExample) return;
  const configured = ['APP_ENV_FILE', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH'].some((name) => process.env[name] && path.resolve(process.env[name]) === resolved);
  const sensitive = configured || /^\.env(?:\.|$)/.test(path.basename(resolved)) || /\.(?:key|pem)$/.test(resolved) || /[/\\]app[/\\]keys[/\\]/.test(resolved);
  if (!sensitive) return;
  const root = process.env.CODERX_TEST_RESOURCE_ROOT;
  if (!root || !path.resolve(root).startsWith(tempRoot + path.sep) || !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Test guard blocked an env/key read outside temporary resources');
  }
}

const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  checkRead(file);
  return readFileSync.call(this, file, ...args);
};
const readFile = fs.readFile;
fs.readFile = function (file, ...args) {
  checkRead(file);
  return readFile.call(this, file, ...args);
};
const promisesReadFile = fs.promises.readFile;
fs.promises.readFile = function (file, ...args) {
  checkRead(file);
  return promisesReadFile.call(this, file, ...args);
};

const ports = new Set();
/** @param {number} port */
function allowLoopbackPort(port) {
  ports.add(port);
  return () => ports.delete(port);
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const port = typeof args[0] === 'object' ? args[0]?.port : args[0];
  if (port !== 0) throw new Error('Test guard permits only ephemeral listeners');
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object') {
      const revoke = allowLoopbackPort(address.port);
      this.once('close', revoke);
    }
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [options] = Array.isArray(args[0]) ? args[0] : args;
  if (options?.path || !['127.0.0.1', '::1'].includes(options?.host) || !ports.has(Number(options?.port))) {
    throw new Error('Test guard blocked an external connection');
  }
  return connect.apply(this, args);
};

module.exports = { allowLoopbackPort };
require('node:module').syncBuiltinESMExports();
