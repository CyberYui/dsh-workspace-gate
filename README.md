# dsh-workspace-gate

Per-workspace plugin and skill inventory for [DeepSeek Harness](https://github.com/deepseek-ai),
with optional per-workspace plugin gating.

The DSH loader keeps **one process-global plugin set**. Plugins are not loaded per
workspace, so "workspace A disables plugin X while workspace B keeps it" cannot exist
as two simultaneous states. This plugin therefore stores **one policy per workspace**
and applies the policy of the workspace you are currently in, deferring the switch
while any agent is still running a turn.

## What it does

- **Inventory** — every installed bundle with its real version, description, and an
  official / community badge, read from the profile's `package.json` and each
  package's own manifest (not from a hardcoded list).
- **Skills** — the skill registry for the current workspace, rendered compactly.
  When `@linxin666/dsh-client-ui-skill-explorer` is present, the tab talks to its
  `api/dsh-skill-explorer/list` endpoint and offers the **real switches**
  (`set-enabled` rewrites the `disable-model-invocation` frontmatter,
  `set-provider-enabled` for provider-file skills). Skills that are `virtual` and
  have no path are shown read-only, matching the explorer's own `canToggle`.
- **Gating** — per-workspace disabled-entry list. Applied on demand; never while an
  agent is running.
- **Two surfaces** — a sidebar panel (`sidebar.panellist`) and a persistent chip in
  the session header (`conversation.session.header.utilities`), so the inventory
  travels with the workspace instead of living in a global sidebar.

## Safety

`gatingEnabled` is a default-on lock, but gating is **inert** until a workspace is
armed with a non-empty disabled list. Core entries (`dsh-base`, `dsh-web-app`,
`workspace-gate`) are always protected in code, and `protectIds` adds more.

`/arm` and `/follow` return `409 agent-active` when `ctx.agents.list()` reports
any agent with `status === 'running'`. This is the same invariant the DSH market's
drain enforces: plugin files must not be replaced or unmounted while an agent can
still execute a turn against them.

## Install

```json
{
  "dependencies": { "dsh-workspace-gate": "file:../dsh-workspace-gate" }
}
```

Then add `dsh-workspace-gate` to `dsh.profile.bundles`.

## Develop

```bash
node --input-type=module --check < client.js
node --input-type=module --check < index.js
```

The client bundle is plain `window.__ModuleLoader__.load({...})` — no build step.
