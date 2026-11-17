/**
 * host-regression.mjs — workspace-isolate host-half regression.
 *
 * Runs index.js against a synthetic loader / profile / workspace registry and
 * asserts the behaviours that were fixed in the B1–B9 pass:
 *   B1  /capture never adopts a plugin the profile switched off, and
 *       applyGating() never switches one back off after the user re-enabled it.
 *   B2  unknown policy ids are refused and reported (policyStale / stale[]).
 *   B3  the diagnostics dump is throttled, not written on every /state poll.
 *   B4  npm metadata is cached by mtime, so a package.json edit is picked up.
 *   B6  entry ids / package names are not treated as provided services.
 *   B7  a failed state write is surfaced through /state (lastWriteError).
 *   B8  the agent registry is read live, so the arm() 409 guard works even when
 *       ctx.inject() never delivered the service.
 *
 * The plugin has zero runtime dependencies, so index.js is copied into a temp
 * dir and its single import (@deepseek-ai/schemastery) is satisfied from
 * test/fixtures/schemastery-stub. Nothing here touches the real profile.
 *
 * Run: node test/host-regression.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const ROUTE = '/api/dsh-workspace-isolate'

const results = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name: name, ok: true }) })
    .catch((error) => { results.push({ name: name, ok: false, error: error }) })
}

/** Copy index.js plus a schemastery stub into a temp dir and import it. */
async function loadHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-host-src-'))
  fs.copyFileSync(path.join(REPO, 'index.js'), path.join(root, 'index.js'))
  const stub = path.join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  fs.mkdirSync(stub, { recursive: true })
  for (const file of ['package.json', 'index.js']) {
    fs.copyFileSync(path.join(HERE, 'fixtures', 'schemastery-stub', file), path.join(stub, file))
  }
  return import(pathToFileURL(path.join(root, 'index.js')).href)
}

function entry(id, name, options) {
  const opts = options || {}
  return {
    id: id,
    disabled: Boolean(opts.disabled),
    options: { name: name, group: Boolean(opts.group) },
    fiber: {
      inject: opts.inject || {},
      provisions: (opts.provides || []).map(function (n) { return { name: n } }),
    },
  }
}

/** A loader whose update() fails on unknown ids, like the real one. */
function makeLoader(entries) {
  return {
    entries: function () {
      return entries.map(function (e) {
        return { id: e.id, disabled: e.disabled, options: { ...e.options }, fiber: e.fiber }
      })
    },
    update: async function (id, patch) {
      const target = entries.find(function (e) { return e.id === id })
      if (!target) throw new Error('no loader entry ' + id)
      target.disabled = patch.disabled
    },
  }
}

const SELF_PKG = '@cyberyui/dsh-workspace-isolate'
const PKGS = ['alpha-pkg', 'beta-pkg', 'profile-off-pkg', 'svc-a-pkg', 'unrelated-pkg', 'gamma-pkg', SELF_PKG]
const VERSIONS = { 'alpha-pkg': '1.0.0', 'beta-pkg': '1.0.0', 'profile-off-pkg': '1.0.0', 'svc-a-pkg': '1.0.0', 'unrelated-pkg': '1.0.0', 'gamma-pkg': '1.0.0', [SELF_PKG]: '0.2.1' }

/**
 * Build one world. `state` is written before apply() so the test can seed a
 * policy that the user could not have produced through the API.
 */
function makeWorld(options) {
  const opts = options || {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-host-'))
  const home = path.join(root, 'home')
  const profile = path.join(root, 'profile')
  const workspace = path.join(root, 'ws1')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })

  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(PKGS.map(function (p) { return [p, '1.0.0'] })),
    dsh: { profile: { bundles: PKGS.slice() } },
  }, null, 2))

  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '# profile-owned switches',
    '- id: profile-off',
    '  name: profile-off-pkg',
    '  disabled: true',
    '',
  ].join('\n'))

  for (const pkg of PKGS) {
    const dir = path.join(profile, 'node_modules', pkg)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: pkg, version: VERSIONS[pkg], description: 'test package ' + pkg,
    }, null, 2))
  }

  const dataFile = opts.dataFile || path.join(home, 'dsh-workspace-isolate', 'workspaces.json')
  if (opts.state !== undefined) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true })
    fs.writeFileSync(dataFile, JSON.stringify(opts.state, null, 2))
  }

  const entries = [
    entry('dsh-base', '@deepseek-ai/dsh-base', { provides: ['base'] }),
    entry('alpha', 'alpha-pkg', { provides: ['alphaSvc'] }),
    entry('beta', 'beta-pkg', { inject: { alphaSvc: true }, disabled: true }),
    entry('profile-off', 'profile-off-pkg', { disabled: true }),
    entry('svc-a', 'svc-a-pkg', {}),
    entry('injects-svc-a', 'unrelated-pkg', { inject: { 'svc-a': true } }),
    entry('gamma', 'gamma-pkg', {}),
    // The plugin itself, under the loader's real hierarchical id: must be protected.
    entry('include:@cyberyui/dsh-workspace-isolate', SELF_PKG, {}),
  ]
  const loader = makeLoader(entries)

  const services = {
    profileContext: { home: home, dir: profile },
    connection: { fetch: { register: function (route) { routes.set(route.path, route) } } },
  }
  const routes = new Map()
  const ctx = {
    loader: loader,
    workspaceRegistry: { list: function () { return [{ id: 'ws1', path: workspace, title: 'WS1', status: async function () { return 'ok' } }] } },
    skills: { list: async function () { return [] } },
    get: function (name) { return services[name] },
    inject: function () {},
    effect: function () { return function () {} },
  }

  return { root: root, home: home, profile: profile, workspace: workspace, entries: entries, loader: loader, ctx: ctx, services: services, routes: routes, dataFile: dataFile }
}

async function call(world, routePath, method, body) {
  const route = world.routes.get(ROUTE + routePath)
  assert.ok(route, 'route not registered: ' + routePath)
  const request = {
    method: method,
    url: 'http://test' + ROUTE + routePath,
    json: async function () { return body === undefined ? {} : body },
  }
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

const seeded = {
  version: 1,
  activeWorkspaceId: 'ws1',
  autoFollow: false,
  workspaces: { ws1: { disabled: ['ghost-id', 'profile-off', 'beta'], updatedAt: 1 } },
}

const host = await loadHost()

await test('B6: entry ids/package names are not services, real service deps still detected', async function () {
  const world = makeWorld({ state: seeded })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })
  const state = (await call(world, '/state', 'GET')).body
  const byId = Object.fromEntries(state.entries.map(function (row) { return [row.id, row] }))
  assert.deepEqual(byId['svc-a'].blockers, [], 'an id that equals a service name must not count as providing it')
  assert.deepEqual(byId['alpha'].blockers, ['beta'], 'a real inject dependency must still be reported')
  assert.equal(byId['include:@cyberyui/dsh-workspace-isolate'].protected, true, 'the plugin itself is protected')
})

await test('B2: stale policy ids are reported, unknown writes are refused', async function () {
  const world = makeWorld({ state: seeded })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })
  const state = (await call(world, '/state', 'GET')).body
  assert.equal(state.policyStale, 1, 'one policy id has no loader entry')
  const row = state.workspaces.find(function (w) { return w.workspaceId === 'ws1' })
  assert.deepEqual(row.stale, ['ghost-id'])

  const put = await call(world, '/disabled', 'PUT', { workspaceId: 'ws1', ids: ['beta', 'ghost-id', 'profile-off', 'dsh-base'] })
  assert.equal(put.status, 200)
  assert.deepEqual(put.body.ignored.sort(), ['ghost-id', 'profile-off'], 'unknown and profile-owned ids are refused')
  assert.deepEqual(put.body.state.workspaces.find(function (w) { return w.workspaceId === 'ws1' }).disabled, ['beta'])
  assert.equal(put.body.state.policyStale, 0, 'policy is clean after the rewrite')
})

await test('B1a: capture never adopts a plugin the profile switched off', async function () {
  const world = makeWorld({ state: seeded })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })

  const captured = await call(world, '/capture', 'POST', { workspaceId: 'ws1' })
  assert.ok(captured.body.disabled.includes('beta'), 'a gating-owned off entry is captured')
  assert.ok(!captured.body.disabled.includes('profile-off'), 'capture must not adopt a profile-disabled entry')
  assert.ok(!captured.body.disabled.includes('dsh-base'), 'capture never adopts a protected entry')
})

await test('B1b: applyGating never switches a profile-owned entry back off', async function () {
  // No /capture here: capturing rewrites the policy, and the guard is about a
  // policy that already names the profile-owned id (hand-edited or from an
  // older version).
  const world = makeWorld({ state: seeded })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })

  // The user re-enables the plugin in cordis.patch.yml.
  await world.loader.update('profile-off', { disabled: false })
  const applied = await call(world, '/apply', 'POST', {})
  assert.equal(applied.status, 200)
  assert.equal(world.entries.find(function (e) { return e.id === 'profile-off' }).disabled, false,
    'applyGating() must not switch a profile-owned entry back off')
  assert.equal(world.entries.find(function (e) { return e.id === 'beta' }).disabled, true,
    'a policy-owned entry stays off')
})

await test('B3: the diagnostics dump is throttled, then follows a real change', async function () {
  const world = makeWorld({ state: seeded })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })
  const dump = world.dataFile + '.dump.json'

  await call(world, '/state', 'GET')
  const first = fs.statSync(dump).mtimeMs
  await new Promise(function (resolve) { setTimeout(resolve, 1600) })
  await call(world, '/state', 'GET')
  assert.equal(fs.statSync(dump).mtimeMs, first, 'an unchanged snapshot must not rewrite the dump')

  await call(world, '/disabled', 'PUT', { workspaceId: 'ws1', ids: ['beta'] })
  await call(world, '/state', 'GET')
  assert.ok(fs.statSync(dump).mtimeMs > first, 'a changed snapshot must be written')
})

await test('B4: npm metadata cache follows a package.json edit', async function () {
  const world = makeWorld({ state: seeded })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })
  const before = (await call(world, '/state', 'GET')).body
  assert.equal(before.entries.find(function (r) { return r.id === 'alpha' }).version, '1.0.0')

  const file = path.join(world.profile, 'node_modules', 'alpha-pkg', 'package.json')
  fs.writeFileSync(file, JSON.stringify({ name: 'alpha-pkg', version: '2.0.0', description: 'updated' }, null, 2))
  const after = (await call(world, '/state', 'GET')).body
  const row = after.entries.find(function (r) { return r.id === 'alpha' })
  assert.equal(row.version, '2.0.0', 'the cache must invalidate on mtime change')
  assert.equal(row.description, 'updated')
})

await test('B7: a failed state write is surfaced, not swallowed', async function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-host-b7-'))
  fs.writeFileSync(path.join(root, 'blocker'), 'a regular file, not a directory')
  const world = makeWorld({ state: undefined, dataFile: path.join(root, 'blocker', 'workspaces.json') })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })
  await call(world, '/disabled', 'PUT', { workspaceId: 'ws1', ids: ['beta'] })
  const state = (await call(world, '/state', 'GET')).body
  assert.ok(typeof state.lastWriteError === 'string' && state.lastWriteError.length > 0,
    'lastWriteError must describe the failure: ' + JSON.stringify(state.lastWriteError))
})

await test('B8: the arm() 409 guard reads the agent registry live', async function () {
  const world = makeWorld({ state: { version: 1, activeWorkspaceId: null, autoFollow: false, workspaces: {} } })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })

  const free = await call(world, '/arm', 'POST', { workspaceId: 'ws1', armed: true })
  assert.equal(free.status, 200)
  assert.equal(free.body.deferred || null, null, 'arm succeeds when no agent runs')

  world.services.agents = { list: function () { return [{ id: 'a1', status: 'running' }] } }
  const busy = await call(world, '/arm', 'POST', { workspaceId: 'ws1', armed: false })
  assert.equal(busy.status, 200, 'disarm is allowed while an agent runs')
  const refused = await call(world, '/arm', 'POST', { workspaceId: 'ws1', armed: true })
  assert.equal(refused.status, 409, 'arming is refused while an agent runs')
  assert.equal(refused.body.deferred, 'agent-active')
})

await test('B10: /appearance clamps, persists and is reported by /state', async function () {
  const world = makeWorld({ state: { version: 1, activeWorkspaceId: null, autoFollow: false, workspaces: {} } })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })

  const fresh = (await call(world, '/state', 'GET')).body
  assert.equal(fresh.surfaceOpacity, 85, 'a state file with no stored value gets the default')

  const low = await call(world, '/appearance', 'PUT', { surfaceOpacity: -40 })
  assert.equal(low.status, 200)
  assert.equal(low.body.surfaceOpacity, 0, 'below-range values clamp to 0')

  const high = await call(world, '/appearance', 'PUT', { surfaceOpacity: 250.6 })
  assert.equal(high.body.surfaceOpacity, 100, 'above-range values clamp to 100')

  const mid = await call(world, '/appearance', 'PUT', { surfaceOpacity: 42.4 })
  assert.equal(mid.body.surfaceOpacity, 42, 'values round to an integer')

  const state = (await call(world, '/state', 'GET')).body
  assert.equal(state.surfaceOpacity, 42, '/state reports the stored value')
  assert.ok(fs.readFileSync(world.dataFile, 'utf8').includes('"surfaceOpacity": 42'), 'the value is persisted to disk')

  const junk = await call(world, '/appearance', 'PUT', { surfaceOpacity: Number.NaN })
  assert.equal(junk.body.surfaceOpacity, 42, 'a non-finite value leaves the stored value alone')
})

await test('B11: a corrupted stored opacity is clamped on read, not trusted', async function () {
  const world = makeWorld({
    state: { version: 1, activeWorkspaceId: null, autoFollow: false, surfaceOpacity: 999, workspaces: {} },
  })
  host.apply(world.ctx, { gatingEnabled: true, protectIds: [], dataFile: world.dataFile })
  const state = (await call(world, '/state', 'GET')).body
  assert.equal(state.surfaceOpacity, 100, 'a too-large stored value is clamped to 100')
})

let failed = 0
for (const result of results) {
  if (result.ok) {
    console.log('  ok   ' + result.name)
  } else {
    failed++
    console.log('  FAIL ' + result.name)
    console.log('       ' + (result.error && result.error.stack ? result.error.stack.split('\n').slice(0, 4).join('\n       ') : result.error))
  }
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed')
process.exit(failed ? 1 : 0)
