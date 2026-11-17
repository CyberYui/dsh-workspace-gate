# @cyberyui/dsh-workspace-isolate

[![CI](https://github.com/CyberYui/dsh-workspace-isolate/actions/workflows/verify.yml/badge.svg)](https://github.com/CyberYui/dsh-workspace-isolate/actions/workflows/verify.yml)
[![issue-claim-policy](https://github.com/CyberYui/dsh-workspace-isolate/actions/workflows/issue-claim-policy.yml/badge.svg)](https://github.com/CyberYui/dsh-workspace-isolate/actions/workflows/issue-claim-policy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

每个工作区一份独立的插件与技能开关：在这个工作区关掉的插件，只在这个工作区关掉。

## 它解决什么

DSH 的插件是**按 profile 全局加载**的：`cordis.patch.yml` 里写 `disabled: true`，所有工作区一起失效。
于是「写代码的工作区只想要 5 个插件」和「另一个工作区要全部插件」只能二选一——要么全局关掉，
要么全局开着然后忍受用不到的插件占内存、抢快捷键、把技能塞进上下文。

这个插件把开关的粒度降到**工作区**：

- 侧边栏面板里选一个工作区，勾掉这个工作区不需要的插件，保存并启用。
- 开关是**实时**的：直接改 loader 条目，不写 `cordis.patch.yml`，不需要重启。
- 会话标题栏有一个小 chip，显示当前会话所属工作区的门控状态，点它可以在弹窗里快速切换。

## 界面

![侧边栏面板与会话 chip 的结构预览](docs/screenshots/panel-preview.png)

> 上图是按 `client.js` 的 DOM 结构与 `PANEL_CSS` / `CHIP_CSS` 样式令牌 1:1 复刻的**静态预览**，
> 不是运行截图（DSH 的界面在 Electron 渲染进程里，需要登录态才能截）。数据为示例。

- **侧边栏面板**：跨工作区管理。工作区列表、每个工作区的插件/技能开关、「保存并启用 / 捕获当前状态 / 清空 / 停用」。
- **会话 chip**：跟随当前会话所属工作区，只读展示 + 快速开关。

## 安装

```bash
dsh plugin add @cyberyui/dsh-workspace-isolate --profile desktop
```

或把 `"@cyberyui/dsh-workspace-isolate"` 加进 profile 的 `package.json` 的 `dsh.profile.bundles`，
再跑一次 `pnpm install`。

装完需要**重启 DSH**：插件的 `cordis.patch.yml` 只在 profile 加载时读取。

## 语义：哪些开关不会生效

插件有几条刻意的保守规则，理解它们比记住按钮更重要：

| 情形 | 行为 | 原因 |
| --- | --- | --- |
| 内置插件（`dsh-base` / `dsh-web-app` / 本插件） | 永远不可关 | 关掉会让宿主起不来 |
| 你在 `protectIds` 里声明的 id | 不可关 | 给「这个工作区必须留 X」用 |
| 被别的插件依赖的服务 | 关不掉，面板里显示阻塞者 | 避免关出半个坏掉的插件链 |
| `cordis.patch.yml` 里已经 `disabled: true` 的插件 | 面板标「已关闭（配置）」，**也不会被重新打开** | profile 的意图优先于工作区策略 |
| 有 Agent 正在运行时启用门控 | 返回 409，提示稍后再试 | 不在别人跑一半的时候抽插件 |
| 策略里的 id 在插件升级后已不存在 | 面板顶部红条提示数量 | 不让你以为还关着 |

最后一条是安全功能的一部分：**策略静默失配会被显示出来**，而不是假装生效。

## 配置

`dsh` 段（写在 profile 的插件配置里）：

```yaml
gatingEnabled: true      # 总开关
protectIds: []           # 额外受保护的 loader id / 包名
dataFile: ''             # 留空 = <home>/dsh-workspace-isolate/workspaces.json
```

状态文件是普通 JSON，可以直接看、可以手改（改完在面板里刷新即可）：

```
C:/Users/<you>/.dsh/dsh-workspace-isolate/workspaces.json
```

## 开发

零运行时依赖，没有构建步骤。

```bash
node --check index.js client.js                  # 语法
node .github/scripts/repo-hygiene.mjs verify    # 结构 + 回归标记门禁
node test/host-regression.mjs                    # 行为回归（B1–B9）
npm test                                         # 同上
```

`test/host-regression.mjs` 用临时目录和假 loader 覆盖九类回归，不碰真实 profile、不需要 DSH 在跑。
`repo-hygiene.mjs verify` 额外检查这些修复的回归标记还在，防止有人删掉修复后测试跟着改绿。

### 改完之后

插件装在三处：本仓库、`D:/DSH_Assets/DSH_Plugins/dsh-workspace-isolate`、profile 的
`node_modules/@cyberyui/dsh-workspace-isolate`。**只改本仓库**，另外两份由维护者用
`D:/DeepSeekWorkspace/scripts/preflight.mjs` 比对 sha1 后同步。

## CI

`verify.yml`：`changes`（变更分类，拿不到基线就全量，fail-closed）→ `plugin`（Ubuntu + Windows
跑 hygiene + 回归）/ `docs` → `result`（`ci/result`，总是运行）。分支保护只勾 `ci/result`。

## 贡献

先读 [CONTRIBUTING.md](CONTRIBUTING.md)。要点：改行为先提 issue；外部贡献者走
`/assign` → `status:accepted` + `/approve @you` → 再开带 `Fixes #123` 的 PR。
`issue-claim-policy` 检查会拒绝「先开 PR 后补批准」，不合规会被自动关闭。

## 许可

MIT
