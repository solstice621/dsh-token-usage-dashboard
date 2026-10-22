import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, deferred, memoryFs, memoryStorage, session, until, variants } from './helpers.mjs'

for (const variant of variants) {
  test(`${variant}: host storage persists without a workspace FS or profile globals`, async t => {
    const storage = memoryStorage()
    const first = await createHarness(variant, {
      storage, fs: undefined, profileContext: undefined,
      sessions: new Map([['one', session()]]),
    })
    await first.waitReady()
    await first.dispose()
    assert.equal(storage.calls.opens.length, 1)
    assert.equal(storage.calls.closes, 1)
    assert.equal(storage.calls.writes, 1)
    assert.equal([...storage.units.values()][0].totalTokens, 150)
    assert.equal(first.logs.some(line => line.join(' ').includes('persistence disabled')), false)
    const restored = await createHarness(variant, { storage, fs: undefined, profileContext: undefined })
    t.after(() => restored.dispose())
    assert.equal((await restored.waitReady()).totalTokens, 150)
    assert.deepEqual(restored.reads.full, [])
  })

  test(`${variant}: native backends own separate roots regardless of embedded path hints`, async t => {
    const units = new Map()
    const storageA = memoryStorage('/homes/a/storages', units)
    const storageB = memoryStorage('/homes/b/storages', units)
    const first = await createHarness(variant, { storage: storageA, fs: undefined, sessions: new Map([['one', session()]]) })
    await first.waitReady()
    await first.dispose()
    const second = await createHarness(variant, { storage: storageB, fs: undefined, config: { dshHome: '/homes/a' } })
    t.after(() => second.dispose())
    assert.equal((await second.waitReady()).totalTokens, 0)
    await second.flush()
    assert.equal(units.get('/homes/a/storages/token_stats.json').totalTokens, 150)
    assert.equal(units.get('/homes/b/storages/token_stats.json').totalTokens, 0)
  })

  test(`${variant}: native empty storage migrates the legacy snapshot without writing the old file`, async t => {
    const fs = memoryFs()
    const legacy = await createHarness(variant, { fs, sessions: new Map([['one', session()]]) })
    await legacy.waitReady()
    await legacy.dispose()
    const before = [...fs.files]
    fs.writeText = () => { throw new Error('Legacy snapshot must be read-only with native storage') }
    const storage = memoryStorage()
    const h = await createHarness(variant, { fs, storage })
    t.after(() => h.dispose())
    assert.equal((await h.waitReady()).totalTokens, 150)
    await h.flush()
    assert.deepEqual([...fs.files], before)
    assert.equal([...storage.units.values()][0].totalTokens, 150)
  })

  test(`${variant}: an existing native snapshot never reads the legacy path`, async t => {
    const storage = memoryStorage()
    const first = await createHarness(variant, { storage, fs: undefined, sessions: new Map([['one', session()]]) })
    await first.waitReady()
    await first.dispose()
    let legacyReads = 0
    const fs = memoryFs()
    fs.readText = async () => { legacyReads += 1; throw new Error('legacy must not be read') }
    const h = await createHarness(variant, { storage, fs })
    t.after(() => h.dispose())
    assert.equal((await h.waitReady()).totalTokens, 150)
    assert.equal(legacyReads, 0)
  })

  test(`${variant}: native open is shared and teardown waits before closing the unit`, async () => {
    const storage = memoryStorage()
    const gate = deferred()
    const entered = deferred()
    const original = storage.json.kv.open
    let opens = 0
    storage.json.kv.open = async descriptor => {
      opens += 1
      entered.resolve()
      await gate.promise
      return original(descriptor)
    }
    const h = await createHarness(variant, { storage, fs: undefined })
    await entered.promise
    let disposed = false
    const disposal = h.dispose().then(() => { disposed = true })
    assert.equal(disposed, false)
    gate.resolve()
    await disposal
    assert.equal(opens, 1)
    assert.equal(storage.calls.closes, 1)
  })

  test(`${variant}: teardown drains native writes before releasing the unit`, async () => {
    const storage = memoryStorage()
    const gate = deferred()
    const original = storage.json.kv.open
    let entered = false
    storage.json.kv.open = async descriptor => {
      const unit = await original(descriptor)
      const write = unit.setGlobal
      unit.setGlobal = async value => { entered = true; await gate.promise; return write(value) }
      return unit
    }
    const h = await createHarness(variant, { storage, fs: undefined, sessions: new Map([['one', session()]]) })
    await h.waitReady()
    const save = h.flush()
    await until(() => entered)
    const disposal = h.dispose()
    assert.equal(storage.calls.closes, 0)
    gate.resolve()
    await Promise.all([save, disposal])
    assert.equal([...storage.units.values()][0].totalTokens, 150)
    assert.equal(storage.calls.closes, 1)
  })

  test(`${variant}: failed native writes retry on the next flush without workspace fallback`, async t => {
    const storage = memoryStorage()
    const fs = memoryFs()
    let legacyWrites = 0
    fs.writeText = async () => { legacyWrites += 1 }
    const original = storage.json.kv.open
    let fail = true
    storage.json.kv.open = async descriptor => {
      const unit = await original(descriptor)
      const write = unit.setGlobal
      unit.setGlobal = async value => { if (fail) throw new Error('native write failed'); return write(value) }
      return unit
    }
    const h = await createHarness(variant, { storage, fs, sessions: new Map([['one', session()]]) })
    t.after(() => h.dispose())
    await h.waitReady()
    await h.flush()
    assert.equal(storage.units.size, 0)
    fail = false
    await h.flush()
    assert.equal([...storage.units.values()][0].totalTokens, 150)
    assert.equal(legacyWrites, 0)
    assert.equal(storage.calls.opens.length, 1)
  })
}
