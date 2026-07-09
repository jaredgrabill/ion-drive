/**
 * Block-local smoke test — exercises the spec-06 env contract: `ion-drive
 * block test` runs this under `tsx --test` with ION_TEST_SERVER_URL and
 * ION_TEST_API_KEY pointing at the live (ephemeral or --server) instance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const base = process.env.ION_TEST_SERVER_URL ?? '';
const apiKey = process.env.ION_TEST_API_KEY ?? '';

test('the test server is healthy', async () => {
  assert.ok(base, 'ION_TEST_SERVER_URL must be set by block test');
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test('seeded items are readable through the data API', async () => {
  const res = await fetch(`${base}/api/v1/data/testable_items`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[] };
  assert.ok(body.data.length >= 2, `expected the 2 seeded rows, got ${body.data.length}`);
});
