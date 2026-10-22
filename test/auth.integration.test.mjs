import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import dashboard from '../lib/index.js'

// Verified against deepseek-ai/deepseek-harness at
// 687f282e8625c6b8d11ff58211a90524be2e4317. Run with a source checkout:
// DSH_SOURCE=/path/to/deepseek-harness npm run test:integration
// This deliberately does not vendor or reimplement Harness security decisions.
describe('Bundle over the real Harness authenticated HTTP transport', {
  skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to a Harness source checkout (Node.js 24+).',
}, () => {
  let upstream
  before(async () => {
    const { loadHarnessSource } = await import('./harness-source-loader.mjs')
    upstream = await loadHarnessSource(process.env.DSH_SOURCE)
  })
  after(() => upstream?.disposeLoader())

  // Only persistence is doubled. BrowserAuth creates and checks its own secret,
  // launch token and signed session cookie against this in-memory record store.
  class Credentials {
    record
    async readRecord() { return this.record }
    async modifyRecord(_key, mutate) {
      const next = await mutate(this.record)
      if (next !== undefined) this.record = next
      return this.record
    }
  }

  async function mounted(t) {
    const root = await mkdtemp(join(tmpdir(), 'token-stats-auth-'))
    const ctx = new upstream.Context()
    let plugin
    t.after(async () => {
      // Unload the consumer while its storage provider is still available.
      await plugin?.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const reads = { lists: 0, sessions: 0 }
    const events = [{
      seq: 0, time: Date.UTC(2026, 9, 20, 12), type: 'assistant/message',
      data: { usage: { inputTokens: 100, outputTokens: 50 } },
    }]
    ctx.provide('credentials', new Credentials())
    ctx.provide('sessionQuery', {
      async listSessions() { reads.lists++; return [{ header: { id: 'fixture', createdAt: 0 } }] },
      async readSession() { reads.sessions++; return { events } },
    })
    await ctx.plugin(upstream.Storage).await()
    await ctx.plugin({ inject: upstream.storageJson.inject, apply: upstream.storageJson.apply }, { root }).await()
    const server = ctx.plugin(upstream.WebServer, { host: '127.0.0.1', port: 0 })
    await server.await()
    const connectionPlugin = ctx.plugin({
      inject: [...upstream.connection.inject], apply: upstream.connection.apply,
    })
    await connectionPlugin.await()
    plugin = ctx.plugin(dashboard)
    await plugin.await()
    const connection = ctx.get('connection')
    const origin = ctx.get('webServer').getOrigin()
    const authority = new URL(origin).host

    // Simulate the SPA index owner's delegation without supplying any auth logic.
    // The browser exchanges the actual launch URL over a real HTTP socket.
    ctx.get('webServer').register({ kind: 'exact', path: '/', handler(req, res) {
      if (connection.authorizeIndex(req, res)) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><title>Harness integration fixture</title>')
      }
    } })

    function request(path, { method = 'GET', headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = httpRequest(new URL(path, origin), { method, headers, agent: false }, res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        req.end()
      })
    }
    const login = await request(connection.authenticatedUrl(origin))
    assert.equal(login.status, 303)
    const setCookie = login.headers['set-cookie']?.[0]
    assert.ok(setCookie, 'real BrowserAuth must issue a session cookie')
    const cookie = setCookie.split(';', 1)[0]
    const headers = { cookie, origin }
    let initial
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request('/api/token-stats', { headers })
      assert.equal(response.status, 200)
      initial = JSON.parse(response.body)
      if (initial.ready && !initial.scanning) break
      await delay(10)
    }
    assert.equal(initial?.ready, true, 'startup must complete')
    assert.equal(initial.scanning, false)
    assert.equal(initial.totalTokens, 150)
    return { ctx, connection, request, reads, headers, origin, authority, cookie, plugin }
  }

  it('rejects anonymous, forged-cookie and launch-query API access before any scan', async t => {
    const { request, reads, connection, origin, cookie } = await mounted(t)
    const baseline = { ...reads }
    const launchQuery = new URL(connection.authenticatedUrl(origin)).search
    const cookieName = cookie.slice(0, cookie.indexOf('='))
    const signatureAt = cookie.lastIndexOf('.') + 1
    const tamperedCookie = cookie.slice(0, signatureAt)
      + (cookie[signatureAt] === 'A' ? 'B' : 'A') + cookie.slice(signatureAt + 1)
    for (const [path, method] of [
      ['/api/token-stats', 'GET'], ['/api/token-stats/rescan', 'POST'],
      ['/api/token-stats/rescan', 'GET'],
    ]) {
      for (const options of [
        { method },
        { method, headers: { cookie: `${cookieName}=v1.forged.signature` } },
        { method, headers: { cookie: tamperedCookie } },
      ]) {
        const response = await request(path, options)
        assert.equal(response.status, 401, `${method} ${path}`)
        assert.doesNotMatch(response.body, /totalTokens|totalRequests/)
      }
      const queryAttempt = await request(path + launchQuery, { method })
      assert.equal(queryAttempt.status, 401, 'launch token only works at the index exchange')
    }
    assert.deepEqual(reads, baseline, 'denied requests cannot scan session storage')
  })

  it('rejects hostile Host and cross-origin requests even with a valid session', async t => {
    const { request, reads, headers, origin, cookie } = await mounted(t)
    const baseline = { ...reads }
    for (const [path, method] of [
      ['/api/token-stats', 'GET'], ['/api/token-stats/rescan', 'POST'],
    ]) {
      for (const badHeaders of [
        { ...headers, host: 'attacker.example' },
        { cookie, origin: 'https://attacker.example' },
        { cookie, origin: 'null' },
        { cookie, origin: origin.replace('127.0.0.1', 'localhost') },
      ]) {
        const response = await request(path, { method, headers: badHeaders })
        assert.equal(response.status, 403, `${method} ${path}: ${JSON.stringify(badHeaders)}`)
        assert.doesNotMatch(response.body, /totalTokens|totalRequests/)
      }
    }
    assert.deepEqual(reads, baseline, 'trust-fence rejection cannot trigger a scan')
  })

  it('only accepts GET stats and POST rescan, and authenticated rescans stay idempotent', async t => {
    const { request, reads, headers } = await mounted(t)
    const baseline = { ...reads }
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request('/api/token-stats/rescan', { method, headers })
      assert.equal(response.status, 404, `${method} is not registered for rescan`)
    }
    assert.equal((await request('/api/token-stats', { method: 'POST', headers })).status, 404)
    assert.deepEqual(reads, baseline, 'unclaimed methods cannot scan')
    for (let i = 1; i <= 3; i++) {
      const response = await request('/api/token-stats/rescan', { method: 'POST', headers })
      assert.equal(response.status, 200)
      assert.equal(response.headers['cache-control'], 'no-store')
      const payload = JSON.parse(response.body)
      assert.equal(payload.totalTokens, 150)
      assert.equal(payload.totalRequests, 1)
      assert.equal(payload.scanning, false)
      assert.equal(reads.lists, baseline.lists + i)
      assert.equal(reads.sessions, baseline.sessions + i)
    }
    const stats = await request('/api/token-stats', { headers })
    assert.equal(stats.status, 200)
    assert.equal(stats.headers['cache-control'], 'no-store')
    assert.equal(JSON.parse(stats.body).totalTokens, 150)
  })

  it('withdraws both routes when the Bundle plugin is disposed', async t => {
    const { request, reads, headers, plugin } = await mounted(t)
    const baseline = { ...reads }
    await plugin.dispose()
    for (const [path, method] of [
      ['/api/token-stats', 'GET'], ['/api/token-stats/rescan', 'POST'],
    ]) assert.equal((await request(path, { method, headers })).status, 404)
    assert.deepEqual(reads, baseline)
  })
})
