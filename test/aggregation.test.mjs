import assert from 'node:assert/strict'
import test from 'node:test'
import { baseTime, createHarness, deferred, event, memoryFs, session, until, variants } from './helpers.mjs'

function suffix(from = 4) {
  return [
    event(from, 'request/header', { header: { config: { provider: 'deepseek', model: 'reasoner' } } }),
    event(from + 1, 'turn/start', { turn: 2 }),
    event(from + 2, 'assistant/message', { usage: { inputTokens: 30, outputTokens: 20 } }),
    event(from + 3, 'turn/end', { turn: 2 }),
  ]
}

function assert150(stats) {
  assert.equal(stats.totalTokens, 150)
  assert.equal(stats.totalRequests, 1)
  assert.equal(stats.totalInput, 100)
  assert.equal(stats.totalOutput, 40)
  assert.equal(stats.totalCacheRead, 7)
  assert.equal(stats.totalTurns, 1)
  assert.equal(stats.totalChatMs, 2000)
  assert.equal(stats.longestTurnMs, 2000)
  assert.equal(stats.longestChatMs, 2000)
  assert.equal(stats.peakStepTokens, 150)
  assert.equal(stats.totalSessions, 1)
  assert.equal(stats.days.length, 1)
  assert.equal(stats.days[0].cacheWrite, 3)
  assert.deepEqual(stats.models, [{ key: 'deepseek/chat', tokens: 150, requests: 1 }])
}

function assert200(stats) {
  assert.equal(stats.totalTokens, 200)
  assert.equal(stats.totalRequests, 2)
  assert.equal(stats.totalTurns, 2)
  assert.equal(stats.totalChatMs, 4000)
  assert.deepEqual(stats.models, [
    { key: 'deepseek/chat', tokens: 150, requests: 1 },
    { key: 'deepseek/reasoner', tokens: 50, requests: 1 },
  ])
}

for (const variant of variants) {
  test(`${variant}: repeated rescan stays at 150 tokens and preserves every aggregate`, async t => {
    const row = session()
    const h = await createHarness(variant, { sessions: new Map([['one', row]]) })
    t.after(() => h.dispose())
    const original = await h.waitReady()
    assert150(original)
    assert.deepEqual(await h.rescan(), original)
    assert.deepEqual(await h.rescan(), original)
    // Duplicate live deliveries are also harmless after a rebuild.
    for (const ev of row.events) h.emit('session/event', row.header, ev)
    assert.deepEqual(await h.stats(), original)
  })

  test(`${variant}: rescan clears deleted sessions, model/day peaks and open turns`, async t => {
    const row = session()
    const old = session('old', 400, 'old-model')
    for (const ev of old.events) ev.time -= 2 * 86400000
    old.events[3].time += 20000
    old.events.push(event(4, 'turn/start', { turn: 99 }))
    const sessions = new Map([['one', row], ['old', old]])
    const h = await createHarness(variant, { sessions })
    t.after(() => h.dispose())
    assert.equal((await h.waitReady()).totalTokens, 550)
    sessions.delete('old')
    assert150(await h.rescan())
    sessions.clear()
    const empty = await h.rescan()
    for (const key of ['totalTokens', 'totalRequests', 'totalTurns', 'totalChatMs', 'totalInput',
      'totalOutput', 'totalCacheRead', 'totalSessions', 'activeDays', 'peakStepTokens',
      'longestTurnMs', 'longestChatMs', 'streakCurrent', 'streakLongest', 'scannedSessions']) {
      assert.equal(empty[key], 0, key)
    }
    assert.equal(empty.peakDay, null)
    assert.equal(empty.longestChatSessionId, null)
    assert.deepEqual(empty.models, [])
    assert.deepEqual(empty.days, [])
    // Ending an old open turn after rebuilding must not resurrect its duration.
    const end = event(5, 'turn/end', { turn: 99 }, baseTime + 50000)
    sessions.set('old', { header: old.header, events: [end] })
    h.emit('session/created', old.header)
    h.emit('session/event', old.header, end)
    await h.waitReady()
    assert.equal((await h.stats()).totalChatMs, 0)
  })

  test(`${variant}: concurrent rescan callers await one complete rebuild`, async t => {
    const row = session()
    const gate = deferred()
    let block = false
    const h = await createHarness(variant, {
      sessions: new Map([['one', row]]),
      async readSession() {
        const copy = { events: row.events.slice() }
        if (block) await gate.promise
        return copy
      },
    })
    t.after(() => h.dispose())
    await h.waitReady()
    block = true
    let completions = 0
    const first = h.rescan().then(value => { completions += 1; return value })
    const second = h.rescan().then(value => { completions += 1; return value })
    await until(() => h.reads.full.length === 2)
    assert.equal(completions, 0)
    assert.equal((await h.stats()).totalTokens, 150)
    assert.equal((await h.stats()).scanning, true)
    for (const ev of suffix()) {
      row.events.push(ev)
      h.emit('session/event', row.header, ev)
    }
    gate.resolve()
    const values = await Promise.all([first, second])
    assert.deepEqual(values[0], values[1])
    assert200(values[0])
    assert.equal(h.reads.full.length, 2)
  })

  test(`${variant}: first replay orders persisted prefix before a live suffix`, async t => {
    const row = session()
    const tail = suffix()
    row.events.push(...tail.slice(0, 2))
    const gate = deferred()
    const h = await createHarness(variant, {
      sessions: new Map([['one', row]]),
      async readSession() { const prefix = row.events.slice(); await gate.promise; return { events: prefix } },
    })
    t.after(() => h.dispose())
    await until(() => h.reads.full.length === 1)
    for (const ev of tail.slice(2)) {
      row.events.push(ev)
      h.emit('session/event', row.header, ev)
    }
    gate.resolve()
    assert200(await h.waitReady())
  })

  test(`${variant}: snapshot load and delta cannot lose an earlier prefix to live events`, async t => {
    const row = session()
    const sessions = new Map([['one', row]])
    const files = new Map()
    const first = await createHarness(variant, { sessions, files })
    await first.waitReady()
    await first.flush()
    await first.dispose()
    row.events.push(...suffix())
    const gate = deferred()
    const fs = memoryFs(files)
    const readText = fs.readText
    fs.readText = async path => { const text = await readText(path); await gate.promise; return text }
    const h = await createHarness(variant, { sessions, fs })
    t.after(() => h.dispose())
    h.emit('session/event', row.header, row.events[6])
    h.emit('session/event', row.header, row.events[7])
    gate.resolve()
    assert200(await h.waitReady())
    assert.deepEqual(h.reads.delta, [['one', 4]])
    assert.deepEqual(h.reads.full, [])
  })

  test(`${variant}: seeded session created during list replay includes its history`, async t => {
    const gate = deferred()
    const sessions = new Map()
    const h = await createHarness(variant, { sessions, async listSessions() { await gate.promise; return [] } })
    t.after(() => h.dispose())
    await until(() => h.reads.list === 1)
    const row = session()
    sessions.set('one', row)
    h.emit('session/created', row.header)
    h.emit('session/event', row.header, row.events[3])
    gate.resolve()
    assert150(await h.waitReady())
  })

  test(`${variant}: invalid snapshot cannot partially contaminate the full fallback`, async t => {
    const row = session()
    const fs = memoryFs()
    fs.readText = async () => JSON.stringify({
      version: 1, totalTokens: 999, totalRequests: 1, peakStepTokens: 999,
      longestTurnMs: 0, longestChatMs: 0, longestChatSessionId: null,
      days: [{ date: '2020-01-01', input: 999, output: 0, cacheRead: 0, cacheWrite: 0, total: 999, requests: 1 }],
      sessions: [['broken', null]], modelStats: [], openTurns: [],
    })
    const h = await createHarness(variant, { sessions: new Map([['one', row]]), fs })
    t.after(() => h.dispose())
    assert150(await h.waitReady())
  })

  test(`${variant}: a persisted sequence zero is restored exactly`, async t => {
    const row = { header: { id: 'one', createdAt: baseTime }, events: [event(0, 'assistant/message', { usage: { inputTokens: 50 } })] }
    const sessions = new Map([['one', row]])
    const files = new Map()
    const first = await createHarness(variant, { sessions, files })
    await first.waitReady()
    await first.flush()
    await first.dispose()
    const h = await createHarness(variant, { sessions, files })
    t.after(() => h.dispose())
    assert.equal((await h.waitReady()).totalTokens, 50)
    assert.deepEqual(h.reads.delta, [['one', 1]])
    h.emit('session/event', row.header, row.events[0])
    assert.equal((await h.stats()).totalTokens, 50)
  })

  test(`${variant}: failed rebuild preserves complete state and retries buffered events once`, async t => {
    const one = session()
    const two = session('two', 100)
    const sessions = new Map([['one', one], ['two', two]])
    const gate = deferred()
    let fail = false
    const h = await createHarness(variant, {
      sessions,
      async readSession(id) {
        if (fail && id === 'two') { await gate.promise; throw new Error('disk read failed') }
        return { events: sessions.get(id).events.slice() }
      },
    })
    t.after(() => h.dispose())
    const original = await h.waitReady()
    fail = true
    const attempt = assert.rejects(h.rescan(), /disk read failed/)
    await until(() => h.reads.full.length === 4)
    for (const ev of suffix()) {
      one.events.push(ev)
      h.emit('session/event', one.header, ev)
    }
    gate.resolve()
    await attempt
    assert.deepEqual(await h.stats(), original)
    fail = false
    const recovered = await h.rescan()
    assert.equal(recovered.totalTokens, 300)
    assert.equal(recovered.totalRequests, 3)
    assert.equal(recovered.totalTurns, 3)
    assert.deepEqual(recovered.models, [
      { key: 'deepseek/chat', tokens: 250, requests: 2 },
      { key: 'deepseek/reasoner', tokens: 50, requests: 1 },
    ])
  })

  test(`${variant}: delta retains deleted historical sessions; explicit rescan removes them`, async t => {
    const sessions = new Map([['one', session()], ['old', session('old', 100)]])
    const files = new Map()
    const first = await createHarness(variant, { sessions, files })
    await first.waitReady()
    await first.flush()
    await first.dispose()
    sessions.delete('old')
    const h = await createHarness(variant, { sessions, files })
    t.after(() => h.dispose())
    const retained = await h.waitReady()
    assert.equal(retained.totalTokens, 250)
    assert.equal(retained.totalSessions, 2)
    assert150(await h.rescan())
  })

  test(`${variant}: without persistence service, snapshot delta still avoids duplicate events`, async t => {
    const row = session()
    const sessions = new Map([['one', row]])
    const files = new Map()
    const first = await createHarness(variant, { sessions, files, persistence: false })
    await first.waitReady()
    await first.flush()
    await first.dispose()
    row.events.push(...suffix())
    const h = await createHarness(variant, { sessions, files, persistence: false })
    t.after(() => h.dispose())
    assert200(await h.waitReady())
    assert.equal(h.reads.full.length, 1)
  })

  test(`${variant}: overlapping snapshot saves are serialized and keep the newest totals`, async t => {
    const row = session()
    const gate = deferred()
    const fs = memoryFs()
    const writeText = fs.writeText
    let writes = 0, active = 0, maxActive = 0
    fs.writeText = async (path, text) => {
      writes += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (writes === 1) await gate.promise
      await writeText(path, text)
      active -= 1
    }
    const h = await createHarness(variant, { sessions: new Map([['one', row]]), fs })
    t.after(() => h.dispose())
    await h.waitReady()
    const save = h.flush()
    await until(() => writes === 1)
    for (const ev of suffix()) h.emit('session/event', row.header, ev)
    const secondSave = h.flush()
    gate.resolve()
    await Promise.all([save, secondSave])
    await until(() => [...fs.files.values()].some(text => JSON.parse(text).totalTokens === 200))
    assert.equal(maxActive, 1)
  })

  test(`${variant}: creating a session after a failed scan recovers every buffered prefix`, async t => {
    const row = { header: { id: 'one', createdAt: baseTime }, events: [event(0, 'assistant/message', { usage: { inputTokens: 100 } })] }
    const sessions = new Map([['one', row]])
    let fail = false
    let h
    h = await createHarness(variant, {
      sessions,
      async readSession(id) {
        if (fail && id === 'one') {
          h.emit('session/event', row.header, row.events[2])
          throw new Error('read interrupted')
        }
        return sessions.get(id)
      },
    })
    t.after(() => h.dispose())
    await h.waitReady()
    row.events.push(event(1, 'assistant/message', { usage: { inputTokens: 20 } }),
      event(2, 'assistant/message', { usage: { inputTokens: 50 } }))
    fail = true
    await assert.rejects(h.rescan(), /read interrupted/)
    fail = false
    const created = { header: { id: 'new', createdAt: baseTime }, events: [] }
    sessions.set('new', created)
    h.emit('session/created', created.header)
    assert.equal((await h.waitReady()).totalTokens, 170)
    assert.equal((await h.stats()).totalRequests, 3)
  })

  test(`${variant}: an event between the save drain and finalizer is persisted without a timer`, async t => {
    const row = session()
    const fs = memoryFs()
    const gate = deferred()
    const totals = []
    // Returning this exact promise makes the finalizer race deterministic.
    fs.writeText = (path, text) => {
      fs.files.set(path, text)
      totals.push(JSON.parse(text).totalTokens)
      return totals.length === 1 ? gate.promise : Promise.resolve()
    }
    const h = await createHarness(variant, { sessions: new Map([['one', row]]), fs, timer: false })
    t.after(() => h.dispose())
    await h.waitReady()
    await until(() => totals.length === 1)
    gate.resolve()
    queueMicrotask(() => h.emit('session/event', row.header,
      event(4, 'assistant/message', { usage: { inputTokens: 50 } })))
    await until(() => totals.length === 2)
    assert.deepEqual(totals, [150, 200])
  })

  test(`${variant}: persistence without legacy readFrom falls back to the full session query`, async t => {
    const row = session()
    const sessions = new Map([['one', row]])
    const files = new Map()
    const first = await createHarness(variant, { sessions, files })
    await first.waitReady()
    await first.dispose()
    row.events.push(...suffix())
    const h = await createHarness(variant, {
      sessions, files,
      services: { sessionPersistence: {
        // Current Harness list() returns metadata wrappers, not raw headers.
        async list() { return [{ header: row.header }] },
      } },
    })
    t.after(() => h.dispose())
    assert200(await h.waitReady())
    assert.deepEqual(h.reads.full, ['one'])
    assert.deepEqual(h.reads.delta, [])
  })

  test(`${variant}: a session created between scan commit and finalizer is replayed`, async t => {
    const sessions = new Map([['one', session()]])
    const fs = memoryFs()
    const writeText = fs.writeText
    let armed = false
    let h
    fs.writeText = (path, text) => {
      if (armed) {
        armed = false
        const row = session('two', 200)
        sessions.set('two', row)
        h.emit('session/created', row.header)
      }
      return writeText(path, text)
    }
    h = await createHarness(variant, { sessions, fs, timer: false })
    t.after(() => h.dispose())
    await h.waitReady()
    armed = true
    const result = await h.rescan()
    assert.equal(result.totalTokens, 350)
    assert.equal(result.totalSessions, 2)
    assert.equal(result.totalRequests, 2)
  })

  test(`${variant}: startup settling also drains newly created sessions`, async t => {
    const sessions = new Map([['one', session()]])
    const fs = memoryFs()
    const writeText = fs.writeText
    let firstSave = true
    let h
    fs.writeText = (path, text) => {
      if (firstSave) {
        firstSave = false
        Promise.resolve().then(() => {}).then(() => {
          const row = session('two', 200)
          sessions.set('two', row)
          h.emit('session/created', row.header)
        })
      }
      return writeText(path, text)
    }
    h = await createHarness(variant, { sessions, fs, timer: false })
    t.after(() => h.dispose())
    await until(async () => (await h.stats()).totalTokens === 350)
    assert.equal((await h.waitReady()).totalSessions, 2)
  })
}
