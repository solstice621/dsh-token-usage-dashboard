// ===== dsh-token-usage-dashboard · Host 半（bundle 版）=====
// 与动态插件版 host.js 同源：折叠全部会话日志中的 assistant/message usage 与 turn 时长。
// 差异：不依赖 harness RPC（那是动态插件机制），注册受认证保护的 connection.fetch 路由：
//   GET  /api/token-stats           → 完整统计 JSON
//   POST /api/token-stats/rescan    → 重新回补后返回同结构（备用）
// Rescans rebuild from logs; live events are merged after ordered replay.
// Snapshots follow the launcher's DSH_HOME and normal restarts only read deltas.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const name = 'dsh-token-usage-dashboard'
// connection owns the authenticated /api transport; exact webServer routes bypass it.
const inject = ['connection', 'sessionQuery', 'storage', 'storage.backend.json']

function pad2(n) { return n < 10 ? '0' + n : '' + n }
function dayKeyOf(time) {
  const d = new Date(time)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}
function shiftDayKey(key, delta) {
  const d = new Date(key + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return dayKeyOf(d.getTime())
}
function usageTotal(u) {
  return (u.inputTokens || 0) + (u.outputTokens || 0) +
    (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
}
function jsonResponse(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function snapshotPath(ctx, config) {
  const profile = ctx.get('profileContext')
  const envHome = process.env.DSH_HOME
  let home = (profile && profile.home) ?? config.dshHome ??
    (envHome && envHome.trim() ? envHome : join(homedir(), '.dsh'))
  if (typeof home !== 'string' || !home.trim()) {
    throw new Error('token-stats dshHome must be a non-empty path')
  }
  // Match Harness resolveDshHome: expand supported tilde prefixes and resolve
  // relative overrides before handing the path to the filesystem service.
  if (home === '~') home = homedir()
  else if (home.startsWith('~/') || home.startsWith('~\\')) home = join(homedir(), home.slice(2))
  return join(resolve(home), 'storages', 'token-stats', 'snapshot.json')
}
const SNAPSHOT_VERSION = 1

function apply(ctx, config = {}) {
  const SNAPSHOT_PATH = snapshotPath(ctx, config)
  const sessionQuery = ctx.get('sessionQuery')
  const sessionPersistence = ctx.get('sessionPersistence')
  const storage = ctx.get('storage')
  const connection = ctx.get('connection')
  const fs = ctx.get('fs')
  const timer = ctx.get('timer')

  // Replay into a private state, then publish it in one synchronous step. Live
  // events wait behind replay so their sequence numbers cannot hide its prefix.
  function emptyState() {
    return {
      days: new Map(), sessions: new Map(), openTurns: new Map(), modelStats: new Map(),
      totalTokens: 0, totalRequests: 0, peakStepTokens: 0,
      longestTurnMs: 0, longestChatMs: 0, longestChatSessionId: null,
    }
  }
  let state = emptyState()
  let disposed = false
  let ready = false
  let scanning = true
  let scannedSessions = 0
  let initializing = true
  let buffering = true
  let retryAll = false
  let scanPromise = null
  let rescanPromise = null
  let savePromise = null
  let dirty = false
  let fsTarget = null
  let storagePromise = null
  const bufferedEvents = new Map()
  const createdSessions = new Set()

  function sessionRec(target, id, createdAt) {
    let rec = target.sessions.get(id)
    if (!rec) {
      rec = { lastSeq: -1, tokens: 0, chatMs: 0, turns: 0,
        createdAt: createdAt || 0, model: null }
      target.sessions.set(id, rec)
    }
    return rec
  }

  function markDirty() {
    dirty = true
    if (timer === undefined) flushSave()
  }

  function foldEvent(target, sessionId, event) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) return
    const rec = sessionRec(target, sessionId)
    if (event.seq <= rec.lastSeq) return
    rec.lastSeq = event.seq
    const type = event.type
    const data = event.data
    if (!data) return
    if (type === 'assistant/message') {
      const u = data.usage
      if (!u) return
      const t = usageTotal(u)
      if (t <= 0) return
      const key = dayKeyOf(event.time)
      let day = target.days.get(key)
      if (!day) {
        day = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 }
        target.days.set(key, day)
      }
      day.input += u.inputTokens || 0
      day.output += u.outputTokens || 0
      day.cacheRead += u.cacheReadTokens || 0
      day.cacheWrite += u.cacheWriteTokens || 0
      day.total += t
      day.requests += 1
      target.totalTokens += t
      target.totalRequests += 1
      rec.tokens += t
      const mk = rec.model || 'unknown'
      let ms = target.modelStats.get(mk)
      if (!ms) {
        ms = { tokens: 0, requests: 0 }
        target.modelStats.set(mk, ms)
      }
      ms.tokens += t
      ms.requests += 1
      if (t > target.peakStepTokens) target.peakStepTokens = t
    } else if (type === 'request/header') {
      const cfg = data.header && data.header.config
      if (cfg && cfg.model) rec.model = (cfg.provider || '?') + '/' + cfg.model
    } else if (type === 'turn/start') {
      target.openTurns.set(sessionId + ':' + data.turn, event.time)
    } else if (type === 'turn/end') {
      const k = sessionId + ':' + data.turn
      const start = target.openTurns.get(k)
      if (start !== undefined) {
        target.openTurns.delete(k)
        const dur = Math.max(0, event.time - start)
        rec.chatMs += dur
        rec.turns += 1
        if (dur > target.longestTurnMs) target.longestTurnMs = dur
        if (rec.chatMs > target.longestChatMs) {
          target.longestChatMs = rec.chatMs
          target.longestChatSessionId = sessionId
        }
      }
    }
  }

  function foldEvents(target, id, events) {
    // Persistence returns ordered events; sorting also keeps buffered live
    // duplicates and a concurrently delivered suffix in their causal order.
    for (const event of events.slice().sort((a, b) => a.seq - b.seq)) {
      foldEvent(target, id, event)
    }
  }

  function cloneState(source) {
    return { ...source,
      days: new Map(Array.from(source.days, ([id, value]) => [id, { ...value }])),
      sessions: new Map(Array.from(source.sessions, ([id, value]) => [id, { ...value }])),
      modelStats: new Map(Array.from(source.modelStats, ([id, value]) => [id, { ...value }])),
      openTurns: new Map(source.openTurns),
    }
  }

  // ---- Snapshot persistence: never save partially replayed state. ----
  function serialize() {
    return JSON.stringify({ ...state, version: SNAPSHOT_VERSION, savedAt: Date.now(),
      days: Array.from(state.days, ([date, value]) => ({ date, ...value })),
      sessions: Array.from(state.sessions), modelStats: Array.from(state.modelStats),
      openTurns: Array.from(state.openTurns),
    })
  }

  // The host JSON backend owns the DSH_HOME storage root. It is separate
  // from ctx.fs, which may represent a sandboxed or remote workspace.
  function nativeUnit() {
    if (storagePromise === null) {
      storagePromise = Promise.resolve().then(() => storage.backend.get('json').kv.open({
        name: 'token_stats', version: SNAPSHOT_VERSION, tables: [], hasGlobal: true,
      })).catch(error => {
        storagePromise = null
        throw error
      })
    }
    return storagePromise
  }

  async function readSnapshot() {
    if (storage !== undefined) {
      const unit = await nativeUnit()
      const snapshot = (await unit.loadAll()).global
      if (snapshot !== null && snapshot !== undefined) return snapshot
      // Migrate the previous file only when the native unit has never been written.
      // Native storage errors must never redirect writes into the workspace FS.
    }
    if (fs === undefined) return null
    fsTarget = await fs.resolve(SNAPSHOT_PATH)
    return JSON.parse(await fs.readText(fsTarget))
  }

  async function closeStorage() {
    if (storagePromise !== null) await (await storagePromise).close()
  }

  function flushSave() {
    if (savePromise) return savePromise
    if (!dirty || !ready || (storage === undefined && fs === undefined)) return Promise.resolve()
    let failed = false
    savePromise = Promise.resolve().then(async () => {
      try {
        const unit = storage === undefined ? null : await nativeUnit()
        if (unit === null && fsTarget === null) fsTarget = await fs.resolve(SNAPSHOT_PATH)
        while (dirty) {
          dirty = false
          const snapshot = serialize()
          if (unit !== null) await unit.setGlobal(JSON.parse(snapshot))
          else await fs.writeText(fsTarget, snapshot)
        }
      } catch (e) {
        failed = true
        dirty = true
        console.error('[dsh-token-usage-dashboard] snapshot write failed:', String(e))
      }
    }).finally(() => {
      savePromise = null
      // An event can arrive between the drain loop and this finalizer.
      if (dirty && !failed && timer === undefined) return flushSave()
    })
    return savePromise
  }

  async function loadSnapshot() {
    if (storage === undefined && fs === undefined) return false
    try {
      const snap = await readSnapshot()
      if (!snap || snap.version !== SNAPSHOT_VERSION ||
          !Array.isArray(snap.days) || !Array.isArray(snap.sessions) ||
          !Array.isArray(snap.modelStats) || !Array.isArray(snap.openTurns)) return false
      const loaded = emptyState()
      function number(value) {
        if (!Number.isFinite(value) || value < 0) throw new Error('Invalid snapshot number')
        return value
      }
      for (const key of ['totalTokens', 'totalRequests', 'peakStepTokens', 'longestTurnMs', 'longestChatMs']) {
        loaded[key] = number(snap[key])
      }
      loaded.longestChatSessionId = snap.longestChatSessionId || null
      for (const d of snap.days) {
        if (!d || typeof d.date !== 'string') throw new Error('Invalid snapshot day')
        loaded.days.set(d.date, { input: number(d.input), output: number(d.output),
          cacheRead: number(d.cacheRead), cacheWrite: number(d.cacheWrite),
          total: number(d.total), requests: number(d.requests) })
      }
      for (const [id, r] of snap.sessions) {
        if (typeof id !== 'string' || !r || !Number.isSafeInteger(r.lastSeq) || r.lastSeq < -1) {
          throw new Error('Invalid snapshot session')
        }
        loaded.sessions.set(id, { lastSeq: r.lastSeq, tokens: number(r.tokens),
          chatMs: number(r.chatMs), turns: number(r.turns), createdAt: number(r.createdAt),
          model: r.model || null })
      }
      for (const [id, r] of snap.modelStats) {
        loaded.modelStats.set(id, { tokens: number(r.tokens), requests: number(r.requests) })
      }
      for (const [id, time] of snap.openTurns) loaded.openTurns.set(id, number(time))
      state = loaded
      return true
    } catch (e) {
      return false
    }
  }

  // All reads belong to one transaction. A failed read keeps the last complete
  // state and buffered events for a later retry, instead of publishing half a scan.
  function startScan(rebuild, onlyIds) {
    scanning = true
    buffering = true
    scanPromise = Promise.resolve().then(async () => {
      if (disposed) return
      if (!sessionQuery) throw new Error('sessionQuery service is required to scan token usage')
      const target = rebuild ? emptyState() : cloneState(state)
      const seen = new Set()
      let count = 0
      async function readHeaders(headers) {
        const jobs = []
        for (const item of headers || []) {
          const header = item && item.header ? item.header : item
          if (!header || !header.id || seen.has(header.id)) continue
          const id = header.id
          seen.add(id)
          const rec = sessionRec(target, id, header.createdAt)
          const from = rec.lastSeq + 1
          jobs.push(Promise.resolve().then(async () => {
            let snap
            if (!rebuild && typeof sessionPersistence?.readFrom === 'function') {
              snap = await sessionPersistence.readFrom(id, from)
            } else {
              snap = await sessionQuery.readSession(id)
            }
            if (disposed) return
            foldEvents(target, id, (snap && snap.events) || [])
            count += 1
          }))
        }
        await Promise.all(jobs)
      }
      const headers = onlyIds && !retryAll ? Array.from(onlyIds, id => ({ id })) :
        !rebuild && sessionPersistence !== undefined ? await sessionPersistence.list() :
          await sessionQuery.listSessions()
      await readHeaders(headers)
      // Seeded sessions can be created after list() and before the final commit.
      // Read their prefix before applying the live suffix.
      while (Array.from(createdSessions).some(id => !seen.has(id))) {
        await readHeaders(Array.from(createdSessions, id => ({ id })))
      }
      if (disposed) return
      for (const [id, events] of bufferedEvents) foldEvents(target, id, events)
      state = target
      retryAll = false
      createdSessions.clear()
      bufferedEvents.clear()
      buffering = false
      scannedSessions = count
      ready = true
      markDirty()
    }).catch(error => {
      // A later session-created scan must also recover every failed prefix
      // before committing the shared live-event buffer.
      retryAll = true
      throw error
    }).finally(() => {
      scanning = false
      scanPromise = null
      // Creation may race with the promise finalizer after a successful commit.
      // Failed scans keep buffering=true and retry only on a later request/event.
      if (!disposed && !buffering && (createdSessions.size || bufferedEvents.size)) {
        return syncDelta().catch(reportScanError)
      }
    })
    return scanPromise
  }

  function syncDelta(ids) {
    if (disposed) return Promise.resolve()
    if (scanPromise) return scanPromise
    return startScan(false, ids)
  }

  // A rescan always rebuilds current logs, including clearing deleted sessions.
  // Concurrent callers share the same completed result, never an early return.
  function backfill() {
    if (rescanPromise) return rescanPromise
    rescanPromise = Promise.resolve().then(async () => {
      await startupPromise
      if (scanPromise) await scanPromise
      if (!disposed) await startScan(true)
    }).finally(() => { rescanPromise = null })
    return rescanPromise
  }

  function reportScanError(error) {
    console.error('[dsh-token-usage-dashboard] scan failed:', String(error))
  }

  ctx.on('session/event', (session, event) => {
    if (disposed || !session || !event) return
    if (!state.sessions.has(session.id)) createdSessions.add(session.id)
    if (buffering || createdSessions.size) {
      let events = bufferedEvents.get(session.id)
      if (!events) bufferedEvents.set(session.id, events = [])
      events.push(event)
      if (!initializing && !scanPromise) syncDelta().catch(reportScanError)
    } else {
      foldEvent(state, session.id, event)
      markDirty()
    }
  })

  ctx.on('session/created', (session) => {
    if (disposed || !session) return
    createdSessions.add(session.id)
    if (!initializing && !scanPromise) syncDelta(new Set([session.id])).catch(reportScanError)
  })

  function buildPayload() {
    const { days, sessions, modelStats, totalTokens, totalRequests, peakStepTokens,
      longestTurnMs, longestChatMs, longestChatSessionId } = state
    const dayList = []
    let peakDay = null
    for (const entry of days) {
      const key = entry[0]
      const d = entry[1]
      dayList.push({
        date: key, input: d.input, output: d.output,
        cacheRead: d.cacheRead, cacheWrite: d.cacheWrite,
        total: d.total, requests: d.requests,
      })
      if (!peakDay || d.total > peakDay.total) peakDay = { date: key, total: d.total }
    }
    dayList.sort((a, b) => (a.date < b.date ? -1 : 1))
    // 连续天数
    const keySet = new Set(dayList.map((d) => d.date))
    let longest = 0
    let run = 0
    let prev = null
    for (const d of dayList) {
      if (prev !== null && shiftDayKey(prev, 1) === d.date) run += 1
      else run = 1
      if (run > longest) longest = run
      prev = d.date
    }
    let current = 0
    let cursor = dayKeyOf(Date.now())
    if (!keySet.has(cursor)) cursor = shiftDayKey(cursor, -1)
    while (keySet.has(cursor)) {
      current += 1
      cursor = shiftDayKey(cursor, -1)
    }
    // 洞察类聚合：总轮数 / 聊天总时长 / 输入·输出·缓存 Token
    let totalTurns = 0
    let totalChatMs = 0
    for (const entry of sessions) {
      totalTurns += entry[1].turns
      totalChatMs += entry[1].chatMs
    }
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    for (const entry of days) {
      totalInput += entry[1].input
      totalOutput += entry[1].output
      totalCacheRead += entry[1].cacheRead
    }
    // 模型排名（provider/model，按 token 降序；unknown 归并桶不展示）
    const modelList = []
    for (const entry of modelStats) {
      if (entry[0] === 'unknown') continue
      modelList.push({ key: entry[0], tokens: entry[1].tokens, requests: entry[1].requests })
    }
    modelList.sort((a, b) => b.tokens - a.tokens)
    return {
      ready: ready,
      scanning: scanning,
      scannedSessions: scannedSessions,
      totalTokens: totalTokens,
      totalRequests: totalRequests,
      totalTurns: totalTurns,
      totalChatMs: totalChatMs,
      totalInput: totalInput,
      totalOutput: totalOutput,
      totalCacheRead: totalCacheRead,
      totalSessions: sessions.size,
      activeDays: dayList.length,
      peakDay: peakDay,
      peakStepTokens: peakStepTokens,
      longestTurnMs: longestTurnMs,
      longestChatMs: longestChatMs,
      longestChatSessionId: longestChatSessionId,
      streakCurrent: current,
      streakLongest: longest,
      models: modelList,
      days: dayList,
    }
  }

  // Full /api paths are required by Connection's Fetch registry. Its HTTP
  // transport checks Host, Origin and browser authentication before dispatch.
  // Never fall back to a webServer exact route if connection is unavailable.
  if (!connection || !connection.fetch) {
    throw new Error('token-stats requires the authenticated connection.fetch service')
  }
  ctx.effect(() => connection.fetch.register({
    path: '/api/token-stats',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(buildPayload()),
  }))
  ctx.effect(() => connection.fetch.register({
    path: '/api/token-stats/rescan',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      await backfill()
      return jsonResponse(buildPayload())
    },
  }))

  // 周期 flush：timer 服务可用时 10s 检查一次脏标记
  if (timer !== undefined) {
    const stop = timer.interval(() => flushSave(), 10000)
    if (typeof stop === 'function') ctx.effect(() => stop)
  }

  ctx.effect(() => async () => {
    disposed = true
    await flushSave() // Drain writes before releasing this plugin's unit.
    await closeStorage()
  })

  // Start buffering before reading the snapshot; otherwise live events arriving
  // during load or replay can advance the persisted watermark past missing history.
  const startupPromise = Promise.resolve().then(async () => {
    if (disposed) return
    const loaded = await loadSnapshot()
    if (loaded) ready = true
    await startScan(!loaded)
  }).catch(reportScanError).finally(() => {
    initializing = false
    if (!disposed && !buffering && (createdSessions.size || bufferedEvents.size)) {
      return syncDelta().catch(reportScanError)
    }
  })
}

export { name, inject, apply }
export default { name, inject, apply }
