/**
 * dsh-workspace-gate - client half.
 *
 * Two surfaces over the same inventory:
 *  - a sidebar panel: pick ANY workspace, see its plugins and skills, switch
 *    plugins off for it;
 *  - a chip in the conversation header: the CURRENT workspace only, opening a
 *    popover with the same switches. This is the per-workspace surface; the
 *    sidebar stays the cross-workspace management view.
 *
 * Plugins are grouped by npm package (loader rows may point at a subpath export
 * such as '@deepseek-ai/dsh-plugin-manager/tools') and split into the official
 * '@deepseek-ai/*' runtime bundles and everything community-built, because the
 * raw loader has ~230 rows while the user only installed ~20 plugins.
 *
 * The chip also offers "follow": when it is on, changing the current workspace
 * re-asserts that workspace's policy. The host refuses while any agent is
 * running, because the loader is process-wide.
 *
 * No build step: this is the browser artefact directly, loaded by the harness
 * module loader under the package id below.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const createElement = React.createElement
    // React throws #31 ("Objects are not valid as a React child") when a plain
    // object reaches the child list. Every field below comes from host JSON, so
    // one unexpected object would blank the whole panel. This wrapper keeps
    // rendering by substituting a readable placeholder, and records the first
    // offending child so the cause is visible in the diagnostics log.
    const h = function (type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]
        if (child === null || child === undefined || typeof child !== 'object') continue
        if (Array.isArray(child) || child.$$typeof !== undefined) continue
        if (child.type !== undefined && child.props !== undefined) continue
        try {
          const bug = {
            type: typeof type === 'string' ? type : ((type && type.name) || 'component'),
            ctor: (child.constructor && child.constructor.name) || typeof child,
            keys: Object.keys(child).slice(0, 24),
            json: safeString(JSON.stringify(child)).slice(0, 600),
            at: new Date().toISOString(),
          }
          window.__workspaceGateChildBug = bug
          postDiag({ kind: 'child-bug', bug: bug })
        } catch { /* diagnostics must never break rendering */ }
        children[i] = '[object ' + ((child.constructor && child.constructor.name) || 'Object') + ']'
      }
      return createElement.apply(React, [type, props].concat(children))
    }
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-workspace-gate'
    // Portals need react-dom, which the DSH client module loader registers just
    // like react. Detected rather than assumed so a host without it degrades to
    // the in-header popover instead of failing to load.
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') createPortal = ReactDOM.createPortal
    } catch { createPortal = null }
    const PANEL_ID = 'workspace-gate'
    const PANEL_ORDER = 95
    const CHIP_ID = 'workspace-gate-chip'
    const CHIP_ORDER = 5
    const HEADER_SLOT = 'conversation.session.header.utilities'
    const ROUTE = 'api/dsh-workspace-gate'

    const DICT = {
      en: {
        'meta.title': 'Workspace gate',
        'meta.description': 'Per-workspace plugin and skill inventory.',
        'entry.label': 'Workspace gate',
        'title': 'Workspace gate',
        'subtitle': 'Plugins and skills visible to each workspace.',
        'workspace': 'Workspace',
        'path': 'Path',
        'status': 'Status',
        'armed': 'Gated',
        'tab.plugins': 'Plugins',
        'tab.skills': 'Skills',
        'filter.all': 'All',
        'filter.community': 'Community',
        'filter.official': 'Official',
        'badge.official': 'official',
        'badge.community': 'community',
        'col.name': 'Name',
        'col.state': 'State',
        'col.entries': 'Entries',
        'col.source': 'Source',
        'col.description': 'Description',
        'action.save': 'Save and apply',
        'action.capture': 'Capture current',
        'action.clear': 'Clear',
        'action.refresh': 'Refresh',
        'action.arm': 'Gate this workspace',
        'action.unarm': 'Stop gating',
        'action.all.on': 'Enable all',
        'action.all.off': 'Disable all',
        'state.loaded': 'loaded',
        'state.disabled': 'off',
        'state.protected': 'protected',
        'state.group': 'group',
        'state.required': 'required',
        'state.profileOff': 'off (profile)',
        'state.idle': 'idle',
        'state.entries': 'entries',
        'notice.saved': 'Saved.',
        'notice.captured': 'Captured the current loader state.',
        'notice.cleared': 'Cleared.',
        'notice.armed': 'Gating this workspace.',
        'notice.unarmed': 'Gating released.',
        'notice.applied': 'Applied.',
        'error.load': 'Could not load state.',
        'error.save': 'Could not save.',
        'empty.workspaces': 'No workspace registered yet.',
        'empty.skills': 'No skill visible from this workspace directory.',
        'empty.plugins': 'No plugin entry loaded.',
        'empty.filter': 'Nothing in this group.',
        'hint.gating':
          'Unticking a plugin switches it off for this workspace only. The mapping is stored in the plugin data file, never in cordis.patch.yml.',
        'hint.protected': 'Core entries cannot be switched off.',
        'hint.required': 'Entries that other loaded entries inject cannot be switched off.',
        'hint.filter': 'Official = the @deepseek-ai/* runtime bundles. Community = everything you installed.',
        'checking': 'Checking...',
        'chip.title': 'Plugins and skills visible in this workspace',
        'chip.close': 'Close',
        'chip.follow.off': 'Follow workspace',
        'chip.follow.on': 'Following',
        'chip.follow.on.done': 'Following the current workspace.',
        'chip.follow.off.done': 'Follow stopped.',
        'chip.follow.hint': 'Applies this workspace switches whenever the current workspace changes.',
        'diag.title': 'Diagnostics',
        'diag.main': 'main slot rows',
        'diag.live': 'live rows',
        'diag.crash': 'last crash',
        'diag.none': 'no crash reported',
        'diag.panelCrash': 'panel rendering crashed',
        'explorer.loading': 'Reading the skill explorer...',
        'explorer.empty': 'No skill in this workspace directory.',
        'explorer.enabled': 'enabled',
        'explorer.disabled': 'disabled',
        'explorer.on': 'Model may invoke this skill',
        'explorer.off': 'Model may not invoke this skill',
        'explorer.locked': 'read-only',
        'explorer.when': 'When to use',
        'explorer.state.editable': 'editable',
        'explorer.state.provider-file': 'provider file',
        'explorer.state.virtual': 'virtual',
      },
      zh: {
        'meta.title': '工作区门控',
        'meta.description': '按工作区查看插件与技能，并可按工作区关闭插件。',
        'entry.label': '工作区门控',
        'title': '工作区门控',
        'subtitle': '每个工作区能看到哪些插件与技能。',
        'workspace': '工作区',
        'path': '路径',
        'status': '状态',
        'armed': '门控中',
        'tab.plugins': '插件',
        'tab.skills': '技能',
        'filter.all': '全部',
        'filter.community': '社区',
        'filter.official': '官方',
        'badge.official': '官方',
        'badge.community': '社区',
        'col.name': '名称',
        'col.state': '状态',
        'col.entries': '条目',
        'col.source': '来源',
        'col.description': '说明',
        'action.save': '保存并应用',
        'action.capture': '捕获当前状态',
        'action.clear': '清空',
        'action.refresh': '刷新',
        'action.arm': '对本工作区启用门控',
        'action.unarm': '停止门控',
        'action.all.on': '全部开启',
        'action.all.off': '全部关闭',
        'state.loaded': '已加载',
        'state.disabled': '已关闭',
        'state.protected': '受保护',
        'state.group': '分组',
        'state.required': '被依赖',
        'state.profileOff': '已关闭（配置）',
        'state.idle': '未加载',
        'state.entries': '个条目',
        'notice.saved': '已保存。',
        'notice.captured': '已捕获当前 loader 状态。',
        'notice.cleared': '已清空。',
        'notice.armed': '已对本工作区启用门控。',
        'notice.unarmed': '已停止门控。',
        'notice.applied': '已应用。',
        'error.load': '无法读取状态。',
        'error.save': '保存失败。',
        'empty.workspaces': '还没有登记任何工作区。',
        'empty.skills': '该工作区目录下看不到技能。',
        'empty.plugins': '没有已加载的插件条目。',
        'empty.filter': '该分组下没有内容。',
        'hint.gating': '取消勾选只对当前工作区关闭该插件。映射存在插件自己的数据文件里，不会写 cordis.patch.yml。',
        'hint.protected': '核心条目不可关闭。',
        'hint.required': '被其他已加载条目依赖的条目不可关闭。',
        'hint.filter': '官方 = @deepseek-ai/* 运行时自带插件；社区 = 你自己安装的插件。',
        'checking': '正在检查...',
        'chip.title': '当前工作区可见的插件与技能',
        'chip.close': '关闭',
        'chip.follow.off': '跟随工作区',
        'chip.follow.on': '跟随中',
        'chip.follow.on.done': '已开启跟随：切换工作区时自动套用门控。',
        'chip.follow.off.done': '已停止跟随。',
        'chip.follow.hint': '切换工作区时自动套用该工作区的插件开关。',
        'diag.title': '诊断信息',
        'diag.main': 'main 槽位条目',
        'diag.live': '生效条目',
        'diag.crash': '最近崩溃',
        'diag.none': '未报告崩溃',
        'diag.panelCrash': '面板渲染崩溃',
        'explorer.loading': '正在读取技能中心...',
        'explorer.empty': '该工作区目录下没有技能。',
        'explorer.enabled': '已启用',
        'explorer.disabled': '已停用',
        'explorer.on': '模型可调用该技能',
        'explorer.off': '模型不可调用该技能',
        'explorer.locked': '只读',
        'explorer.when': '何时使用',
        'explorer.state.editable': '可编辑',
        'explorer.state.provider-file': '提供者文件',
        'explorer.state.virtual': '虚拟',
      },
    }

    let tt = function (key) { return key }

    // Host theme tokens. DSH defines this alias set on `body` (light) and on
    // `body[data-ds-dark-theme]` (dark), so a value that resolves through them
    // follows the reader's chosen theme with no media query of our own. Each
    // comma fallback is only for a host older than the token, and is written to
    // read correctly in either theme.
    const C = {
      fg: 'var(--dsw-alias-label-primary,#1f2328)',
      fg2: 'var(--dsw-alias-label-secondary,#57606a)',
      fgMuted: 'var(--dsw-alias-label-tertiary,#57606a)',
      fgFaint: 'var(--dsw-alias-label-dimmed,#8b949e)',
      border: 'var(--dsw-alias-border-l2,rgba(127,127,177,.22))',
      borderStrong: 'var(--dsw-alias-border-l3,rgba(127,127,177,.34))',
      bg: 'var(--dsw-alias-bg-layer-1,#ffffff)',
      bg2: 'var(--dsw-alias-bg-layer-2,#f6f8fa)',
      bgHover: 'var(--dsw-alias-interactive-bg-hover,rgba(127,127,177,.08))',
      bgSolid: 'var(--dsw-alias-interactive-bg-hover-solid,#e6e9ee)',
      accent: 'var(--dsw-alias-state-business-primary,#1f6feb)',
      accentSoft: 'var(--dsw-alias-interactive-bg-hover-accent,rgba(31,111,235,.14))',
      onAccent: 'var(--dsw-alias-label-primary-foreground,#ffffff)',
      danger: 'var(--dsw-alias-state-error-primary,#cf222e)',
      success: 'var(--dsw-alias-state-success-primary,#1a7f37)',
      thumb: 'var(--dsw-alias-switch-thumb,#ffffff)',
      mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace',
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, gap: 8, padding: 12, boxSizing: 'border-box', fontSize: 13, color: C.fg, overflow: 'hidden' },
      header: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
      title: { fontWeight: 600, fontSize: 15 },
      grow: { flex: 1, minWidth: 0 },
      subtitle: { color: C.fgMuted, fontSize: 12, lineHeight: 1.5, flexShrink: 0 },
      card: { border: '1px solid ' + C.border, borderRadius: 10, padding: 10 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid ' + C.border },
      rowLast: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' },
      name: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mono: { fontFamily: C.mono, fontSize: 11, color: C.fgMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pill: { fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid ' + C.border, color: C.fgMuted, whiteSpace: 'nowrap' },
      pillOn: { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: C.accentSoft, color: C.accent, whiteSpace: 'nowrap' },
      btn: { fontSize: 12, padding: '4px 10px', borderRadius: 7, border: '1px solid ' + C.borderStrong, background: C.bg, color: 'inherit', cursor: 'pointer', flexShrink: 0 },
      btnPrimary: { fontSize: 12, padding: '4px 10px', borderRadius: 7, border: '1px solid transparent', background: C.accent, color: C.onAccent, cursor: 'pointer', flexShrink: 0 },
      seg: { display: 'inline-flex', padding: 2, gap: 2, borderRadius: 8, border: '1px solid ' + C.border, background: C.bg2, flexShrink: 0 },
      segBtn: { fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: C.fgMuted, cursor: 'pointer' },
      segBtnOn: { fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: C.bgSolid, color: C.fg, cursor: 'pointer', fontWeight: 500 },
      actions: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 },
      banner: { fontSize: 12, padding: '6px 8px', borderRadius: 7, flexShrink: 0 },
      error: { color: C.danger },
      notice: { color: C.success },
      hint: { fontSize: 11, color: C.fgMuted, lineHeight: 1.5 },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontSize: 11, color: C.fgMuted, fontWeight: 500, padding: '3px 6px 3px 0' },
      td: { padding: '3px 6px 3px 0', verticalAlign: 'top' },
      scroll: { overflow: 'auto', flex: 1, minHeight: 0, minWidth: 0 },
      section: { fontSize: 12, fontWeight: 600, margin: '10px 0 4px', flexShrink: 0 },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8 },
      cardTitle: { fontFamily: C.mono, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      cardDesc: { fontSize: 11, lineHeight: 1.35, color: C.fgMuted, marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
      cardVer: { fontSize: 10, color: C.fgMuted, fontFamily: C.mono },
      skillTh: { textAlign: 'left', fontSize: 11, color: C.fgMuted, fontWeight: 500, padding: '2px 6px 2px 0' },
      skillTd: { padding: '2px 6px 2px 0', verticalAlign: 'top', fontSize: 11, lineHeight: 1.35 },
      skillDesc: { padding: '2px 6px 2px 0', verticalAlign: 'top', fontSize: 11, lineHeight: 1.35, color: C.fgMuted },
      cardMeta: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' },
      entryRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '1px solid ' + C.border },
      entryName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { fontSize: 10, color: C.fgMuted, width: 12, textAlign: 'center', flexShrink: 0 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, lineHeight: '18px', padding: '1px 8px', borderRadius: 999, border: '1px solid ' + C.border, background: C.bg2, color: C.fgMuted, cursor: 'pointer', maxWidth: 280 },
      chipText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 },
      chipMeta: { whiteSpace: 'nowrap' },
      popover: { position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 360, maxWidth: '80vw', maxHeight: '72vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: C.bg, border: '1px solid ' + C.border, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.16)', zIndex: 60, padding: 12, textAlign: 'left' },
      popHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexShrink: 0 },
      popTitle: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 },
      popPath: { fontFamily: C.mono, fontSize: 10, color: C.fgMuted, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 },
      diag: { marginTop: 10, flexShrink: 0 },
      diagBody: { fontFamily: C.mono, fontSize: 10, color: C.fgMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 },
    }

    function PanelIcon(props) {
      const size = props && props.size || 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 21V8l9-5 9 5v13' }),
        h('path', { d: 'M9 21v-6h6v6' }),
        h('path', { d: 'M3 21h18' }))
    }

    // ---------------------------------------------------------------- helpers

    /** '@scope/pkg/sub/path' -> '@scope/pkg'; 'pkg/sub' -> 'pkg'. */
    function pkgOf(name) {
      if (!name) return ''
      const parts = String(name).split('/')
      return String(name).charAt(0) === '@' ? parts.slice(0, 2).join('/') : parts[0]
    }

    /** Official runtime bundles are '@deepseek-ai/*'; everything else is community. */
    function kindOf(name) {
      if (!name) return 'internal'
      return String(name).indexOf('@deepseek-ai/') === 0 ? 'official' : 'community'
    }

    function kindOfSkill(skill) {
      const source = String((skill && (skill.provider || skill.source)) || '')
      if (!source) return 'community'
      return source.indexOf('@deepseek-ai/') === 0 ? 'official' : 'community'
    }

    function groupPackages(entries) {
      const groups = new Map()
      for (const entry of entries) {
        const name = (entry && entry.name) || ''
        const pkg = (entry && entry.pkg) || pkgOf(name)
        const key = pkg || '(internal)'
        if (!groups.has(key)) {
          groups.set(key, {
            pkg: key,
            kind: (entry && entry.kind) || (pkg ? kindOf(name) : 'internal'),
            description: (entry && entry.description) || '',
            version: (entry && entry.version) || '',
            entries: [],
          })
        }
        const group = groups.get(key)
        if (!group.description && entry && entry.description) group.description = entry.description
        if (!group.version && entry && entry.version) group.version = entry.version
        group.entries.push(entry)
      }
      return Array.from(groups.values()).sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === 'community' ? -1 : 1
        return a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0
      })
    }

    function safeString(value) {
      try { return String(value) } catch { return '<unprintable>' }
    }

    function safeError(error) {
      if (!error) return null
      return {
        name: safeString(error.name),
        message: safeString(error.message),
        stack: safeString(error.stack).slice(0, 2000),
      }
    }

    async function send(relative, method, body) {
      const url = new URL(relative, document.baseURI).toString()
      const init = { method: method, headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(url, init)
      let payload = {}
      try {
        payload = await response.json()
      } catch (error) {
        payload = {}
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.message || 'HTTP ' + response.status)
      }
      return payload
    }

    /** Best-effort: diagnostics must never break rendering. */
    async function postDiag(payload) {
      try {
        const url = new URL(ROUTE + '/diag', document.baseURI).toString()
        await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      } catch { /* ignore */ }
    }

    /**
     * The session the shell is currently showing. uiWorkspace.selection is the
     * host's persisted "current session" store. ctx.get is defensive because a
     * host without that service must still render the rest of the panel.
     */
    function useCurrentSessionId(ctx, injectedSessionId) {
      const [sessionId, setSessionId] = useState(injectedSessionId)
      useEffect(function () {
        let alive = true
        function read() {
          let next = undefined
          try {
            const service = ctx.get('uiWorkspace')
            const selection = service && service.selection
            const snapshot = selection && typeof selection.getSnapshot === 'function'
              ? selection.getSnapshot()
              : undefined
            next = snapshot ? snapshot.sessionId : undefined
          } catch {
            next = undefined
          }
          if (alive) setSessionId(next === undefined ? null : next)
        }
        read()
        let unsubscribe = function () {}
        try {
          const service = ctx.get('uiWorkspace')
          const selection = service && service.selection
          if (selection && typeof selection.subscribe === 'function') {
            unsubscribe = selection.subscribe(read)
          }
        } catch { /* optional service */ }
        // Backstop: the snapshot store is an in-memory read, so a slow poll
        // costs nothing and keeps the chip correct on a host whose store does
        // not expose subscribe.
        const timer = setInterval(read, 1000)
        return function () {
          alive = false
          clearInterval(timer)
          try { unsubscribe() } catch { /* ignore */ }
        }
      }, [ctx])
      return sessionId
    }

    /** Workspace rows from the host workspace feed, including sessionIds. */
    function useWorkspaceItems(ctx) {
      const [snapshot, setSnapshot] = useState(undefined)
      useEffect(function () {
        let alive = true
        function read() {
          let next
          try {
            const service = ctx.get('workspaces')
            const store = service && service.list
            next = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined
          } catch {
            next = undefined
          }
          if (alive) setSnapshot(next)
        }
        read()
        let unsubscribe = function () {}
        try {
          const service = ctx.get('workspaces')
          const store = service && service.list
          if (store && typeof store.subscribe === 'function') unsubscribe = store.subscribe(read)
        } catch { /* optional service */ }
        return function () { alive = false; try { unsubscribe() } catch { /* ignore */ } }
      }, [ctx])
      return snapshot
    }

    function useSkills(workspaceId) {
      const [skills, setSkills] = useState(undefined)
      useEffect(function () {
        if (!workspaceId) {
          setSkills(null)
          return
        }
        let alive = true
        setSkills(undefined)
        send(ROUTE + '/skills?workspaceId=' + encodeURIComponent(workspaceId), 'GET')
          .then(function (payload) { if (alive) setSkills(payload.skills || []) })
          .catch(function () { if (alive) setSkills([]) })
        return function () { alive = false }
      }, [workspaceId])
      return skills
    }

    /**
     * The skill explorer is a separate plugin with a richer per-workspace skill
     * model (bundled / project / user / runtime sources, frontmatter toggles).
     * It exposes a loopback-only HTTP API, so the panel can talk to it directly
     * instead of duplicating its registry. Three states: `undefined` while the
     * request is in flight, `null` when the plugin is absent or refused the
     * request (caller falls back to the plain list), otherwise the payload.
     */
    function useSkillExplorer(explorerPath, nonce) {
      const [payload, setPayload] = useState(undefined)
      useEffect(function () {
        if (!explorerPath) { setPayload(null); return }
        let alive = true
        setPayload(undefined)
        fetch(new URL('api/dsh-skill-explorer/list?cwd=' + encodeURIComponent(explorerPath), document.baseURI).toString())
          .then(function (response) { return response.ok ? response.json() : null })
          .then(function (body) {
            if (!alive) return
            setPayload(body && Array.isArray(body.groups) ? body : null)
          })
          .catch(function () { if (alive) setPayload(null) })
        return function () { alive = false }
      }, [explorerPath, nonce])
      return payload
    }

    // ------------------------------------------------------------- plug-in list

    function isLocked(entry, protectIds) {
      if (entry.group) return true
      if ((entry.blockers || []).length > 0) return true
      return (protectIds || []).indexOf(entry.id) !== -1
    }

    function entryState(entry, off, protectIds) {
      if (entry.group) return { key: 'state.group', locked: true }
      if ((protectIds || []).indexOf(entry.id) !== -1) return { key: 'state.protected', locked: true }
      if ((entry.blockers || []).length > 0) {
        return { key: 'state.required', locked: true, count: entry.blockers.length }
      }
      if (off.indexOf(entry.id) !== -1) return { key: 'state.disabled', locked: false }
      if (entry.disabled) return { key: 'state.profileOff', locked: true }
      if (entry.loaded) return { key: 'state.loaded', locked: false }
      return { key: 'state.idle', locked: false }
    }

    function StatePill(props) {
      const state = props.state
      const label = state.count > 1 ? tt(state.key) + ' x' + state.count : tt(state.key)
      return h('span', { style: state.key === 'state.loaded' ? S.pillOn : S.pill }, label)
    }

    function PluginCard(props) {
      const group = props.group
      const off = props.off || []
      const protectIds = props.protectIds || []
      const onSetDisabled = props.onSetDisabled
      const collapsed = props.collapsed
      const onToggleCollapsed = props.onToggleCollapsed
      const entries = group.entries || []
      const switchable = entries.filter(function (entry) { return !isLocked(entry, protectIds) })
      const offCount = switchable.filter(function (entry) { return off.indexOf(entry.id) !== -1 }).length
      const allOn = switchable.length === 0 || offCount === 0
      const title = group.pkg || '(internal)'
      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('input', {
            type: 'checkbox',
            checked: allOn,
            disabled: switchable.length === 0,
            title: allOn ? tt('action.all.off') : tt('action.all.on'),
            onChange: function () {
              const next = off.slice()
              for (const entry of switchable) {
                const index = next.indexOf(entry.id)
                if (allOn) {
                  if (index === -1) next.push(entry.id)
                } else if (index !== -1) {
                  next.splice(index, 1)
                }
              }
              onSetDisabled(next)
            },
          }),
          h('div', { style: { ...S.grow, minWidth: 0 } },
            h('div', { style: S.cardTitle, title: title }, title),
            group.description ? h('div', { style: S.cardDesc }, group.description) : null,
            h('div', { style: S.cardMeta },
              h('span', { style: S.pill }, group.kind === 'official' ? tt('badge.official') : tt('badge.community')),
              group.version ? h('span', { style: { ...S.pill, fontFamily: C.mono } }, group.version) : null,
              h('span', { style: S.pill }, entries.length + ' ' + tt('state.entries')),
              offCount > 0 ? h('span', { style: S.pillOn }, offCount + ' ' + tt('state.disabled')) : null)),
          h('button', {
            style: S.btn,
            title: collapsed ? '+' : '-',
            onClick: function () { onToggleCollapsed(group.pkg) },
          }, h('span', { style: S.chevron }, collapsed ? '+' : '-'))),
        collapsed
          ? null
          : h('div', { style: { marginTop: 6 } }, entries.map(function (entry) {
              const state = entryState(entry, off, protectIds)
              return h('div', { key: entry.id, style: S.entryRow },
                h('input', {
                  type: 'checkbox',
                  checked: off.indexOf(entry.id) === -1,
                  disabled: state.locked,
                  onChange: function () {
                    const next = off.slice()
                    const index = next.indexOf(entry.id)
                    if (index === -1) next.push(entry.id)
                    else next.splice(index, 1)
                    onSetDisabled(next)
                  },
                }),
                h('span', { style: { ...S.entryName, ...S.mono, fontSize: 11 } }, entry.name || entry.id),
                h(StatePill, { state: state }))
            })))
    }

    function PluginCards(props) {
      const groups = props.groups || []
      if (groups.length === 0) return h('div', { style: S.hint }, tt('empty.filter'))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        groups.map(function (group) {
          return h(PluginCard, {
            key: group.pkg,
            group: group,
            off: props.off,
            protectIds: props.protectIds,
            collapsed: props.collapsed.indexOf(group.pkg) !== -1,
            onToggleCollapsed: props.onToggleCollapsed,
            onSetDisabled: props.onSetDisabled,
          })
        }))
    }

    function SkillsCard(props) {
      const skills = props.skills
      if (skills === null || skills === undefined) return h('div', { style: S.hint }, tt('checking'))
      if (skills.length === 0) return h('div', { style: S.hint }, tt('empty.skills'))
      const official = skills.filter(function (skill) { return kindOfSkill(skill) === 'official' })
      const community = skills.filter(function (skill) { return kindOfSkill(skill) !== 'official' })
      const renderRow = function (skill) {
        return h('tr', { key: skill.name + ':' + (skill.provider || skill.source || '') },
          h('td', { style: { ...S.skillTd, ...S.name } }, skill.name),
          h('td', { style: S.skillTd }, h('span', { style: S.pill }, kindOfSkill(skill) === 'official' ? tt('badge.official') : tt('badge.community'))),
          h('td', { style: { ...S.skillTd, ...S.mono } }, skill.provider || skill.source || ''),
          h('td', { style: S.skillDesc }, skill.description || ''))
      }
      return h('table', { style: S.table },
        h('thead', null, h('tr', null,
          h('th', { style: S.skillTh }, tt('col.name')),
          h('th', { style: S.skillTh }, tt('col.state')),
          h('th', { style: S.skillTh }, tt('col.source')),
          h('th', { style: S.skillTh }, tt('col.description')))),
        h('tbody', null,
          community.length > 0 || official.length === 0
            ? community.map(renderRow)
            : null,
          official.map(renderRow)))
    }

    /**
     * Rich per-workspace skill list backed by the skill explorer plugin's API.
     * The card owns its fetch so the tab body can stay mounted while hidden and
     * still report a fresh count.
     */
    function ExplorerSkillsCard(props) {
      const explorerPath = props.path
      const [reloadKey, setReloadKey] = useState(0)
      const payload = useSkillExplorer(explorerPath, reloadKey)
      const [collapsed, setCollapsed] = useState({})
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')

      const groups = (payload && Array.isArray(payload.groups)) ? payload.groups : []
      const total = groups.reduce(function (sum, group) {
        return sum + (Array.isArray(group.skills) ? group.skills.length : 0)
      }, 0)

      useEffect(function () {
        if (props.onCount) props.onCount(payload === null ? null : total)
      }, [total, payload])

      if (payload === null) return h(SkillsCard, { skills: props.fallback })
      if (payload === undefined) return h('div', { style: S.hint }, tt('explorer.loading'))
      if (!groups.length) return h('div', { style: S.hint }, tt('explorer.empty'))

      const hasPath = function (skill) { return typeof skill.path === 'string' && skill.path.length > 0 }
      const isEnabled = function (skill) {
        return skill.modelInvocable !== false && skill.userInvocable !== false
      }
      const toggle = function (skill, enabled) {
        const providerOnly = !hasPath(skill) && skill.fileState === 'provider-file'
        setBusy(skill.name)
        setError('')
        setNotice('')
        send(
          providerOnly ? 'api/dsh-skill-explorer/set-provider-enabled' : 'api/dsh-skill-explorer/set-enabled',
          'POST',
          providerOnly
            ? { name: skill.name, provider: skill.provider, enabled: enabled }
            : { name: skill.name, path: skill.path, enabled: enabled }
        ).then(function () {
          setNotice(skill.name + (enabled ? ' ' + tt('explorer.enabled') : ' ' + tt('explorer.disabled')))
          setReloadKey(function (value) { return value + 1 })
        }).catch(function (err) {
          setError(String((err && err.message) || err))
        }).finally(function () { setBusy('') })
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        notice ? h('div', { style: { ...S.hint, color: C.success } }, notice) : null,
        error ? h('div', { style: { ...S.hint, color: C.danger } }, error) : null,
        groups.map(function (group) {
          const key = group.key || group.title || 'group'
          const skills = Array.isArray(group.skills) ? group.skills : []
          const isCollapsed = !!collapsed[key]
          return h('div', { key: key, style: S.card },
            h('div', {
              style: { ...S.cardHead, cursor: 'pointer' },
              onClick: function () {
                setCollapsed(function (prev) {
                  const next = {}
                  for (const name in prev) next[name] = prev[name]
                  next[key] = !prev[key]
                  return next
                })
              },
            },
              h('span', { style: S.chevron }, isCollapsed ? '+' : '-'),
              h('span', { style: { ...S.cardTitle, fontSize: 12 } }, group.title || key),
              h('span', { style: { ...S.pill, fontSize: 10 } }, String(skills.length)),
              h('span', { style: S.grow }),
              group.hint
                ? h('span', { style: { ...S.hint, fontSize: 10, flexShrink: 0, maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.hint)
                : null),
            isCollapsed
              ? null
              : h('div', { style: { marginTop: 4 } }, skills.map(function (skill) {
                  const enabled = isEnabled(skill)
                  const togglable = hasPath(skill) || skill.fileState === 'provider-file'
                  return h('div', { key: skill.name + ':' + (skill.provider || skill.source || ''), style: { ...S.entryRow, alignItems: 'flex-start' } },
                    h('div', { style: { ...S.grow, minWidth: 0 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' } },
                        h('span', { style: { fontWeight: 500, fontSize: 12 } }, skill.name),
                        skill.fileState ? h('span', { style: { ...S.pill, fontSize: 10 } }, tt('explorer.state.' + skill.fileState)) : null,
                        skill.provider ? h('span', { style: { ...S.pill, fontSize: 10 } }, skill.provider) : null),
                      skill.description ? h('div', { style: { ...S.skillDesc, marginTop: 2 } }, skill.description) : null,
                      skill.whenToUse ? h('div', { style: { ...S.hint, fontSize: 10, marginTop: 1 } }, tt('explorer.when') + ': ' + skill.whenToUse) : null),
                    togglable
                      ? h('button', {
                          role: 'switch',
                          'aria-checked': enabled ? 'true' : 'false',
                          disabled: busy === skill.name,
                          title: enabled ? tt('explorer.on') : tt('explorer.off'),
                          onClick: function () { if (!busy) toggle(skill, !enabled) },
                          style: {
                            flexShrink: 0, marginTop: 2, width: 30, height: 16, borderRadius: 8, border: 'none',
                            padding: 0, cursor: busy === skill.name ? 'default' : 'pointer',
                            background: enabled ? C.success : C.fgFaint,
                          },
                        }, h('span', {
                          style: {
                            display: 'block', width: 12, height: 12, borderRadius: 6, background: C.thumb,
                            marginLeft: enabled ? 16 : 2, transition: 'margin-left .12s ease',
                          },
                        }))
                      : h('span', { style: { ...S.pill, fontSize: 10, flexShrink: 0 } }, tt('explorer.locked')))
                })))
        }))
    }

    /**
     * The tabbed body shared by the sidebar panel and the header popover.
     * Tab and filter state is local to the surface, so opening the popover does
     * not disturb the sidebar panel and vice versa.
     */
    function GateBody(props) {
      const state = props.state
      const off = props.off || []
      const skills = props.skills
      const [explorerCount, setExplorerCount] = useState(null)
      const protectIds = (state && state.protectIds) || []
      const [tab, setTab] = useState('plugins')
      const [filter, setFilter] = useState('community')
      // Official runtime bundles start collapsed: they are the host's own
      // machinery, and the community plugins are what the user came to see.
      const [collapsed, setCollapsed] = useState(function () {
        const entries = (props.state && Array.isArray(props.state.entries)) ? props.state.entries : []
        return groupPackages(entries)
          .filter(function (group) { return group.kind === 'official' })
          .map(function (group) { return group.pkg })
      })
      const diag = useSlotDiag()

      const entries = (state && Array.isArray(state.entries)) ? state.entries : []
      const groups = useMemo(function () { return groupPackages(entries) }, [entries])
      const visible = useMemo(function () {
        if (filter === 'all') return groups
        return groups.filter(function (group) { return group.kind === filter })
      }, [groups, filter])

      const officialCount = useMemo(function () {
        return groups.filter(function (group) { return group.kind === 'official' }).length
      }, [groups])
      const communityCount = groups.length - officialCount

      const onToggleCollapsed = function (pkg) {
        setCollapsed(function (prev) {
          return prev.indexOf(pkg) === -1 ? prev.concat([pkg]) : prev.filter(function (item) { return item !== pkg })
        })
      }

      // When the skill explorer answers, its count is authoritative (it sees
      // bundled / user / runtime sources the plain host route does not);
      // otherwise fall back to the host's own list.
      const skillCount = explorerCount !== null
        ? explorerCount
        : (skills === null || skills === undefined ? null : skills.length)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flex: 1 } },
        h(DiagBlock, { info: diag }),
        h('div', { style: S.actions },
          h('div', { style: S.seg },
            h('button', { style: tab === 'plugins' ? S.segBtnOn : S.segBtn, onClick: function () { setTab('plugins') } },
              tt('tab.plugins') + (groups.length ? ' ' + groups.length : '')),
            h('button', { style: tab === 'skills' ? S.segBtnOn : S.segBtn, onClick: function () { setTab('skills') } },
              tt('tab.skills') + (skillCount === null ? '' : ' ' + skillCount))),
          h('span', { style: S.grow }),
          tab === 'plugins'
            ? h('div', { style: S.seg },
                h('button', { style: filter === 'all' ? S.segBtnOn : S.segBtn, onClick: function () { setFilter('all') } }, tt('filter.all')),
                h('button', { style: filter === 'community' ? S.segBtnOn : S.segBtn, onClick: function () { setFilter('community') } }, tt('filter.community') + ' ' + communityCount),
                h('button', { style: filter === 'official' ? S.segBtnOn : S.segBtn, onClick: function () { setFilter('official') } }, tt('filter.official') + ' ' + officialCount))
            : null),
        h('div', { style: { ...S.hint, flexShrink: 0 } }, tt('hint.filter')),
        h('div', { style: S.scroll },
          // Both bodies stay mounted: the hidden one keeps its data warm so the
          // tab badge and the explorer's toggles are current the moment the
          // user switches tabs.
          h('div', { style: { display: tab === 'plugins' ? 'block' : 'none' } },
            h(PluginCards, {
              groups: visible,
              off: off,
              protectIds: protectIds,
              collapsed: collapsed,
              onToggleCollapsed: onToggleCollapsed,
              onSetDisabled: props.onSetDisabled,
            })),
          h('div', { style: { display: tab === 'skills' ? 'block' : 'none' } },
            props.explorerPath
              ? h(ExplorerSkillsCard, {
                  path: props.explorerPath,
                  fallback: skills,
                  onCount: setExplorerCount,
                })
              : h('div', { style: S.card }, h(SkillsCard, { skills: skills })))))
    }

    // ------------------------------------------------------------- diagnostics

    /**
     * The sidebar panel used to open blank. Two candidates: the 'main' entry was
     * never registered, or it registered and was then abdicated after a render
     * crash. This boundary plus the host's diag seam tells them apart.
     */
    const PANEL_SLOT_KEY = 'main'

    function DiagBlock(props) {
      const info = props.info
      if (!info) return null
      const lines = [
        tt('diag.main') + ': ' + (info.rawCount === undefined ? '?' : info.rawCount) +
          (info.liveCount === undefined ? '' : ' / ' + tt('diag.live') + ': ' + info.liveCount),
      ]
      if (info.keys && info.keys.length) lines.push('  ' + info.keys.join(', '))
      lines.push(tt('diag.crash') + ': ' + (info.crash ? (info.crash.name + ': ' + info.crash.message) : tt('diag.none')))
      return h('details', { style: S.diag },
        h('summary', { style: { fontSize: 11, color: C.fgMuted, cursor: 'pointer' } }, tt('diag.title')),
        h('div', { style: S.diagBody }, lines.join('\n')))
    }

    // ---------------------------------------------------------------- surfaces

    /**
     * Reads the shell's own view of the 'main' slot. When the sidebar panel comes
     * up blank the chip popover still renders, so this block is the one place
     * that can say whether the entry was abdicated after a render crash.
     */
    function useSlotDiag() {
      const [info, setInfo] = useState(null)
      useEffect(function () {
        let alive = true
        Promise.resolve().then(function () {
          if (!alive) return
          let settled
          try {
            const slots = window.__workspaceGateSlots
            const raw = slots && typeof slots.entries === 'function' ? slots.entries(PANEL_SLOT_KEY) : []
            const live = slots && typeof slots.entriesOfSlot === 'function' ? slots.entriesOfSlot(PANEL_SLOT_KEY) : []
            settled = {
            rawCount: Array.isArray(raw) ? raw.length : undefined,
            liveCount: Array.isArray(live) ? live.length : undefined,
            keys: (Array.isArray(raw) ? raw : []).map(function (entry) {
              return (entry && entry.options && entry.options.key) || '?'
            }),
            liveKeys: (Array.isArray(live) ? live : []).map(function (entry) {
              return (entry && entry.options && entry.options.key) || '?'
            }),
            crash: window.__workspaceGateCrash || null,
            }
          } catch (error) {
            settled = { rawCount: undefined, liveCount: undefined, keys: [], liveKeys: [], crash: safeError(error) }
          }
          setInfo(settled)
          // The sidebar panel renders nothing at all when its entry is gone, so
          // the chip popover is the only surface that can still report this.
          postDiag({ kind: 'slot-diag', diag: settled })
        })
        return function () { alive = false }
      }, [])
      return info
    }

    /**
     * The shell abdicates a 'main' entry as soon as its render throws, which
     * leaves a completely empty panel. Catching it here keeps the surface
     * visible, shows the real error, and reports it to the host diag log.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        const crash = safeError(error) || { name: 'Error', message: 'unknown' }
        crash.at = new Date().toISOString()
        try { window.__workspaceGateCrash = crash } catch { /* ignore */ }
        postDiag({ kind: 'panel-crash', crash: crash })
      }
      render() {
        const error = this.state && this.state.error
        if (error) {
          return h('div', { style: S.root },
            h('div', { style: S.header }, h(PanelIcon, { size: 18 }), h('span', { style: S.title }, tt('title'))),
            h('div', { style: { ...S.banner, ...S.error } },
              tt('diag.panelCrash') + ': ' + (error.message || String(error))),
            h(DiagBlock, { info: { rawCount: undefined, liveCount: undefined, keys: [], crash: safeError(error) } }))
        }
        return this.props.children
      }
    }

    function PanelRoot() {
      return h(PanelBoundary, null, h(Panel))
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [selected, setSelected] = useState('')
      const [disabled, setDisabled] = useState([])
      const [skills, setSkills] = useState(null)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async function () {
        try {
          const payload = await send(ROUTE + '/state', 'GET')
          setState(payload)
          setSelected(function (prev) {
            const workspaces = (payload && Array.isArray(payload.workspaces)) ? payload.workspaces : []
            if (prev && workspaces.some(function (row) { return row.workspaceId === prev })) return prev
            return (payload && payload.activeWorkspaceId) || (workspaces[0] && workspaces[0].workspaceId) || ''
          })
          setError('')
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [])

      useEffect(function () { load() }, [load])

      const selectedPath = useMemo(function () {
        const rows = (state && Array.isArray(state.workspaces)) ? state.workspaces : []
        const row = rows.find(function (item) { return item.workspaceId === selected })
        return row && typeof row.path === 'string' ? row.path : ''
      }, [state, selected])

      useEffect(function () {
        if (!selected) {
          setDisabled([])
          setSkills(null)
          return
        }
        const row = state && Array.isArray(state.workspaces)
          ? state.workspaces.find(function (item) { return item.workspaceId === selected })
          : null
        setDisabled(row && Array.isArray(row.disabled) ? row.disabled.slice() : [])
        setSkills(undefined)
        send(ROUTE + '/skills?workspaceId=' + encodeURIComponent(selected), 'GET')
          .then(function (payload) { setSkills(payload.skills || []) })
          .catch(function () { setSkills([]) })
      }, [selected, state])

      useEffect(function () {
        if (!notice) return
        const timer = setTimeout(function () { setNotice('') }, 4000)
        return function () { clearTimeout(timer) }
      }, [notice])

      if (!state) {
        return h('div', { style: S.root },
          h('div', { style: S.header }, h(PanelIcon, { size: 18 }), h('span', { style: S.title }, tt('title'))),
          error ? h('div', { style: { ...S.banner, ...S.error } }, String(error)) : h('div', { style: S.hint }, tt('checking')))
      }

      const workspaces = Array.isArray(state.workspaces) ? state.workspaces : []
      const activeWorkspace = workspaces.find(function (row) { return row.workspaceId === state.activeWorkspaceId })
      const run = async function (task, message) {
        setBusy(true)
        setError('')
        try {
          const payload = await task()
          if (payload && payload.deferred === 'agent-active') {
            setError('An agent is running; the loader is process-wide, so the change waits for it to finish.')
          } else if (message) {
            setNotice(message)
          }
          await load()
          return payload
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: S.root },
        h('div', { style: S.header },
          h(PanelIcon, { size: 18 }),
          h('span', { style: S.title }, tt('title')),
          h('span', { style: S.grow }),
          h('button', { style: S.btn, onClick: function () { load() } }, tt('action.refresh'))),
        h('div', { style: S.subtitle }, tt('subtitle')),
        error ? h('div', { style: { ...S.banner, ...S.error } }, String(error)) : null,
        notice ? h('div', { style: { ...S.banner, ...S.notice } }, String(notice)) : null,
        h('div', { style: S.scroll },
          h('div', { style: S.section }, tt('workspace') + ' (' + workspaces.length + ')'),
          workspaces.length === 0
            ? h('div', { style: S.hint }, tt('empty.workspaces'))
            : workspaces.map(function (row) {
                const active = row.workspaceId === selected
                return h('div', { key: row.workspaceId, style: { ...S.rowLast, cursor: 'pointer', paddingLeft: 8, paddingRight: 8, borderRadius: 8, background: active ? C.bgHover : 'transparent' }, onClick: function () { setSelected(row.workspaceId) } },
                  h('div', { style: { ...S.grow, minWidth: 0 } },
                    h('div', { style: S.name }, row.title || row.workspaceId),
                    h('div', { style: S.mono }, row.path)),
                  row.armed ? h('span', { style: S.pillOn }, tt('armed')) : null,
                  h('span', { style: S.pill }, row.status || 'ok'))
              }),
          h('div', { style: { ...S.card, marginTop: 10 } },
            h('div', { style: S.actions },
              h('button', { style: S.btnPrimary, disabled: busy, onClick: function () {
                  run(function () {
                    return send(ROUTE + '/disabled', 'PUT', { workspaceId: selected, ids: disabled })
                      .then(function () {
                        const row = state.workspaces.find(function (item) { return item.workspaceId === selected })
                        if (!row || !row.armed) return send(ROUTE + '/arm', 'POST', { workspaceId: selected, armed: true })
                      })
                  }, tt('notice.saved'))
                } }, tt('action.save')),
              h('button', { style: S.btn, disabled: busy, onClick: function () {
                  run(function () { return send(ROUTE + '/capture', 'POST', { workspaceId: selected }) }, tt('notice.captured'))
                } }, tt('action.capture')),
              h('button', { style: S.btn, disabled: busy, onClick: function () {
                  run(function () { return send(ROUTE + '/disabled', 'PUT', { workspaceId: selected, ids: [] }) }, tt('notice.cleared'))
                } }, tt('action.clear')),
              activeWorkspace && activeWorkspace.workspaceId === selected
                ? h('button', { style: S.btn, disabled: busy, onClick: function () {
                    run(function () { return send(ROUTE + '/arm', 'POST', { workspaceId: selected, armed: false }) }, tt('notice.unarmed'))
                  } }, tt('action.unarm'))
                : null,
              h('span', { style: S.grow }),
              h('button', { style: S.btn, disabled: busy, onClick: function () {
                  run(function () { return send(ROUTE + '/apply', 'POST') }, tt('notice.applied'))
                } }, tt('action.refresh'))),
            h('div', { style: { ...S.hint, margin: '6px 0' } }, tt('hint.gating')),
            h(GateBody, {
              state: state,
              off: disabled,
              skills: skills,
              explorerPath: selectedPath,
              onSetDisabled: setDisabled,
            }))))
    }

    /**
     * The per-workspace surface: one chip in the conversation header, scoped to
     * the session being viewed. Opens a popover with the switches; the sidebar
     * panel remains the cross-workspace management view.
     */
    function HeaderChip(props) {
      const ctx = props && props.ctx
      const [state, setState] = useState(null)
      const [open, setOpen] = useState(false)
      const [disabled, setDisabled] = useState([])
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const injectedSessionId = props && props.sessionId
      const sessionId = useCurrentSessionId(ctx, injectedSessionId)
      const workspaceSnapshot = useWorkspaceItems(ctx)
      const items = workspaceSnapshot && Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
      const workspaceId = !sessionId
        ? ''
        : (items.find(function (item) {
            return Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)
          }) || {}).workspaceId || ''
      const skills = useSkills(workspaceId)
      const workspacePath = useMemo(function () {
        const rows = (state && Array.isArray(state.workspaces)) ? state.workspaces : []
        const row = rows.find(function (item) { return item.workspaceId === workspaceId })
        return row && typeof row.path === 'string' ? row.path : ''
      }, [state, workspaceId])

      const load = useCallback(async function () {
        try {
          const payload = await send(ROUTE + '/state', 'GET')
          setState(payload)
          setError('')
          return payload
        } catch (err) {
          setError(String(err.message || err))
          return null
        }
      }, [])

      useEffect(function () { load() }, [load])

      // Adopt the saved policy when the workspace changes. Deliberately NOT
      // keyed on `state`: the 10s poll and the post-save reload both replace
      // `state`, and re-deriving `disabled` from it would throw away edits
      // the user has just made in the open popover.
      useEffect(function () {
        if (!workspaceId) {
          setDisabled([])
          return
        }
        let alive = true
        send(ROUTE + '/state', 'GET')
          .then(function (payload) {
            if (!alive) return
            const row = (((payload && payload.workspaces) || [])).find(function (item) { return item.workspaceId === workspaceId })
            setDisabled(row && Array.isArray(row.disabled) ? row.disabled.slice() : [])
          })
          .catch(function () {})
        return function () { alive = false }
      }, [workspaceId])

      useEffect(function () {
        const timer = setInterval(load, 10000)
        return function () { clearInterval(timer) }
      }, [load])

      const autoFollow = Boolean(state && state.autoFollow)
      useEffect(function () {
        if (!autoFollow || !workspaceId) return
        const timer = setTimeout(function () {
          send(ROUTE + '/follow', 'POST', { workspaceId: workspaceId })
            .then(function () { load() })
            .catch(function () {})
        }, 400)
        return function () { clearTimeout(timer) }
      }, [autoFollow, workspaceId, load])

      useEffect(function () {
        if (!notice) return
        const timer = setTimeout(function () { setNotice('') }, 4000)
        return function () { clearTimeout(timer) }
      }, [notice])

      const anchorRef = useRef(null)
      const popRef = useRef(null)
      const [pos, setPos] = useState(null)

      // The conversation root is overflow:hidden while a session is active, so a
      // popover absolutely positioned inside the header would be clipped. Portalled
      // to <body> with fixed coordinates it escapes every ancestor clip.
      useEffect(function () {
        if (!open) {
          setPos(null)
          return
        }
        const anchor = anchorRef.current
        if (!anchor) return
        function place() {
          const rect = anchor.getBoundingClientRect()
          const width = Math.min(360, window.innerWidth - 16)
          const minLeft = 8
          const maxLeft = Math.max(minLeft, window.innerWidth - width - 8)
          let left = rect.right - width
          if (left < minLeft) left = minLeft
          if (left > maxLeft) left = maxLeft
          setPos({ left: left, top: rect.bottom + 8, width: width })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return function () {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      useEffect(function () {
        if (!open) return
        function onDown(event) {
          const anchor = anchorRef.current
          const pop = popRef.current
          if (anchor && anchor.contains(event.target)) return
          if (pop && pop.contains(event.target)) return
          setOpen(false)
        }
        function onKey(event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      if (!workspaceId) return null

      const workspaces = (state && state.workspaces) || []
      const row = workspaces.find(function (item) { return item.workspaceId === workspaceId })
      const entries = (state && Array.isArray(state.entries)) ? state.entries : []
      const off = disabled || []
      const visibleCount = entries.filter(function (entry) {
        return !entry.group && !entry.disabled && off.indexOf(entry.id) === -1
      }).length
      const armed = Boolean(row && row.armed)
      const followOn = Boolean(state && state.autoFollow)

      const run = async function (task, message) {
        setBusy(true)
        setError('')
        try {
          const payload = await task()
          if (payload && payload.deferred === 'agent-active') {
            setError('An agent is running; the loader is process-wide, so the change waits for it to finish.')
          } else if (message) {
            setNotice(message)
          }
          await load()
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      const popover = h('div', {
        ref: popRef,
        style: createPortal && pos
          ? { ...S.popover, position: 'fixed', left: pos.left, top: pos.top, right: 'auto', width: pos.width, maxWidth: 'none' }
          : S.popover,
      },
      h('div', { style: S.popHeader },
        h('span', { style: S.popTitle }, (row && row.title) || workspaceId),
        h('span', { style: S.grow }),
        h('button', { style: S.btn, onClick: function () { setOpen(false) } }, tt('chip.close'))),
      h('div', { style: S.popPath }, workspaceId),
      error ? h('div', { style: { ...S.banner, ...S.error } }, String(error)) : null,
      notice ? h('div', { style: { ...S.banner, ...S.notice } }, String(notice)) : null,
      h('div', { style: S.actions },
        h('button', {
          style: armed ? S.btn : S.btnPrimary,
          disabled: busy,
          onClick: function () {
            run(function () {
              return send(ROUTE + '/arm', 'POST', { workspaceId: workspaceId, armed: !armed })
            }, armed ? tt('notice.unarmed') : tt('notice.armed'))
          },
        }, armed ? tt('action.unarm') : tt('action.arm')),
        h('button', {
          style: S.btn,
          disabled: busy,
          title: tt('chip.follow.hint'),
          onClick: function () {
            run(function () {
              return send(ROUTE + '/follow', 'POST', { enable: !followOn, workspaceId: workspaceId })
            }, followOn ? tt('chip.follow.off.done') : tt('chip.follow.on.done'))
          },
        }, followOn ? tt('chip.follow.on') : tt('chip.follow.off')),
        h('span', { style: S.grow }),
        h('button', {
          style: S.btnPrimary,
          disabled: busy,
          onClick: function () {
            run(function () {
              return send(ROUTE + '/disabled', 'PUT', { workspaceId: workspaceId, ids: off })
                .then(function () {
                  const current = ((state && state.workspaces) || []).find(function (item) { return item.workspaceId === workspaceId })
                  if (!current || !current.armed) {
                    return send(ROUTE + '/arm', 'POST', { workspaceId: workspaceId, armed: true })
                  }
                })
            }, tt('notice.saved'))
          },
        }, tt('action.save'))),
      state
        ? h(GateBody, {
            state: state,
            off: off,
            skills: skills,
            explorerPath: workspacePath,
            onSetDisabled: setDisabled,
          })
        : h('div', { style: S.hint }, tt('checking'))
      )

      return h('div', { ref: anchorRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          style: S.chip,
          title: tt('chip.title'),
          onClick: function () { setOpen(function (value) { return !value }) },
        },
          h(PanelIcon, { size: 13 }),
          h('span', { style: S.chipText }, (row && row.title) || workspaceId),
          h('span', { style: S.chipMeta }, tt('skills') + ' ' + (skills === undefined || skills === null ? '...' : skills.length) + ' / ' + tt('plugins') + ' ' + visibleCount),
          armed ? h('span', { style: S.pillOn }, tt('armed')) : null),
        open ? (createPortal ? createPortal(popover, document.body) : popover) : null)
    }

    const inject = ['slots', 'locale', 'layout']

    function apply(ctx) {
      ctx.effect(
        () => {
          try {
            return ctx.locale.register(NS, DICT)
          } catch (error) {
            console.warn('[workspace-gate] locale registration failed:', error)
            return () => {}
          }
        },
        'workspace-gate: dictionaries',
      )

      try {
        const bound = ctx.locale.bind(NS)
        tt = (key) => bound(key)
      } catch (error) {
        console.warn('[workspace-gate] locale bind failed:', error)
      }

      try {
        const slots = ctx.get && ctx.get('slots') ? ctx.get('slots') : ctx.slots
        if (!slots) {
          console.warn('[workspace-gate] slots service unavailable; surfaces not registered')
          return
        }

        // Expose the registry for the panel's diagnostics block, and record the
        // first entry crash the shell reports. Both are best-effort.
        try { window.__workspaceGateSlots = slots } catch { /* ignore */ }
        try {
          ctx.effect(function () {
            if (typeof slots.onEntryError !== 'function') return function () {}
            return slots.onEntryError(function (slotKey, entry, error, info) {
              const crash = {
                slotKey: safeString(slotKey),
                entryKey: entry && entry.options && entry.options.key,
                entryId: entry && entry.options && entry.id,
                abdicated: Boolean(info && info.abdicated),
                error: safeError(error),
                at: new Date().toISOString(),
              }
              try { window.__workspaceGateCrash = crash } catch { /* ignore */ }
              postDiag({ kind: 'entry-error', crash: crash })
            })
          }, 'workspace-gate: entry errors')
        } catch (error) {
          console.warn('[workspace-gate] entry-error hook unavailable:', error)
        }

        slots.inject('sidebar.panellist', () =>
          slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => tt('entry.label') },
            PanelIcon,
          ),
        )
        slots.inject('main', () =>
          slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ ctx }) }, PanelRoot),
        )
        // The per-workspace surface. list + session scope means it renders in the
        // header of every conversation, and several plugins may share it.
        slots.inject(HEADER_SLOT, () =>
          slots.register(
            {
              name: HEADER_SLOT,
              id: CHIP_ID,
              order: CHIP_ORDER,
              label: () => tt('title'),
              inject: (sessionId) => ({ ctx, sessionId }),
            },
            HeaderChip,
          ),
        )
        // Last-resort capture: an inject() callback that throws is rethrown by
        // the shell inside a microtask, so window.onerror never sees it.
        try {
          window.addEventListener('error', function (event) {
            postDiag({ kind: 'window-error', crash: safeError((event && event.error) || (event && event.message) || event) })
          })
          window.addEventListener('unhandledrejection', function (event) {
            postDiag({ kind: 'unhandled-rejection', crash: safeError(event && event.reason) })
          })
        } catch { /* ignore */ }
        // Report the main-slot state after the shell has registered and
        // rendered. This is the only report that survives a blank panel, where
        // neither the panel nor the chip popover may ever mount.
        try {
          const reportSlots = function () {
            try {
              const raw = typeof slots.entries === 'function' ? slots.entries('main') : []
              const live = typeof slots.entriesOfSlot === 'function' ? slots.entriesOfSlot('main') : []
              postDiag({
                kind: 'slot-diag',
                diag: {
                  rawCount: Array.isArray(raw) ? raw.length : undefined,
                  liveCount: Array.isArray(live) ? live.length : undefined,
                  keys: (Array.isArray(raw) ? raw : []).map(function (entry) {
                    return (entry && entry.options && entry.options.key) || '?'
                  }),
                  liveKeys: (Array.isArray(live) ? live : []).map(function (entry) {
                    return (entry && entry.options && entry.options.key) || '?'
                  }),
                  crash: window.__workspaceGateCrash || null,
                },
              })
            } catch (error) {
              postDiag({ kind: 'slot-diag', diag: { crash: safeError(error) } })
            }
          }
          setTimeout(reportSlots, 4000)
          setTimeout(reportSlots, 15000)
        } catch { /* ignore */ }
        postDiag({ kind: 'apply', surfaces: ['sidebar.panellist', 'main', HEADER_SLOT] })
      } catch (error) {
        console.warn('[workspace-gate] surface registration failed:', error)
        postDiag({ kind: 'apply-failed', crash: safeError(error) })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
