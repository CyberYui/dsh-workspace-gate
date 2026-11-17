/**
 * dsh-workspace-isolate - host half.
 *
 * Lists the plugins and skills visible to each DSH workspace, and (optionally)
 * gates plugins per workspace.
 *
 * Persistence: this plugin NEVER writes cordis.patch.yml (that file belongs to
 * the user and to the profile). The mapping lives in the plugin's own data file,
 * <home>/dsh-workspace-isolate/workspaces.json, and is re-applied on boot and on a
 * slow timer so it survives a profile recompose (HMR).
 */
import { readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'workspace-isolate'

export const inject = ['loader', 'workspaceRegistry', 'skills', 'connection']

const ROUTE = '/api/dsh-workspace-isolate'
const STATE_VERSION = 1

/** Entries that must never be switched off by gating. */
const BUILTIN_PROTECTED = ['dsh-base', 'dsh-web-app', 'workspace-isolate', 'dsh-workspace-isolate']

export const Config = z.object({
  /**
   * Safety lock. When false the plugin only observes and never touches the
   * loader. Gating is inert until a workspace is armed with a non-empty
   * disabled list, so leaving this on is safe.
   */
  gatingEnabled: z.boolean().default(true),
  /** Extra entry ids that may never be disabled by gating. */
  protectIds: z.array(z.string()).default([]),
  /** Overrides the state file location. Empty = <home>/dsh-workspace-isolate/workspaces.json */
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
      console.warn('[workspace-isolate] cannot read state file:', error.message)
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

/**
 * Every spelling a loader row can be known by: the hierarchical id, the id
 * without its include group, the package name, and the package name without
 * its scope or subpath. The built-in protect list ('dsh-web-app',
 * 'workspace-isolate') is matched against this set; service *dependency* matching
 * uses providedServices() instead, because fiber.inject keys are service names
 * and never equal an id or package name.
 */
function candidateNames(id, pkg) {
  const names = new Set()
  if (id) {
    names.add(id)
    const bare = String(id).replace(/^include:/, '')
    if (bare) names.add(bare)
  }
  if (pkg) {
    const raw = String(pkg)
    names.add(raw)
    if (raw.charAt(0) === '@') {
      const scope = raw.split('/')[1]
      if (scope) names.add(scope)
    } else {
      names.add(raw.split('/')[0])
    }
  }
  return names
}

/**
 * The service names this entry provides. cordis records every ctx.provide() on
 * the owning fiber ('fiber.provisions'), and that is the only namespace that
 * matches what bundles declare: inject lists *service* names ('webServer',
 * 'wallpaperEngineHost', ...), while the entry id and the npm package name live
 * in a different namespace, so comparing against them never fires.
 *
 * There is deliberately no fallback to 'ctx.reflect.props'. In cordis that
 * object is ReflectService.props — the whole application's declared-property
 * table, keyed by service name — not this entry's. Reading it here made every
 * bundle that provides nothing appear to provide every service in the process,
 * so nearly the entire plugin list came back 'required by N others' and the
 * panel greyed out almost everything (regression 2026-11-16, fixed by removing
 * the fallback).
 */
function providedServices(entry) {
  const names = []
  const fiber = entry && entry.fiber
  if (!fiber) return names
  const provisions = fiber.provisions
  if (provisions && typeof provisions[Symbol.iterator] === 'function') {
    try {
      for (const impl of provisions) {
        if (impl && typeof impl.name === 'string' && impl.name) names.push(impl.name)
      }
    } catch {
      /* a hostile provision must not break the panel */
    }
  }
  return names
}

/**
 * Entries that inject a service this entry provides. Disabling a required entry
 * would leave those fibers with an unresolved inject, so gating refuses.
 */
function dependencyBlockers(entries, target, cache) {
  const provided = new Set(providedServices(target))
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

function entryRows(loader, allowed, details, isProtected, profileOff) {
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
      // True when cordis.patch.yml — not this plugin — switched the entry off.
      // The label matters: "off (profile)" and "off (this workspace)" are
      // different promises, and the loader reports both as entry.disabled.
      profileOff: Boolean(profileOff && profileOff.has(entry.id)),
      blockers: dependencyBlockers(entries, entry, injectCache),
      // Same predicate applyGating() uses, so the panel cannot offer a switch the
      // host would silently refuse.
      protected: isProtected ? isProtected(entry) : false,
    })
  }
  return rows
}

async function workspaceRows(registry, state, knownIds) {
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
    const disabled = record ? record.disabled.slice() : []
    rows.push({
      workspaceId: workspace.id,
      path: workspace.path,
      title: workspace.title,
      status: status,
      armed: state.activeWorkspaceId === workspace.id,
      disabled: disabled,
      // Ids the policy names that no loader entry has any more (a plugin was
      // renamed or removed). They never take effect, so the panel says so
      // instead of reporting a switch that is not real.
      stale: knownIds ? disabled.filter(function (id) { return !knownIds.has(id) }) : [],
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
  const stateFile = config.dataFile || join(home, 'dsh-workspace-isolate', 'workspaces.json')
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
   * Ids the profile itself switched off in cordis.patch.yml.
   *
   * The loader reports `entry.disabled` for both causes and offers no way to
   * tell them apart, so /capture would otherwise adopt a plugin the user
   * deliberately turned off in their profile. That is not cosmetic: the policy
   * is what applyGating() enforces, so adopting it means the user's own
   * cordis.patch.yml edit gets silently undone on the next arm. The patch file
   * is a flat `- id:` list, so a line scan is enough; cached by mtime.
   */
  const profileOffCache = { mtime: 0, ids: null }
  function profileDisabledIds() {
    let dir = null
    try { dir = ctx.get('profileContext')?.dir ?? null } catch { dir = null }
    if (!dir) return new Set()
    try {
      const file = join(dir, 'cordis.patch.yml')
      const mtime = statSync(file).mtimeMs
      if (profileOffCache.ids && profileOffCache.mtime === mtime) return profileOffCache.ids
      const ids = new Set()
      let current = null
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const top = /^-\s+id:\s*(.+?)\s*$/.exec(line)
        if (top) {
          current = top[1].replace(/^['"]|['"]$/g, '')
          continue
        }
        if (current && /^\s+disabled:\s*true\s*(?:#.*)?$/.test(line)) ids.add(current)
      }
      profileOffCache.mtime = mtime
      profileOffCache.ids = ids
      return ids
    } catch {
      return new Set()
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
  /**
   * Same mtime discipline as profileBundles(): /state is polled every 10s and
   * the panel renders on every poll, so re-reading ~25 package.json files per
   * poll was 25 reads plus 25 JSON parses for a value that only changes when
   * the user installs something. stat() is cheap; the parse is not.
   */
  const packageCache = new Map()
  function packageDetails(dir, names) {
    const details = new Map()
    if (!dir || !names) return details
    for (const name of names) {
      const file = join(dir, 'node_modules', name, 'package.json')
      let mtime = 0
      try { mtime = statSync(file).mtimeMs } catch { /* runtime-provided bundle: not on profile disk */ }
      const cached = packageCache.get(name)
      if (cached && cached.dir === dir && cached.mtime === mtime) {
        if (cached.found) details.set(name, { version: cached.version, description: cached.description })
        continue
      }
      if (!mtime) {
        packageCache.set(name, { dir: dir, mtime: 0, found: false, version: '', description: '' })
        continue
      }
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        const fromNpm = typeof raw.description === 'string' ? raw.description : ''
        const version = typeof raw.version === 'string' ? raw.version : ''
        const description = fromNpm || DESCRIPTION_FALLBACK[name] || ''
        packageCache.set(name, { dir: dir, mtime: mtime, found: true, version: version, description: description })
        details.set(name, { version: version, description: description })
      } catch {
        packageCache.set(name, { dir: dir, mtime: mtime, found: false, version: '', description: '' })
      }
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
  /**
   * `ctx.inject` resolves its service asynchronously, so the callback can run
   * after apply() has returned and leave `agentRegistry` null — which silently
   * disarms the 409 guard that keeps gating away from a running turn. Ask for
   * the service directly too, and re-ask on every check, so a registry that
   * arrives late is still picked up.
   */
  function agents() {
    if (!agentRegistry && typeof ctx.get === 'function') {
      try { agentRegistry = ctx.get('agents') ?? null } catch { /* not registered yet */ }
    }
    return agentRegistry
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agents'], (agentCtx) => {
        agentRegistry = agentCtx.get('agents') ?? agentCtx.agents ?? null
      })
    } else {
      agents()
    }
  } catch (error) {
    console.warn('[workspace-isolate] agent registry unavailable:', error?.message || error)
  }

  function runningAgents() {
    const registry = agents()
    if (!registry || typeof registry.list !== 'function') return []
    try {
      return registry.list().filter(function (agent) { return agent && agent.status === 'running' })
    } catch {
      return []
    }
  }

  /**
   * True when a loader entry must never be switched off. Accepts a loader entry,
   * an entryRows() row, or a bare id from the API: the built-in names are short
   * plugin names ('workspace-isolate', 'dsh-web-app'), while loader ids carry the
   * include group prefix and package names carry a scope and subpath.
   */
  function protect(target) {
    if (!target) return false
    const pkg = typeof target === 'string' ? null : (target.options ? target.options.name : target.name)
    const id = typeof target === 'string' ? target : target.id
    // A row may point at a subpath export ('@deepseek-ai/dsh-web-app/startup')
    // while the built-in names are package names, so collapse before matching.
    const names = candidateNames(id, pkg)
    if (pkg) names.add(packageOf(pkg))
    for (const name of names) {
      if (protectedIds.has(name)) return true
    }
    return false
  }

  /** Last state-file write failure, surfaced through /state so a lost policy is visible. */
  let writeError = null

  async function persist() {
    try {
      await writeState(stateFile, state)
      writeError = null
    } catch (error) {
      writeError = String(error?.message || error)
      console.warn('[workspace-isolate] cannot write state file:', writeError)
    }
  }

  async function applyGating(workspaceId) {
    if (!config.gatingEnabled || !workspaceId) return []
    const record = state.workspaces[workspaceId]
    const wanted = new Set(record ? record.disabled : [])
    const ours = applied.get(workspaceId) || new Set()
    const changes = []
    const entries = [...loader.entries()]
    const profileOff = profileDisabledIds()
    for (const entry of entries) {
      const options = entry.options || {}
      if (options.group) continue
      if (protect(entry)) continue
      // The profile owns this switch (cordis.patch.yml says disabled). Never
      // adopt it: `ours` is exactly what release() re-enables, so adopting a
      // profile-disabled entry would let a later disarm switch it back on and
      // silently override the user's own file.
      if (profileOff.has(entry.id)) continue
      const shouldDisable = wanted.has(entry.id)
      if (shouldDisable && !entry.disabled) {
        // The loader still reports it on, so the switch is missing: either it
        // was never applied or a profile recompose dropped it. Re-asserting
        // here is what lets the 10s replay recover entries the loader rebuilt.
        // An entry the profile itself switched off stays untouched, because
        // adopting it would let release() override cordis.patch.yml later.
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
    const profileOff = profileDisabledIds()
    const known = new Set()
    for (const entry of loader.entries()) known.add(entry.id)
    const workspaces = await workspaceRows(ctx.workspaceRegistry, state, known)
    return {
      gatingEnabled: Boolean(config.gatingEnabled),
      autoFollow: Boolean(state.autoFollow),
      activeWorkspaceId: state.activeWorkspaceId,
      runningAgents: runningAgents().length,
      protectIds: Array.from(protectedIds),
      entries: entryRows(loader, bundles.names, packageDetails(bundles.dir, bundles.names), protect, profileOff),
      workspaces: workspaces,
      // How many policy ids no loader entry has. Non-zero means a plugin was
      // renamed or removed and the policy is promising switches it cannot do.
      policyStale: workspaces.reduce(function (total, row) { return total + row.stale.length }, 0),
      lastWriteError: writeError,
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
  /** Diagnostic-dump throttle: signature of the last payload written, and when. */
  let dumpSig = ''
  let dumpAt = 0
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
        //
        // The panel polls every 10s for as long as it is open, so writing on
        // every response rewrites a full snapshot — every workspace's absolute
        // path included — forever. Write on change, plus a slow heartbeat.
        const sig = JSON.stringify({
          a: snap.activeWorkspaceId,
          g: snap.gatingEnabled,
          w: snap.workspaces.map(function (row) { return [row.workspaceId, row.disabled.length, row.stale.length] }),
          e: snap.entries.length,
        })
        const now = Date.now()
        if (sig !== dumpSig || now - dumpAt > 120000) {
          try { await writeFile(stateFile + '.dump.json', JSON.stringify(snap)) } catch { /* ignore */ }
          dumpSig = sig
          dumpAt = now
        }
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
        // Resolve each incoming id to its loader entry first: protection is
        // decided on the package name, which a bare id does not carry.
        const all = [...loader.entries()]
        const known = new Map()
        for (const entry of all) known.set(entry.id, entry)
        // Blocked entries are refused for the same reason: applyGating() would
        // reject them anyway, so keeping one in the policy would only make the
        // UI report a switch that never took effect.
        const blockerCache = new Map()
        const ignored = []
        const ids = Array.isArray(body.ids)
          ? body.ids.filter(function (item) {
              if (typeof item !== 'string') return false
              // An id with no loader entry can never be switched: it is a typo,
              // or a plugin that was renamed or uninstalled after the policy was
              // written. Storing it would make the panel promise a switch that
              // does not exist, so drop it and report it back.
              const entry = known.get(item)
              if (!entry) { ignored.push(item); return false }
              if (protect(entry)) return false
              return dependencyBlockers(all, entry, blockerCache).length === 0
            })
          : []
        // Entries the profile itself switched off belong to cordis.patch.yml, not
        // to this policy. Keeping one here would let applyGating() turn it back
        // off after the user re-enabled it in their profile.
        const profileOff = profileDisabledIds()
        const adoptable = ids.filter(function (id) {
          if (!profileOff.has(id)) return true
          ignored.push(id)
          return false
        })
        if (!state.workspaces[body.workspaceId]) {
          state.workspaces[body.workspaceId] = { disabled: [], updatedAt: Date.now() }
        }
        state.workspaces[body.workspaceId].disabled = adoptable
        state.workspaces[body.workspaceId].updatedAt = Date.now()
        await persist()
        const changes = state.activeWorkspaceId === body.workspaceId
          ? await applyGating(body.workspaceId)
          : []
        return json({ ok: true, ignored: ignored, changes: changes, state: await snapshot() })
      },
    },
    {
      path: ROUTE + '/capture',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async function (request) {
        const body = await readBody(request)
        if (typeof body.workspaceId !== 'string') return json({ ok: false, error: 'workspaceId is required' }, 400)
        const profileOff = profileDisabledIds()
        const disabled = entryRows(loader, null, null, protect, profileOff)
          .filter(function (row) {
            if (row.group || !row.disabled || protect(row)) return false
            // The profile turned this one off, not the user's per-workspace
            // policy. Capturing it would make applyGating() fight
            // cordis.patch.yml, which is the file the user edits on purpose.
            if (profileOff.has(row.id)) return false
            return true
          })
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
          const file = join(home, 'dsh-workspace-isolate', 'diag.log')
          await mkdir(dirname(file), { recursive: true })
          await appendFile(file, JSON.stringify({ receivedAt: new Date().toISOString(), body: body }) + '\n', 'utf8')
        } catch (error) {
          console.warn('[workspace-isolate] cannot write diag log:', error.message)
        }
        return json({ ok: true })
      },
    },
  ]

  for (const route of routes) {
    try {
      connection.fetch.register(route)
    } catch (error) {
      console.warn('[workspace-isolate] cannot register route', route.path, error?.message || error)
    }
  }

  // Re-assert the armed workspace on boot and on a slow timer. A profile
  // recompose (HMR) rebuilds loader entries and drops in-memory switches.
  ctx.effect(function () {
    const timer = setInterval(function () {
      if (state.activeWorkspaceId && config.gatingEnabled) applyGating(state.activeWorkspaceId)
    }, 10000)
    return function () { clearInterval(timer) }
  }, 'workspace-isolate: state')

  if (state.activeWorkspaceId && config.gatingEnabled) {
    void applyGating(state.activeWorkspaceId)
  }
}