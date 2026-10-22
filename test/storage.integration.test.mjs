import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { createHarness, event, session, variants } from './helpers.mjs'

const unitDescriptor = { name: 'token_stats', version: 1, tables: [], hasGlobal: true }

// Same upstream revision and source loader as auth.integration.test.mjs. The
// actual JSON backend writes real files; the dashboard runs without any fs
// service, as in the current Desktop assembly.
describe('Snapshots through the real Harness JSON storage backend', {
  skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to a Harness source checkout (Node.js 24+).',
}, () => {
  let upstream
  before(async () => {
    const { loadHarnessSource } = await import('./harness-source-loader.mjs')
    upstream = await loadHarnessSource(process.env.DSH_SOURCE)
  })
  after(() => upstream?.disposeLoader())

  const cleanup = new WeakMap()
  async function tempRoot(t, prefix) {
    const root = await mkdtemp(join(tmpdir(), prefix))
    const callbacks = []
    cleanup.set(t, callbacks)
    t.after(async () => {
      try {
        for (const dispose of callbacks.reverse()) await dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    return root
  }

  async function mountedStorage(t, home) {
    const ctx = new upstream.Context()
    cleanup.get(t).push(() => ctx.fiber.dispose())
    await ctx.plugin(upstream.Storage).await()
    const root = join(home, 'storages')
    await ctx.plugin({ inject: upstream.storageJson.inject, apply: upstream.storageJson.apply }, { root }).await()
    const storage = ctx.get('storage')
    return { ctx, storage, backend: storage.backend.get('json'), root,
      async snapshot() { return JSON.parse(await readFile(join(root, 'token_stats.json'), 'utf8')).global } }
  }

  async function ready(harness) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await harness.stats()
      if (value.ready && !value.scanning) return value
      await delay(10)
    }
    throw new Error('The dashboard did not finish starting against real JSON storage')
  }

  async function dashboard(t, variant, medium, options = {}) {
    const instance = await createHarness(variant, {
      fs: undefined,
      profileContext: undefined,
      ...options,
      services: { storage: medium.storage, 'storage.backend.json': medium.backend },
    })
    let disposed
    const dispose = instance.dispose
    instance.dispose = () => disposed ??= dispose()
    cleanup.get(t).push(() => instance.dispose())
    return instance
  }

  for (const variant of variants) {
    it(`${variant}: persists without fs and restores deleted-session history after a process-style restart`, async t => {
      const home = await tempRoot(t, 'token-stats-storage-')
      const firstMedium = await mountedStorage(t, home)
      const first = await dashboard(t, variant, firstMedium, { sessions: new Map([['one', session()]]) })
      assert.equal((await ready(first)).totalTokens, 150)
      assert.equal(first.fs, undefined)
      await first.flush()
      assert.equal((await firstMedium.snapshot()).totalTokens, 150)
      await first.dispose()
      await firstMedium.ctx.fiber.dispose()

      // Use an entirely new hub/backend and no source logs. This cannot pass by
      // recomputing the sample session or retaining the old backend's memory.
      const secondMedium = await mountedStorage(t, home)
      const second = await dashboard(t, variant, secondMedium)
      const restored = await ready(second)
      assert.equal(restored.totalTokens, 150)
      assert.equal(restored.totalRequests, 1)
      assert.equal(restored.totalSessions, 1)
      assert.deepEqual(second.reads.full, [])
      await second.dispose()
    })

    it(`${variant}: keeps two configured storage roots independent`, async t => {
      const temp = await tempRoot(t, 'token-stats-isolation-')
      const a = await mountedStorage(t, join(temp, 'dsh-home-a'))
      const b = await mountedStorage(t, join(temp, 'dsh-home-b'))
      const first = await dashboard(t, variant, a, { sessions: new Map([['one', session('one', 150)]]) })
      const second = await dashboard(t, variant, b, { sessions: new Map([['one', session('one', 350)]]) })
      await ready(first)
      await ready(second)
      await first.flush()
      await second.flush()
      assert.equal((await a.snapshot()).totalTokens, 150)
      assert.equal((await b.snapshot()).totalTokens, 350)

      first.emit('session/event', { id: 'one' }, event(4, 'assistant/message', { usage: { outputTokens: 25 } }))
      await first.dispose()
      assert.equal((await a.snapshot()).totalTokens, 175)
      assert.equal((await b.snapshot()).totalTokens, 350)
      assert.equal((await second.stats()).totalTokens, 350)
      await second.dispose()
    })

    it(`${variant}: disposal flushes the final event and releases the unit for reopening`, async t => {
      const home = await tempRoot(t, 'token-stats-close-')
      const medium = await mountedStorage(t, home)
      const first = await dashboard(t, variant, medium, { sessions: new Map([['one', session()]]) })
      await ready(first)
      await assert.rejects(medium.backend.kv.open(unitDescriptor), /already open/)
      // Deliberately skip the periodic flush: plugin disposal must await this
      // write before close releases the backend's exclusive unit handle.
      first.emit('session/event', { id: 'one' }, event(4, 'assistant/message', { usage: { outputTokens: 25 } }))
      await first.dispose()
      assert.equal((await medium.snapshot()).totalTokens, 175)
      const reopened = await medium.backend.kv.open(unitDescriptor)
      assert.equal((await reopened.loadAll()).global.totalTokens, 175)
      await reopened.close()

      const second = await dashboard(t, variant, medium)
      assert.equal((await ready(second)).totalTokens, 175)
      await second.dispose()
    })
  }
})
