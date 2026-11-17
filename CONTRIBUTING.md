# 参与贡献

感谢你来看这个仓库。它很小：一个 DSH 插件（两个源文件 + 一份 cordis patch + 一个回归测试）。
正因为小，流程可以更轻，但**流程本身不打折**——下面这套是刻意从
[elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) 借鉴来的，
我们在那里完整走过一遍 issue → 认领 → 批准 → PR → 检查 → merge 的流程，体验很好，所以照搬。

## 先说结论：什么时候该提 issue

- **要改行为、改配置格式、改默认值** → 先提 issue。哪怕你已经想好怎么改。
- **只是修一个明确的小 bug、补文档、加测试** → 直接开 PR，正文里写清楚「改了什么 / 怎么验证」。
- **纯提问** → 开 issue，标签用 `status:needs-triage`。

## Issue triage & labels

维护者用下面几个标签给 issue 定状态。**认领的前提是 `status:accepted`**，
`status:needs-triage` 和 `status:declined` 都不算被接受。

| 标签 | 含义 |
| --- | --- |
| `status:needs-triage` | 还没人看过。新 issue 默认落在这里。 |
| `status:accepted` | 维护者认可，可以开工。**只有带这个标签的 issue 才能被认领。** |
| `status:declined` | 不打算做。可能附了原因。 |
| `bug` / `enhancement` | 类型，可叠加。 |

## 认领与批准

外部贡献者按这个顺序走，**顺序不能换**：

1. 在 issue 下评论 `/assign`（不带用户名 = 申请自己）。
2. 等维护者把 issue 标成 `status:accepted`，然后评论 `/approve @你的用户名`。
3. 维护者批准后，issue 会被自动指派给你。
4. **这时才**开 PR，正文里单独一行 `Fixes #123` 或 `Refs #123`。

仓库里的 `issue-claim` 机器人会在每一步之后复验；`issue-claim-policy` 会在 PR 上检查
「acceptance 时间 < PR 创建时间」「指派时间 < PR 创建时间」「/assign 早于 approval」。
不满足 ⇒ check 变红并**自动关闭 PR**。批准之后再补开一个新 PR 是可以的。

仓库 owner 和 write 权限的协作者豁免这套流程。

## 开发

没有构建步骤，没有运行时依赖，没有 lockfile。

```bash
node --check index.js client.js     # 语法
node .github/scripts/repo-hygiene.mjs verify   # 结构 + 回归标记 + workflow 表达式门禁
node test/host-regression.mjs       # 行为回归（B1–B11）
node test/css-invariants.mjs        # 玻璃适配样式 8 组不变量
```

`npm test` / `npm run verify` 是 `node test/host-regression.mjs && node test/css-invariants.mjs` 的别名。

### 改完之后必须自查

- **不要动已安装副本。** 插件装在三处（仓库、`D:/DSH_Assets/DSH_Plugins/`、profile 的
  `node_modules`）。只改仓库，同步由维护者用 `preflight.mjs` 做，它会比对三份 sha1。
- **不要为了绕过门禁而删测试。** `repo-hygiene.mjs verify` 会检查 B1–B9 的回归标记还在；
  `host-regression.mjs` 会真的跑行为。两边都过才算过。
- **不要提交任何真实密钥、token、本机绝对路径。** 仓库里没有 `.env`，也不该有。

## CI

`verify.yml` 三个 job：

- `changes` —— 分类本次变更碰了 `plugin` 还是 `docs`（拿不到基线时按全量处理，fail-closed）。
- `plugin` —— Ubuntu + Windows 双矩阵，跑 `repo-hygiene verify`、`host-regression.mjs`、`css-invariants.mjs`。
- `docs` —— 只在文档变更时跑。
- `result`（`ci/result`）—— **总是运行**，汇总上面两个。分支保护只勾这一个。

### 改完 workflow 必须本地解析一遍

`verify.yml` / `issue-claim*.yml` 里所有 `${{ ... }}` 都必须是**真的表达式**，一个反斜杠都不能多。
曾经有 7 处被写成字面反斜杠（`\${{`），GitHub 把反斜杠当成 runner label 的字面前缀，
`runs-on` 变成 `"\\ubuntu-latest"`，两个 plugin job 排队 15 小时从未拿到 runner，
`ci/result` 也永远不会出现——而且从 UI 上看只是「排队中」，极易被当成 runner 容量问题忽略过去。

这条现在由 `repo-hygiene.mjs verify` 兜住（检查三个 workflow 文件里有没有被转义的 `${{`），
本地和 CI 都会红。改完 workflow 跑一遍上面的命令即可。

## 提交信息

`类型: 一句话`，类型用 `feat` / `fix` / `docs` / `test` / `refactor` / `chore`。
正文写「为什么」而不是「改了什么」——diff 已经说了改了什么。

## 行为红线

1. 不得让插件在宿主没有 `agents` / `workspaceRegistry` / `skills` / `loader` 服务时崩掉。
2. 不得把 profile 自己关掉的插件写进工作区策略（B1）。
3. 不得让 `applyGating()` 重新打开一个由 profile 关闭的条目（B1）。
4. 不得用条目 id / 包名去推断服务依赖（B6）。
5. 状态写不进去必须让用户看见，不能只 `console.warn`（B7）。
