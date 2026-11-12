/**
 * dsh-workspace-gate - host half.
 *
 * Lists the plugins and skills visible to each DSH workspace, and (optionally)
 * gates plugins per workspace.
 *
 * Persistence: this plugin NEVER writes cordis.patch.yml (that file belongs to
 * the user and to the profile). The mapping lives in the plugin's own data file,
 * <home>/dsh-workspace-gate/workspaces.json, and is re-applied on boot and on a
 * slow timer so it survives a profile recompose (HMR).
 */
import { readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'workspace-gate'

export const inject = ['loader', 'workspaceRegistry', 'skills', 'connection']

const ROUTE = '/api/dsh-workspace-gate'
const STATE_VERSION = 1

/** Entries that must never be switched off by gating. */
const BUILTIN_PROTECTED = ['dsh-base', 'dsh-web-app', 'workspace-gate']

export const Config = z.object({
  /**
   * Safety lock. When false the plugin only observes and never touches the
   * loader. Gating is inert until a workspace is armed with a non-empty
   * disabled list, so leaving this on is safe.
   */
  gatingEnabled: z.boolean().default(true),
  /** Extra entry ids that may never be disabled by gating. */
  protectIds: z.array(z.string()).default([]),
  /** Overrides the state file location. Empty = <home>/dsh-workspace-gate/workspaces.json */
  dataFile: z.string().default(''),
})

function emptyState() {
  return { version: STATE_VERSION, activeWorkspaceId: null, autoFollow: false, workspaces: {} }
}

function normalizeState(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  if (typeof raw.activeWorkspaceId === 'string') state.activeWorkspaceId = raw.activeWorkspaceId
  if (typeof raw.autoFollow === 'boolean') state.autoFollow = raw.autoFollow
  const workspaces = raw.workspaces
  if (workspaces && typeof workspaces === 'object') {
    for (const [id, value] of Object.entries(workspaces)) {
      if (!value || typeof value !== 'object') continue
      const disabled = Array.isArray(value.disabled)
        ? value.disabled.filter(function (item) { return typeof item === 'string' })
        : []
      state.workspaces[id] = {
        disabled: disabled,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      }
    }
  }
  return state
}

/**
 * Read once, synchronously, at apply() time. The state file is a few hundred
 * bytes and this removes any window where an async load could clobber a
 * mutation that already happened.
 */
function readState(file) {
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[workspace-gate] cannot read state file:', error.message)
    }
    return emptyState()
  }
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, file)
}

function providedNames(entry) {
  const names = []
  if (entry.id) names.push(entry.id)
  const pkg = entry.options && entry.options.name
  if (pkg) names.push(pkg)
  return names
}

/**
 * Entries that inject a service this entry provides. Disabling a required entry
 * would leave those fibers with an unresolved inject, so gating refuses.
 */
function dependencyBlockers(entries, target, cache) {
  const provided = new Set(providedNames(target))
  if (provided.size === 0) return []
  const blockers = []
  for (const other of entries) {
    if (other === target) continue
    const fiber = other.fiber
    if (!fiber || !fiber.inject) continue
    let keys = cache ? cache.get(other) : undefined
    if (keys === undefined) {
      try {
        keys = Object.keys(fiber.inject)
      } catch {
        continue
      }
      if (cache) cache.set(other, keys)
    }
    if (keys.some(function (name) { return provided.has(name) })) blockers.push(other.id)
  }
  return blockers
}

/**
 * The npm package a loader row belongs to. Loader rows may point at a subpath
 * export (for example '@deepseek-ai/dsh-plugin-manager/tools'), and the user
 * thinks in packages, so collapse to '@scope/pkg' or 'pkg'.
 */
function packageOf(name) {
  if (!name) return ''
  const parts = String(name).split('/')
  return String(name).charAt(0) === '@' ? parts.slice(0, 2).join('/') : parts[0]
}

/** Official runtime bundles are the '@deepseek-ai/*' ones; everything else is community. */
function kindOf(name) {
  if (!name) return 'internal'
  return String(name).indexOf('@deepseek-ai/') === 0 ? 'official' : 'community'
}

function entryRows(loader, allowed, details) {
  const entries = [...loader.entries()]
  // Object.keys(fiber.inject) per pair is O(n^2) key allocations; hoist it.
  const injectCache = new Map()
  const rows = []
  for (const entry of entries) {
    const options = entry.options || {}
    const name = options.name || ''
    const pkg = packageOf(name)
    // The loader exposes every runtime bundle too; 'allowed' keeps the list to
    // the profile's own bundles so the count matches what the user installed.
    if (allowed && pkg && !allowed.has(pkg)) continue
    const detail = pkg && details ? details.get(pkg) : undefined
    rows.push({
      id: entry.id,
      name: name,
      pkg: pkg,
      kind: kindOf(name),
      version: detail ? detail.version : '',
      description: detail ? detail.description : '',
      // Entry ids are hierarchical ('parent:child'); a top-level row is one
      // loader row, children are its own sub-entries.
      topLevel: String(entry.id).indexOf(':') === -1,
      group: Boolean(options.group),
      loaded: entry.fiber !== undefined && !entry.disabled,
      disabled: Boolean(entry.disabled),
      blockers: dependencyBlockers(entries, entry, injectCache),
    })
  }
  return rows
}

async function workspaceRows(registry, state) {
  const rows = []
  let list = []
  try {
    list = registry.list() || []
  } catch {
    list = []
  }
  for (const workspace of list) {
    let status = 'ok'
    try {
      // Workspace.status() is async. Awaiting it is what keeps a Promise out of
      // the client's child list: React throws #31 ("Objects are not valid as a
      // React child (found: object with keys {})") on a non-element object, and
      // a Promise has no enumerable keys.
      status = workspace.status ? await workspace.status() : 'ok'
    } catch {
      status = 'unknown'
    }
    const record = state.workspaces[workspace.id]
    rows.push({
      workspaceId: workspace.id,
      path: workspace.path,
      title: workspace.title,
      status: status,
      armed: state.activeWorkspaceId === workspace.id,
      disabled: record ? record.disabled.slice() : [],
      updatedAt: record ? record.updatedAt : 0,
    })
  }
  return rows
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function apply(ctx, config) {
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const stateFile = config.dataFile || join(home, 'dsh-workspace-gate', 'workspaces.json')
  const loader = ctx.loader
  const protectedIds = new Set(BUILTIN_PROTECTED.concat(config.protectIds || []))

  const state = readState(stateFile)
  /** workspaceId -> Set of entry ids this plugin switched off. */
  const applied = new Map()

  /**
   * The profile's own bundles, read from its package.json. The loader also
   * carries every runtime bundle, so an unfiltered inventory lists ~230 rows
   * for a profile that installed ~25 plugins. Cached by mtime: the file only
   * changes when the user edits their profile.
   */
  let bundleCache = { mtime: 0, dir: null, names: null }
  function profileBundles() {
    let dir = null
    try { dir = ctx.get('profileContext')?.dir ?? null } catch { dir = null }
    if (!dir) return { dir: null, names: null }
    try {
      const file = join(dir, 'package.json')
      const mtime = statSync(file).mtimeMs
      if (bundleCache.dir === dir && bundleCache.mtime === mtime) return { dir: dir, names: bundleCache.names }
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const names = new Set()
      for (const name of Object.keys(raw.dependencies || {})) names.add(name)
      const bundles = raw.dsh && raw.dsh.profile && Array.isArray(raw.dsh.profile.bundles)
        ? raw.dsh.profile.bundles
        : []
      for (const name of bundles) if (typeof name === 'string') names.add(name)
      bundleCache = { mtime: mtime, dir: dir, names: names }
      return { dir: dir, names: names }
    } catch {
      return { dir: dir, names: null }
    }
  }

  /**
   * A few bundles ship no npm description at all. aegis is a multi-host method
   * pack, so its package.json is pure metadata. Without a fallback its card
   * would show a bare package name where every other row has a sentence.
   */
  const DESCRIPTION_FALLBACK = {
    'aegis': 'Aegis method pack: goal framing, first-principles review, skill routing, architecture decision records and entropy governance for long agent tasks.',
  }

  /**
   * npm metadata for the installed bundles. The loader rows carry no
   * description, so this is what lets the UI say what a plugin actually does
   * instead of repeating its name.
   */
  function packageDetails(dir, names) {
    const details = new Map()
    if (!dir || !names) return details
    for (const name of names) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'))
        const fromNpm = typeof raw.description === 'string' ? raw.description : ''
        details.set(name, {
          version: typeof raw.version === 'string' ? raw.version : '',
          description: fromNpm || DESCRIPTION_FALLBACK[name] || '',
        })
      } catch { /* runtime-provided bundle: not on profile disk */ }
    }
    return details
  }

  /**
   * Live agents, when the registry is reachable. Optional on purpose: the
   * plugin must still load on a host without it, and `ctx.inject` waits for a
   * service instead of failing, so an absent registry simply leaves the guard
   * inert rather than breaking the bundle.
   */
  let agentRegistry = null
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agents'], (agentCtx) => {
        agentRegistry = agentCtx.get('agents') ?? agentCtx.agents ?? null
      })
    }
  } catch (error) {
    console.warn('[workspace-gate] agent registry unavailable:', error?.message || error)
  }

  function runningAgents() {
    if (!agentRegistry || typeof agentRegistry.list !== 'function') return []
    try {
      return agentRegistry.list().filter(function (agent) { return agent && agent.status === 'running' })
    } catch {
      return []
    }
  }

  function protect(id) {
    return protectedIds.has(id)
  }

  async function persist() {
    try {
      await writeState(stateFile, state)
    } catch (error) {
      console.warn('[workspace-gate] cannot write state file:', error.message)
    }
  }

  async function applyGating(workspaceId) {
    if (!config.gatingEnabled || !workspaceId) return []
    const record = state.workspaces[workspaceId]
    const wanted = new Set(record ? record.disabled : [])
    const ours = applied.get(workspaceId) || new Set()
    const changes = []
    const entries = [...loader.entries()]
    for (const entry of entries) {
      const options = entry.options || {}
      if (options.group) continue
      if (protect(entry.id)) continue
      const shouldDisable = wanted.has(entry.id)
      if (shouldDisable && !ours.has(entry.id)) {
        // Never adopt a plugin the profile itself switched off: re-enabling it
        // later would silently override the user's cordis.patch.yml.
        if (entry.disabled) continue
        const blockers = dependencyBlockers(entries, entry)
        if (blockers.length) {
          changes.push({ id: entry.id, action: 'disable', ok: false, blockedBy: blockers })
          continue
        }
        try {
          await loader.update(entry.id, { disabled: true })
          ours.add(entry.id)
          changes.push({ id: entry.id, action: 'disable', ok: true })
        } catch (error) {
          changes.push({ id: entry.id, action: 'disable', ok: false, error: String(error?.message || error) })
        }
      } else if (!shouldDisable && ours.has(entry.id)) {
        try {
          await loader.update(entry.id, { disabled: false })
          ours.delete(entry.id)
          changes.push({ id: entry.id, action: 'enable', ok: true })
        } catch (error) {
          changes.push({ id: entry.id, action: 'enable', ok: false, error: String(error?.message || error) })
        }
      }
    }
    applied.set(workspaceId, ours)
    return changes
  }

  /**
   * Switch the entries this plugin turned off back on. Only entries recorded in
   * `applied` are touched, so a plugin the profile itself switched off in
   * cordis.patch.yml is never re-enabled here.
   */
  async function release(workspaceId) {
    const ours = applied.get(workspaceId)
    if (!ours || ours.size === 0) {
      applied.delete(workspaceId)
      return []
    }
    const changes = []
    for (const id of ours) {
      try {
        await loader.update(id, { disabled: false })
        changes.push({ id: id, action: 'enable', ok: true })
      } catch (error) {
        changes.push({ id: id, action: 'enable', ok: false, error: String(error?.message || error) })
      }
    }
    applied.delete(workspaceId)
    return changes
  }

  /**
   * Arm or disarm one workspace. Only one workspace is armed at a time, because
   * the loader is process-wide: arming applies that workspace's policy to the
   * whole process, and switching releases the previous workspace first.
   */
  /**
   * Arm or disarm one workspace.
   *
   * Refused while any agent is running: the loader is process-wide, so flipping
   * plugin state mid-turn could remove a tool or skill the running turn is about
   * to use. The caller reports `deferred: 'agent-active'` instead.
   */
  async function arm(workspaceId, armed) {
    if (armed && runningAgents().length > 0) {
      return { deferred: 'agent-active', running: runningAgents().length, changes: [] }
    }
    const changes = []
    if (state.activeWorkspaceId && state.activeWorkspaceId !== workspaceId) {
      changes.push(...await release(state.activeWorkspaceId))
    }
    if (armed) {
      state.activeWorkspaceId = workspaceId
      if (!state.workspaces[workspaceId]) {
        state.workspaces[workspaceId] = { disabled: [], updatedAt: Date.now() }
      }
      await persist()
      changes.push(...await applyGating(workspaceId))
    } else if (state.activeWorkspaceId === workspaceId) {
      state.activeWorkspaceId = null
      await persist()
      changes.push(...await release(workspaceId))
    }
    return { deferred: null, running: runningAgents().length, changes: changes }
  }

  async function skillsFor(workspaceId) {
    const rows = await workspaceRows(ctx.workspaceRegistry, state)
    const workspace = rows.find(function (row) { return row.workspaceId === workspaceId })
    if (!workspace) return { workspaceId: workspaceId, skills: [], complete: false }
    try {
      const result = await ctx.skills.list({ cwd: workspace.path })
      const skills = Array.isArray(result) ? result : (result && result.skills) || []
      return {
        workspaceId: workspaceId,
        path: workspace.path,
        skills: skills.map(function (skill) {
          return {
            name: skill.name,
            description: skill.description || '',
            source: skill.source || '',
            provider: skill.provider || '',
            path: skill.path || '',
            whenToUse: skill.whenToUse || '',
          }
        }),
        complete: Array.isArray(result) ? true : Boolean(result && result.complete),
      }
    } catch (error) {
      return { workspaceId: workspaceId, skills: [], complete: false, error: String(error?.message || error) }
    }
  }

  async function snapshot() {
    const bundles = profileBundles()
    return {
      gatingEnabled: Boolean(config.gatingEnabled),
      autoFollow: Boolean(state.autoFollow),
      activeWorkspaceId: state.activeWorkspaceId,
      runningAgents: runningAgents().length,
      protectIds: Array.from(protectedIds),
      entries: entryRows(loader, bundles.names, packageDetails(bundles.dir, bundles.names)),
      workspaces: await workspaceRows(ctx.workspaceRegistry, state),
    }
  }

  async function readBody(request) {
    try {
      return await request.json()
    } catch {
      return {}
    }
  }

  const connection = ctx.get('connection') ?? ctx.connection
  const routes = [
    {
      path: ROUTE + '/state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async function () {
        const snap = await snapshot()
        // Diagnostics: the client's React child list is only as clean as this
        // payload, so keep the last snapshot on disk for offline inspection.
        // Written beside the state file so a test with its own dataFile cannot
        // touch the real profile.
        try { await writeFile(stateFile + '.dump.json', JSON.stringify(snap)) } catch { /* ignore */ }
        return json(snap)
      },
    },
    {
      path: ROUTE + '/skills',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const id = new URL(request.url).searchParams.get('workspaceId') || ''
        return json(await skillsFor(id))
      },
    },
    {
      path: ROUTE + '/arm',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const body = await readBody(request)
        if (typeof body.workspaceId !== 'string') return json({ ok: false, error: 'workspaceId is required' }, 400)
        const result = await arm(body.workspaceId, Boolean(body.armed))
        if (result.deferred) {
          return json({ ok: false, error: result.deferred, deferred: result.deferred, running: result.running, changes: [] }, 409)
        }
        return json({ ok: true, activeWorkspaceId: state.activeWorkspaceId, changes: result.changes })
      },
    },
    {
      path: ROUTE + '/follow',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const body = await readBody(request)
        if (typeof body.enable === 'boolean') {
          state.autoFollow = body.enable
          await persist()
        }
        const base = { ok: true, autoFollow: Boolean(state.autoFollow) }
        if (typeof body.workspaceId !== 'string') return json(base)
        if (!state.autoFollow) return json({ ...base, deferred: 'follow-off', changes: [] })
        const result = await arm(body.workspaceId, true)
        if (result.deferred) {
          return json({ ...base, deferred: result.deferred, running: result.running, changes: [] })
        }
        return json({ ...base, activeWorkspaceId: state.activeWorkspaceId, changes: result.changes })
      },
    },
    {
      path: ROUTE + '/disabled',
      methods: ['PUT'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const body = await readBody(request)
        if (typeof body.workspaceId !== 'string') return json({ ok: false, error: 'workspaceId is required' }, 400)
        // Protected entries are never managed by gating, so they are not
        // written into the policy either; otherwise the UI would show them as
        // switched off while the loader keeps them on.
        const ids = Array.isArray(body.ids)
          ? body.ids.filter(function (item) { return typeof item === 'string' && !protect(item) })
          : []
        if (!state.workspaces[body.workspaceId]) {
          state.workspaces[body.workspaceId] = { disabled: [], updatedAt: Date.now() }
        }
        state.workspaces[body.workspaceId].disabled = ids
        state.workspaces[body.workspaceId].updatedAt = Date.now()
        await persist()
        const changes = state.activeWorkspaceId === body.workspaceId
          ? await applyGating(body.workspaceId)
          : []
        return json({ ok: true, changes: changes, state: await snapshot() })
      },
    },
    {
      path: ROUTE + '/capture',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const body = await readBody(request)
        if (typeof body.workspaceId !== 'string') return json({ ok: false, error: 'workspaceId is required' }, 400)
        const disabled = entryRows(loader)
          .filter(function (row) { return !row.group && row.disabled && !protect(row.id) })
          .map(function (row) { return row.id })
        if (!state.workspaces[body.workspaceId]) {
          state.workspaces[body.workspaceId] = { disabled: [], updatedAt: Date.now() }
        }
        state.workspaces[body.workspaceId].disabled = disabled
        state.workspaces[body.workspaceId].updatedAt = Date.now()
        await persist()
        const changes = state.activeWorkspaceId === body.workspaceId
          ? await applyGating(body.workspaceId)
          : []
        return json({ ok: true, disabled: disabled, changes: changes })
      },
    },
    {
      path: ROUTE + '/apply',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async function () {
        const changes = await applyGating(state.activeWorkspaceId)
        return json({ ok: true, activeWorkspaceId: state.activeWorkspaceId, changes: changes })
      },
    },
    {
      // Diagnostics seam. The client posts what it can see of the slot registry
      // (whether the 'main' entry registered, whether it is still live, and any
      // entry crash). Appended to a file because the renderer console is not
      // reachable from here. Never throws: diagnostics must not break the UI.
      path: ROUTE + '/diag',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const body = await readBody(request)
        try {
          const file = join(home, 'dsh-workspace-gate', 'diag.log')
          await mkdir(dirname(file), { recursive: true })
          await appendFile(file, JSON.stringify({ receivedAt: new Date().toISOString(), body: body }) + '\n', 'utf8')
        } catch (error) {
          console.warn('[workspace-gate] cannot write diag log:', error.message)
        }
        return json({ ok: true })
      },
    },
  ]

  for (const route of routes) {
    try {
      connection.fetch.register(route)
    } catch (error) {
      console.warn('[workspace-gate] cannot register route', route.path, error?.message || error)
    }
  }

  // Re-assert the armed workspace on boot and on a slow timer. A profile
  // recompose (HMR) rebuilds loader entries and drops in-memory switches.
  ctx.effect(function () {
    const timer = setInterval(function () {
      if (state.activeWorkspaceId && config.gatingEnabled) applyGating(state.activeWorkspaceId)
    }, 10000)
    return function () { clearInterval(timer) }
  }, 'workspace-gate: state')

  if (state.activeWorkspaceId && config.gatingEnabled) {
    void applyGating(state.activeWorkspaceId)
  }
}
