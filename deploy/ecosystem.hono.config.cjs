const { statSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');

function requiredPath(name, type) {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || !statSync(value, { throwIfNoEntry: false })?.[type]()) {
    throw new Error(`${name} must point to an existing absolute ${type === 'isFile' ? 'file' : 'directory'}`);
  }
  return value;
}

function integer(value, name, max) {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return Number(value);
}

const cwd = requiredPath('CODERX_HONO_RELEASE_DIR', 'isDirectory');
const envFile = requiredPath('APP_ENV_FILE', 'isFile');
const port = integer(process.env.APP_PORT, 'APP_PORT', 65535);
const entry = join(cwd, 'dist/main.js');
if (!statSync(entry, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('Release must contain dist/main.js');
}
const logRoot = join(cwd, 'logs');
const shutdownMs = integer(process.env.SHUTDOWN_TIMEOUT_MS ?? '10000', 'SHUTDOWN_TIMEOUT_MS', 2147483647 - 5000);

module.exports = {
  apps: [
    {
      name: 'coderx_hono_candidate',
      cwd,
      // PM2's Node wrapper imports ESM. Invoke Node directly so import.meta.main is true.
      script: process.execPath,
      interpreter: 'none',
      args: ['--enable-source-maps', entry],
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      restart_delay: 1000,
      wait_ready: false,
      listen_timeout: 10000,
      kill_timeout: shutdownMs + 5000,
      out_file: join(logRoot, 'pm2-out.log'),
      error_file: join(logRoot, 'pm2-error.log'),
      env: {
        NODE_ENV: 'production',
        APP_ENV_FILE: envFile,
        APP_HOST: '127.0.0.1',
        APP_PORT: String(port),
        BACKGROUND_JOBS_ENABLED: 'false',
        LOG_ROOT: logRoot,
        SHUTDOWN_TIMEOUT_MS: String(shutdownMs),
      },
    },
  ],
};
