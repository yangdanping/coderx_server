import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAddAvatarSql } from '../../src/service/sql/avatar.sql.js';

test('buildAddAvatarSql: appends RETURNING id', () => {
  assert.match(
    buildAddAvatarSql(),
    /INSERT INTO avatar \(user_id,filename, mimetype, size\) VALUES \(\?,\?,\?,\?\) RETURNING id;$/i
  );
});
