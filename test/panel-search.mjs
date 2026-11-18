#!/usr/bin/env node
/**
 * panel-search.mjs — 面板搜索与重启提示的静态回归
 *
 * 背景（2026-11-18，用户 m23218）：
 *   想找某个插件/技能只能去插件市场翻，本插件面板里没有搜索框；
 *   另外「哪些开关实时生效、哪些要重启 DSH」没有任何提示。
 *
 * 这个脚本只读源码，守住四件事：
 *   1. 中英文案齐全（en / zh 两段都要有，缺一种语言就会回落成 key 名）。
 *   2. 搜索真的接上了：输入框、匹配 helper、三个列表都消费 query。
 *   3. 重启提示只用它能证明的依据（entry.profileOff），不许伪造字段。
 *   4. 无结果时给专属文案，不和「该分组下没有内容」混用。
 *
 * 只读。退出码 0 = 通过。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const clientPath = process.argv[2] || path.join(REPO, "client.js");
const hostPath = process.argv[3] || path.join(REPO, "index.js");

const src = fs.readFileSync(clientPath, "utf8");
const host = fs.readFileSync(hostPath, "utf8");
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg) };

// 1. 文案：每个 key 必须恰好出现两次（en 一次、zh 一次）
const KEYS = [
  "search.placeholder",
  "search.clear",
  "search.noResults",
  "hint.live",
  "hint.restart.profile",
  "hint.skills.explorer",
];
for (const key of KEYS) {
  const n = src.split("'" + key + "':").length - 1;
  ok(n === 2, "文案 " + key + " 应出现 2 次（en + zh），实际 " + n + " 次");
}

// 2. 搜索接线
ok(src.includes("const [query, setQuery] = useState('')"), "缺少搜索状态 const [query, setQuery] = useState('')");
ok(src.includes("type: 'search'"), "缺少 type: 'search' 输入框");
ok(src.includes("className: 'wg-search'"), "输入框缺少 className: 'wg-search'");
ok(src.includes(".wg-search{"), "PANEL_CSS 缺少 .wg-search 样式");
for (const helper of ["function normalizeText(", "function entryMatches(", "function groupMatches(", "function skillMatches("]) {
  ok(src.includes(helper), "缺少匹配 helper " + helper);
}
ok(src.includes("query: query,"), "query 没有往下传给列表组件");
ok(src.includes("h(SkillsCard, { skills: skills, query: query })"), "回退技能列表没有收到 query");

// 3. 重启提示只用它能证明的依据
ok(src.includes("entries.some(function (entry) { return entry.profileOff })"), "插件侧重启提示没有由 entry.profileOff 派生");
for (const fake of ["restartRequired", "needsRestart", "requiresRestart"]) {
  ok(!host.includes(fake), "index.js 出现未经证明的重启标记 " + fake + "（技能侧重启语义不在本仓库，禁止伪造）");
}

// 4. 无结果文案
const noResultsUses = src.split("tt('search.noResults')").length - 1;
ok(noResultsUses >= 3, "search.noResults 应在插件/资源管理器技能/回退技能三处使用，实际 " + noResultsUses + " 处");

if (fails.length) {
  console.log("FAIL " + fails.length + " 项：");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("PASS 面板搜索与重启提示回归（文案 " + KEYS.length + " 组 × 2 语言 + 接线 + 重启依据） — " + path.basename(clientPath));
