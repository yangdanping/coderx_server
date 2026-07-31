const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(__dirname, '../../migrations/010_create_media_object.sql');

function loadMigration() {
  assert.equal(fs.existsSync(migrationPath), true, 'Expected media object migration to exist');
  return fs.readFileSync(migrationPath, 'utf8');
}

test('media object migration: defines the physical media-object contract', () => {
  const sql = loadMigration();

  assert.match(sql, /(?:^|\n)\s*BEGIN\s*;/i);
  assert.match(sql, /CREATE\s+TABLE\s+media_object\b/i);
  assert.match(sql, /id\s+BIGINT\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i);
  assert.match(sql, /file_id\s+BIGINT\s+NOT\s+NULL\s+REFERENCES\s+file\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i);
  assert.match(sql, /provider\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*provider\s+IN\s*\(\s*'local'\s*,\s*'r2'\s*\)\s*\)/i);
  assert.match(sql, /variant\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*variant\s+IN\s*\(\s*'original'\s*,\s*'small'\s*,\s*'video'\s*,\s*'poster'\s*\)\s*\)/i);
  assert.match(sql, /object_key\s+TEXT/i);
  assert.match(sql, /local_path\s+TEXT/i);
  assert.match(sql, /size_bytes\s+BIGINT\s+NOT\s+NULL\s+CHECK\s*\(\s*size_bytes\s*>=\s*0\s*\)/i);
  assert.match(sql, /sha256\s+CHAR\s*\(\s*64\s*\)\s+NOT\s+NULL\s+CHECK\s*\(\s*sha256\s*~\s*'\^\[0-9a-f\]\{64\}\$'\s*\)/i);
  assert.match(sql, /status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'pending'\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'ready'\s*,\s*'deleting'\s*,\s*'failed'\s*\)\s*\)/i);
  assert.match(sql, /last_error\s+TEXT/i);
  assert.match(sql, /verified_at\s+TIMESTAMPTZ/i);
  assert.match(sql, /created_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+clock_timestamp\s*\(\s*\)/i);
  assert.match(sql, /updated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+clock_timestamp\s*\(\s*\)/i);
  assert.match(sql, /CONSTRAINT\s+media_object_location_check\s+CHECK\s*\([\s\S]*provider\s*=\s*'local'[\s\S]*local_path\s+IS\s+NOT\s+NULL[\s\S]*object_key\s+IS\s+NULL[\s\S]*provider\s*=\s*'r2'[\s\S]*object_key\s+IS\s+NOT\s+NULL[\s\S]*local_path\s+IS\s+NULL[\s\S]*\)/i);
  assert.match(sql, /CONSTRAINT\s+media_object_file_provider_variant_uidx\s+UNIQUE\s*\(\s*file_id\s*,\s*provider\s*,\s*variant\s*\)/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
});

test('media object migration: indexes provider locations and operational lookup paths', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+media_object_r2_key_uidx\s+ON\s+media_object\s*\(\s*object_key\s*\)\s+WHERE\s+provider\s*=\s*'r2'/i);
  assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+media_object_local_path_uidx\s+ON\s+media_object\s*\(\s*local_path\s*\)\s+WHERE\s+provider\s*=\s*'local'/i);
  assert.match(sql, /CREATE\s+INDEX\s+media_object_file_id_idx\s+ON\s+media_object\s*\(\s*file_id\s*\)/i);
  assert.match(sql, /CREATE\s+INDEX\s+media_object_provider_status_idx\s+ON\s+media_object\s*\(\s*provider\s*,\s*status\s*\)/i);
  assert.match(sql, /COMMENT\s+ON\s+TABLE\s+media_object\s+IS/i);
});
