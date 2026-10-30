import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

for (const variant of ['bundle', 'dynamic']) {
  test(`${variant}: missing session-query APIs are reported during activation`, async () => {
    for (const sessionQuery of [{ listSessions() {} }, { readSession() {} }]) {
      await assert.rejects(createHarness(variant, { services: { sessionQuery } }),
        /Harness requires sessionQuery.listSessions and sessionQuery.readSession/);
    }
  });
}
