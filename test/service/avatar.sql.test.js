const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/avatar.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected avatar.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddAvatarSql: pg appends RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddAvatarSql } = loadHelper();

  assert.equal(
    buildAddAvatarSql('mysql'),
    'INSERT INTO avatar (user_id,filename, mimetype, size) VALUES (?,?,?,?)'
  );
  assert.match(
    buildAddAvatarSql('pg'),
    /INSERT INTO avatar \(user_id,filename, mimetype, size\) VALUES \(\?,\?,\?,\?\) RETURNING id;$/i
  );
});
