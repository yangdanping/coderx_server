const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(__dirname, '../../migrations/008_create_content_ingest_pipeline.sql');

test('content ingest migration defines durable sources, runs, candidates and article attribution', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE TABLE ingest_source/i);
  assert.match(sql, /CREATE TABLE ingest_run/i);
  assert.match(sql, /CREATE TABLE ingest_candidate/i);
  assert.match(sql, /CREATE TABLE article_source/i);
  assert.match(sql, /canonical_url\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /source_published_at\s+TIMESTAMPTZ/i);
  assert.match(sql, /content\s+JSONB/i);
});

test('content ingest migration constrains lifecycle values and JSON object payloads', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CHECK\s*\(status IN \('pending', 'enriched', 'approved', 'rejected', 'published', 'failed'\)\)/i);
  assert.match(sql, /CHECK\s*\(content_mode IN \('summary', 'full'\)\)/i);
  assert.match(sql, /CHECK\s*\(jsonb_typeof\(raw_payload\) = 'object'\)/i);
  assert.match(sql, /CHECK\s*\(content IS NULL OR jsonb_typeof\(content\) = 'object'\)/i);
});

test('content ingest migration creates idempotency and access-path indexes', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /source_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /CREATE UNIQUE INDEX ingest_candidate_source_external_id_uidx/i);
  assert.match(sql, /WHERE external_id IS NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX ingest_candidate_content_hash_uidx/i);
  assert.match(sql, /WHERE content_hash IS NOT NULL/i);
  assert.match(sql, /CREATE INDEX ingest_candidate_review_idx\s+ON ingest_candidate\s*\(status, score DESC, source_published_at DESC\)/i);
  assert.match(sql, /CREATE INDEX ingest_candidate_source_id_idx\s+ON ingest_candidate\s*\(source_id\)/i);
  assert.match(sql, /CREATE INDEX article_source_source_id_idx\s+ON article_source\s*\(source_id\)/i);
});
