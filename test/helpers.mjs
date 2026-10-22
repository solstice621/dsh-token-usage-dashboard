import { readFile } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import vm from 'node:vm'

export const variants = ['bundle', 'dynamic']

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function until(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await predicate()
    if (value) return value
    await nextTurn()
  }
  throw new Error(message)
}

export function memoryFs(files = new Map()) {
  return {
    files,
    async resolve(path) { return path },
    async readText(path) {
      if (!files.has(path)) throw new Error('ENOENT: ' + path)
      return files.get(path)
    },
    async writeText(path, text) { files.set(path, text) },
  }
}

export function memoryStorage(root = '/test/dsh-home/storages', units = new Map()) {
  const calls = { opens: [], writes: 0, closes: 0 }
  const opened = new Set()
  const clone = value => JSON.parse(JSON.stringify(value))
  const json = { kv: {
    async open(descriptor) {
      const key = root + '/' + descriptor.name + '.json'
      if (opened.has(key)) throw new Error('unit already open')
      opened.add(key)
      calls.opens.push(clone(descriptor))
      let closed = false
      function assertOpen() { if (closed) throw new Error('unit closed') }
      return {
        async loadAll() { assertOpen(); return { tables: {}, global: clone(units.get(key) ?? null) } },
        async setGlobal(value) { assertOpen(); calls.writes += 1; units.set(key, clone(value)) },
        async close() {
          if (!closed) { closed = true; opened.delete(key); calls.closes += 1 }
        },
      }
    },
  } }
  return {
    backend: { get(name) { if (name !== 'json') throw new Error('unknown backend'); return json } },
    json, units, calls,
  }
}

// Exercise the actual bundle module and the actual sandbox function body. The
// registry mock enforces methods only; real transport auth belongs in its own test.
export async function createHarness(variant, options = {}) {
  const sessions = options.sessions || new Map()
  const listeners = new Map()
  const routes = []
  const rpc = new Map()
  const effects = []
  const intervals = []
  const logs = []
  const reads = { list: 0, full: [], delta: [] }
  const fs = Object.hasOwn(options, 'fs') ? options.fs : memoryFs(options.files)
  const files = fs?.files
  const services = {
    profileContext: Object.hasOwn(options, 'profileContext') ? options.profileContext : { home: '/test/dsh-home' },
    fs,
    storage: options.storage,
    timer: options.timer === false ? undefined : {
      interval(callback) { intervals.push(callback); return () => {} },
    },
    sessionQuery: {
      async listSessions() {
        reads.list += 1
        return options.listSessions ? options.listSessions() : Array.from(sessions.values(), row => ({ header: row.header }))
      },
      async readSession(id) {
        reads.full.push(id)
        return options.readSession ? options.readSession(id) : sessions.get(id)
      },
    },
    sessionPersistence: options.persistence === false ? undefined : {
      async list() {
        reads.list += 1
        return options.listSessions ? options.listSessions() : Array.from(sessions.values(), row => row.header)
      },
      async readFrom(id, from) {
        reads.delta.push([id, from])
        return options.readFrom ? options.readFrom(id, from) : {
          events: (sessions.get(id)?.events || []).filter(event => event.seq >= from),
        }
      },
    },
    connection: { fetch: {
      register(route) { routes.push(route); return () => {} },
    } },
    webServer: { register() { throw new Error('Unauthenticated WebServer route must not be registered') } },
    ...options.services,
  }
  const ctx = {
    get(name) { return services[name] },
    on(name, callback) {
      const callbacks = listeners.get(name) || []
      callbacks.push(callback)
      listeners.set(name, callbacks)
    },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  }
  if (variant === 'bundle') {
    const plugin = await import('../lib/index.js')
    plugin.apply(ctx, options.config)
  } else if (variant === 'dynamic') {
    const source = await readFile(new URL('../host.js', import.meta.url), 'utf8')
    const plugin = vm.runInNewContext('(function () {\n' + source + '\n})()', {
      harness: { handle(name, handler) { rpc.set(name, handler); return () => rpc.delete(name) } },
      console: Object.fromEntries(['log', 'warn', 'error'].map(name => [name, (...args) => logs.push([name, ...args])])),
    })
    plugin.apply(ctx, options.config)
  } else {
    throw new Error('Unknown variant: ' + variant)
  }
  const plain = value => JSON.parse(JSON.stringify(value))
  const request = async (path, { method = 'GET', ...init } = {}) => {
    const route = routes.find(route => route.path === path)
    if (!route) return new Response(null, { status: 404 })
    if (!route.methods.includes(method)) return new Response(null, { status: 405 })
    return route.fetch(new Request('http://localhost' + path, { method, ...init }))
  }
  const stats = async () => variant === 'dynamic' ? plain(await rpc.get('get-stats')()) : (await request('/api/token-stats')).json()
  const rescan = async () => variant === 'dynamic' ? plain(await rpc.get('rescan')()) :
    (await request('/api/token-stats/rescan', { method: 'POST' })).json()
  return {
    stats, rescan, request, sessions, fs, files, routes, reads, logs, services,
    emit(name, ...args) { for (const callback of listeners.get(name) || []) callback(...args) },
    async waitReady() { return until(async () => { const value = await stats(); return value.ready && !value.scanning && value }) },
    async flush() {
      for (const callback of intervals) await callback()
      // Older timer callbacks do not return the save promise, so allow queued
      // in-memory I/O to settle as well.
      await nextTurn()
    },
    async dispose() { for (const dispose of effects.reverse()) await dispose(); await nextTurn() },
  }
}

export const baseTime = Date.parse('2026-10-20T12:00:00Z')

export function event(seq, type, data, time = baseTime + seq * 1000) {
  return { seq, type, data, time }
}

export function session(id = 'one', tokens = 150, model = 'chat') {
  return { header: { id, createdAt: baseTime }, events: [
    event(0, 'request/header', { header: { config: { provider: 'deepseek', model } } }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { usage: { inputTokens: tokens - 50, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 3 } }),
    event(3, 'turn/end', { turn: 1 }),
  ] }
}
