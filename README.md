# dsh-workspace-isolate

按工作区查看插件与技能，并可按工作区真正「隔离」（关闭）插件。

> 2026-11-17 更名：原 `@cyberyui/dsh-workspace-gate`，显示名「工作区门控」；
> 新包名 `@cyberyui/dsh-workspace-isolate`，显示名「工作区隔离」。

## 这个插件做什么

- **侧边栏面板**：列出每个工作区当前实际加载的插件与技能，带来源徽章（官方 / 社区 / 内部）。
- **会话头部 chip**：点一下即可对当前工作区启用门控。
- **真·隔离**：`loader.update(entry.id, { disabled: true })` 直接关掉 cordis 条目，
  不是只对模型隐藏——省的是内存与启动开销。
- **受保护条目**（`dsh-base` / `dsh-web-app` / 本插件）与**被其他条目依赖**的条目不可关闭。
- **技能开关**：文件型技能写 `disable-model-invocation`；插件自带技能写 provider 开关。

## 安装

在 profile 的 `package.json` 里加一条依赖：

```json
"@cyberyui/dsh-workspace-isolate": "file:D:/DSH_Assets/DSH_Plugins/dsh-workspace-isolate"
```

并把 `@cyberyui/dsh-workspace-isolate` 加进 `dsh.profile.bundles`，然后：

```
dsh plugin --profile desktop install
```

## 同类插件（互指）

- [M1r0er/dsh-workspace-gate](https://github.com/M1r0er/dsh-workspace-gate)
  （npm 包名 `dsh-workspace-gate`）做的是 **token 层**收窄：插件照常加载，
  只对模型隐藏工具与提示词段，省的是每轮输入 token。
  本插件是 **加载层** 真关停，省内存与启动开销，另外还能开关技能。
  两者层级不同，可以同时安装（包名不冲突）。

## 数据

`~/.dsh/dsh-workspace-isolate/workspaces.json`
（v0.2.0 起；更早版本在 `~/.dsh/dsh-workspace-gate/`）。

## 防崩溃

- 面板有 `PanelBoundary`（`getDerivedStateFromError` / `componentDidCatch`）：
  面板自己崩了只在面板内显示，不拖垮宿主。
- `h()` 拦截 React #31（把对象当子节点）→ 占位符 + 上报 `diag.log`。
- `useSlotDiag()` 定期写 `diag.log`，便于事后定位。
- 主机 `applyGating()` 有依赖阻断与受保护名单，不会关掉被依赖或核心条目。
