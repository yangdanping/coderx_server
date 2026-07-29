const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(__dirname, '../../migrations/009_add_profile_nickname.sql');

function loadMigration() {
  assert.equal(fs.existsSync(migrationPath), true, 'Expected profile nickname migration to exist');
  return fs.readFileSync(migrationPath, 'utf8');
}

test('profile nickname migration: adds nullable text with a named integrity constraint', () => {
  const sql = loadMigration();

  assert.match(sql, /(?:^|\n)\s*BEGIN\s*;/i);
  assert.match(sql, /ALTER\s+TABLE\s+profile[\s\S]*ADD\s+COLUMN\s+nickname\s+TEXT\b/i);
  assert.match(sql, /CONSTRAINT\s+profile_nickname_check\s+CHECK/i);
  assert.match(sql, /nickname\s+IS\s+NULL/i);
  assert.match(sql, /nickname\s*=\s*btrim\s*\(\s*nickname\s*\)/i);
  assert.match(sql, /length\s*\(\s*nickname\s*\)\s+BETWEEN\s+1\s+AND\s+30/i);
  assert.match(sql, /nickname\s*!~\s*'\[\[:cntrl:\]\]'/i);
  assert.match(sql, /position\s*\(\s*U&'[\\]2028'\s+in\s+nickname\s*\)\s*=\s*0/i);
  assert.match(sql, /position\s*\(\s*U&'[\\]2029'\s+in\s+nickname\s*\)\s*=\s*0/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
});

test('profile nickname migration: keeps nicknames optional and shareable without an index', () => {
  const sql = loadMigration();

  assert.doesNotMatch(sql, /nickname\s+TEXT\s+NOT\s+NULL/i);
  assert.doesNotMatch(sql, /\bUNIQUE\b/i);
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
});
