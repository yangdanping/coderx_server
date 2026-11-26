import { observeImports } from '../support/observe-imports.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('factory import and creation do not load runtime services', () => {
  const script = `
    ${observeImports}
    import net from 'node:net';
    net.Server.prototype.listen = () => { throw new Error('Factory started a listener'); };
    const { createHttpApp } = await import('./src/http/app.js');
    createHttpApp({buildId:'test', checkReady:async()=>false, registerRoutes() {}});
    const root = resolve('src') + '/';
    if ([...loaded].some(p => ['service', 'controller', 'tasks', 'ingest', 'storage'].some(part => p.startsWith(root + part + '/')))) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), '--import=tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});
