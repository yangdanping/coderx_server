const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJsonPath = path.resolve(__dirname, '../../package.json');

test('package.json exposes a migration regression script that runs phase2, stage3, hotspots, and phase5 in order', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:regression'];

  assert.equal(typeof script, 'string');

  const phase2Index = script.indexOf('pnpm run test:migration:phase2');
  const stage3Index = script.indexOf('pnpm run test:database:stage3');
  const hotspotsIndex = script.indexOf('pnpm run test:migration:hotspots');
  const phase5Index = script.indexOf('pnpm run test:migration:phase5');

  assert.notEqual(phase2Index, -1);
  assert.notEqual(stage3Index, -1);
  assert.notEqual(hotspotsIndex, -1);
  assert.notEqual(phase5Index, -1);
  assert.equal(phase2Index < stage3Index, true);
  assert.equal(stage3Index < hotspotsIndex, true);
  assert.equal(hotspotsIndex < phase5Index, true);
});

test('package.json exposes a hotspots script that includes controller regression tests', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:hotspots'];

  assert.equal(typeof script, 'string');
  assert.match(script, /^node --test\b/);
  assert.match(script, /test\/service\/\*\.test\.js/);
  assert.match(script, /test\/tasks\/\*\.test\.js/);
  assert.match(script, /test\/controller\/\*\.test\.js/);
});

test('package.json exposes phase5 tests for article read, history, and comment parity', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:phase5'];

  assert.equal(typeof script, 'string');
  assert.match(script, /article-read-parity\.test\.js/);
  assert.match(script, /history-parity\.test\.js/);
  assert.match(script, /comment-read-parity\.test\.js/);
});

test('package.json exposes a dedicated phase5 history parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:history'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-history-parity.js');
});

test('package.json exposes a dedicated phase5 comment read parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:comment-read'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-comment-read-parity.js');
});

test('package.json exposes a dedicated phase5 comment write parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:comment-write'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-comment-write-parity.js');
});

test('package.json phase5 tests include comment write parity', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:phase5'];

  assert.equal(typeof script, 'string');
  assert.match(script, /comment-write-parity\.test\.js/);
});

test('package.json exposes a dedicated phase5 collect parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:collect'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-collect-parity.js');
});

test('package.json phase5 tests include collect parity', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:phase5'];

  assert.equal(typeof script, 'string');
  assert.match(script, /collect-parity\.test\.js/);
});

test('package.json exposes a dedicated phase5 user-auth parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:user-auth'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-user-auth-parity.js');
});

test('package.json phase5 tests include user-auth parity', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:phase5'];

  assert.equal(typeof script, 'string');
  assert.match(script, /user-auth-parity\.test\.js/);
});

test('package.json exposes a dedicated phase5 file-meta parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:file-meta'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-file-meta-parity.js');
});

test('package.json exposes a dedicated phase5 clean-orphan parity CLI script', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['migration:phase5:clean-orphan'];

  assert.equal(typeof script, 'string');
  assert.equal(script, 'node scripts/migration/verify-clean-orphan-parity.js');
});

test('package.json phase5 tests include file-meta and clean-orphan parity', () => {
  assert.equal(fs.existsSync(packageJsonPath), true, 'Expected package.json to exist');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const script = packageJson.scripts['test:migration:phase5'];

  assert.equal(typeof script, 'string');
  assert.match(script, /file-meta-parity\.test\.js/);
  assert.match(script, /clean-orphan-parity\.test\.js/);
});
