const path = require('node:path');
const dotenv = require('dotenv');

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIdList(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const ids = text.split(',').map((item) => Number(item.trim()));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('INGEST_AUTHOR_IDS must contain positive integers');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('INGEST_AUTHOR_IDS must not contain duplicate IDs');
  }
  return ids;
}

function loadRuntimeEnvironment({ cwd = process.cwd(), nodeEnv = process.env.NODE_ENV } = {}) {
  const envFile = nodeEnv === 'production' ? '.env.production' : '.env.development';
  dotenv.config({
    path: path.resolve(cwd, envFile),
    quiet: true,
  });
  return envFile;
}

function loadRuntimeConfig(env = process.env) {
  const ollamaHost = env.OLLAMA_HOST || '127.0.0.1';
  const ollamaPort = env.OLLAMA_PORT || '11434';
  const database = Object.freeze({
    DATABASE_URL: env.DATABASE_URL,
    PGHOST: env.PGHOST,
    PGPORT: env.PGPORT,
    PGDATABASE: env.PGDATABASE,
    PGUSER: env.PGUSER,
    PGPASSWORD: env.PGPASSWORD,
  });
  const appHost = String(env.APP_HOST || '127.0.0.1').replace(/\/+$/, '');
  const appPort = String(env.APP_PORT || '8000');
  const normalizedAppHost = /^https?:\/\//i.test(appHost) ? appHost : `http://${appHost}`;

  return Object.freeze({
    enabled: parseBoolean(env.INGEST_ENABLED),
    autoPublish: parseBoolean(env.INGEST_AUTO_PUBLISH),
    schedule: env.INGEST_CRON || '15 7 * * *',
    timezone: env.INGEST_TIMEZONE || 'Asia/Shanghai',
    days: parsePositiveInteger(env.INGEST_DAYS, 30),
    limit: parsePositiveInteger(env.INGEST_DAILY_LIMIT, 10),
    timeoutMs: parsePositiveInteger(env.INGEST_HTTP_TIMEOUT_MS, 15_000),
    authorName: String(env.INGEST_AUTHOR_NAME || '').trim(),
    authorIds: parseIdList(env.INGEST_AUTHOR_IDS),
    tagName: String(env.INGEST_TAG_NAME || '人工智能').trim(),
    publicBaseURL:
      String(env.PUBLIC_API_ORIGIN || '')
        .trim()
        .replace(/\/+$/, '') || `${normalizedAppHost}:${appPort}`,
    ollamaBaseURL: String(env.INGEST_OLLAMA_BASE_URL || '').trim() || `http://${ollamaHost}:${ollamaPort}/v1`,
    ollamaModel: String(env.INGEST_OLLAMA_MODEL || 'qwen2.5:7b').trim(),
    database,
  });
}

module.exports = {
  loadRuntimeConfig,
  loadRuntimeEnvironment,
  parseIdList,
};
