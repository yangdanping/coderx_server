import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type FixtureRow = [method: string, path: string, response: unknown];

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/http-response-contracts.json', import.meta.url), 'utf8')) as Record<string, FixtureRow[]>;

/** The recorded responses come from the Koa fixtures before they were removed. */
export function frozenHttpContract(name: string) {
  const responses = fixtures[name];
  assert.ok(responses, `Missing frozen HTTP contract: ${name}`);
  let index = 0;
  return {
    assert(method: string, path: string, actual: unknown) {
      const row = responses[index++];
      assert.ok(row, `Missing frozen response for ${method} ${path}`);
      const [expectedMethod, expectedPath, expected] = row;
      const label = `${method} ${path}`;
      assert.deepEqual([method, path], [expectedMethod, expectedPath], label);
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label);
    },
    assertComplete() {
      assert.equal(index, responses.length, `Every frozen response in ${name} should be verified`);
    },
  };
}
