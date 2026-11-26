import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('importing the source and compiled key utility does not generate keys or write files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coderx-keys-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const guard = fileURLToPath(new URL('../support/runtime-guard.cjs', import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import crypto from 'node:crypto';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    crypto.generateKeyPairSync = () => assert.fail('import generated a key');
    fs.writeFileSync = () => assert.fail('import wrote a file');
    syncBuiltinESMExports();
    const { generateJwtKeys } = await import(pathToFileURL(process.argv[1]).href);
    assert.equal(typeof generateJwtKeys, 'function');
  `;

  for (const [file, preload] of [
    ['src/app/keys/generate-keys.ts', ['--import=tsx']],
    ['dist/app/keys/generate-keys.js', []],
  ] as const) {
    const entry = join(root, file.endsWith('.ts') ? 'generate-keys.ts' : 'generate-keys.js');
    await copyFile(new URL(`../../${file}`, import.meta.url), entry);
    const result = spawnSync(process.execPath, ['--require', guard, ...preload, '--input-type=module', '-e', script, entry], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), CODERX_TEST_RESOURCE_ROOT: root, APP_ENV_FILE: join(root, 'absent.env') },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual((await readdir(root)).sort(), ['generate-keys.js', 'generate-keys.ts', 'package.json']);
});
