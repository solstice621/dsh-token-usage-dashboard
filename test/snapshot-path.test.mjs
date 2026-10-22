import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createHarness, memoryFs, session, variants } from './helpers.mjs'

const snapshot = home => join(home, 'storages', 'token-stats', 'snapshot.json')

for (const variant of variants) {
  test(`${variant}: separate harness homes never read or overwrite each other's snapshot`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'token-stats-homes-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const fs = {
      async resolve(path) { return resolve(path) },
      readText: path => readFile(path, 'utf8'),
      async writeText(path, text) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) },
    }
    const aHome = join(root, 'profile-a')
    const bHome = join(root, 'profile-b')
    const a = await createHarness(variant, { fs, profileContext: { home: aHome }, sessions: new Map([['one', session('one', 150)]]) })
    const b = await createHarness(variant, { fs, profileContext: { home: bHome }, sessions: new Map([['one', session('one', 900)]]) })
    await Promise.all([a.waitReady(), b.waitReady()])
    await Promise.all([a.dispose(), b.dispose()])
    const savedA = await readFile(snapshot(aHome), 'utf8')
    assert.equal(JSON.parse(savedA).totalTokens, 150)
    assert.equal(JSON.parse(await readFile(snapshot(bHome), 'utf8')).totalTokens, 900)

    // With the logs removed, these totals can only come from each own snapshot.
    const restartA = await createHarness(variant, { fs, profileContext: { home: aHome } })
    const restartB = await createHarness(variant, { fs, profileContext: { home: bHome } })
    assert.equal((await restartA.waitReady()).totalTokens, 150)
    assert.equal((await restartB.waitReady()).totalTokens, 900)
    await restartB.rescan()
    await restartB.dispose()
    assert.equal(await readFile(snapshot(aHome), 'utf8'), savedA)
    await restartA.dispose()
    assert.equal(JSON.parse(await readFile(snapshot(bHome), 'utf8')).totalTokens, 0)
  })

  test(`${variant}: launcher home takes precedence over ambient DSH_HOME and embedded config`, async t => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/wrong/ambient-home'
    t.after(() => previous === undefined ? delete process.env.DSH_HOME : process.env.DSH_HOME = previous)
    const h = await createHarness(variant, {
      profileContext: { home: '/configured/harness' }, config: { dshHome: '/wrong/embedded-home' },
    })
    await h.waitReady()
    await h.dispose()
    assert.deepEqual([...h.files.keys()], [snapshot('/configured/harness')])
  })

  test(`${variant}: embedded host can supply an explicit home`, async () => {
    const h = await createHarness(variant, { profileContext: undefined, config: { dshHome: '/embedded/harness' } })
    await h.waitReady()
    await h.dispose()
    assert.deepEqual([...h.files.keys()], [snapshot('/embedded/harness')])
  })
}

test('bundle: DSH_HOME is resolved for each instance, including tilde, relative and blank overrides', async t => {
  const previous = process.env.DSH_HOME
  t.after(() => previous === undefined ? delete process.env.DSH_HOME : process.env.DSH_HOME = previous)
  for (const [home, expected] of [
    ['/profiles/a', '/profiles/a'],
    ['/profiles/b', '/profiles/b'],
    ['~/custom-dsh', join(homedir(), 'custom-dsh')],
    ['relative-dsh', resolve('relative-dsh')],
    ['', join(homedir(), '.dsh')],
    ['   ', join(homedir(), '.dsh')],
  ]) {
    process.env.DSH_HOME = home
    const h = await createHarness('bundle', { profileContext: undefined })
    await h.waitReady()
    await h.dispose()
    assert.deepEqual([...h.files.keys()], [snapshot(expected)], `DSH_HOME=${JSON.stringify(home)}`)
  }
})

test('dynamic: no process globals or profile means memory-only, never a guessed home', async () => {
  const fs = memoryFs()
  const h = await createHarness('dynamic', { fs, profileContext: undefined, sessions: new Map([['one', session()]]) })
  assert.equal((await h.waitReady()).totalTokens, 150)
  assert.equal((await h.rescan()).totalTokens, 150)
  await h.dispose()
  assert.equal(fs.files.size, 0)
  assert.match(h.logs.flat().join(' '), /persistence disabled/)
})

test('dynamic: embedded home must be absolute instead of resolving against an arbitrary cwd', async () => {
  for (const dshHome of ['relative-dsh', '~/custom-dsh']) {
    await assert.rejects(createHarness('dynamic', { profileContext: undefined, config: { dshHome } }), /absolute path/)
  }
})

test('bundle: connection is a hard dependency and there is no raw WebServer fallback', async () => {
  const { inject } = await import('../lib/index.js')
  assert.ok(inject.includes('connection'))
  await assert.rejects(createHarness('bundle', { services: { connection: undefined } }), /authenticated connection/)
})
