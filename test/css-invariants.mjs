#!/usr/bin/env node
/**
 * workspace-isolate-css-test.mjs — 玻璃适配的样式回归
 *
 * 背景：2026-11-17 之前 client.js 把表面写死成 --dsw-static-neutral-bluish-*，
 * 于是 wallpaper 的玻璃配方对本插件完全无效（用户：「基本无效，有些过分强制」）。
 * 方案②（2026-11-17 上午）曾把基底换成 --we-panel-color 再按 --we-glass-alpha 染色，
 * 但 --we-glass-alpha 上限 0.25、乘 0.45 后着色最透也只有 ~11% ⇒ 用户看不到变化。
 * 方案 A（2026-11-17 下午）改为照抄玻璃插件页面级配方，实测面板只有 24% 不透明，
 * 用户报「chip 上的字在文字背景上看不清」，且调 wallpaper 任何旋钮都改不动。
 * 方案 C（2026-11-17 晚，现行）把不透明度收回到本插件手里：
 *   基色 = --we-panel-color（不透明的主题面）
 *   釉色 = --we-surface-tint-light/dark（用户在 wallpaper 里选的那一个玻璃色）
 *   浓度 = --wg-surface-opacity（本插件设置里的滑杆，0..1，默认 0.85）
 * 视觉上仍跟随用户的玻璃色与玻璃开关，因此与设置窗/侧栏同源，但可读性由自己兜住。
 *
 * 这个脚本守住不变量，防止以后有人（包括我）手滑改回去：
 *   1. 两个 CSS 数组都定义 --wg-bg / --wg-bg-raised / --wg-border
 *   2. 任何 background 声明都不再写死 neutral-bluish 表面色（状态色除外）
 *   3. 文字 color 一律走 --dsw-alias-label-*（状态色除外）
 *   4. 玻璃开（body[data-we-glass-page]）与深色玻璃两个变体都在
 *   5. 方案 C 的三件套齐备，且没有退回方案 A/B 的旧写法
 *   6. 文字配对：标题/正文/次要三档都在
 *   7. 滑杆与浓度持久化：CSS 类、helper、提交函数都在
 *   8. 外观卡片里的实时预览：chip 压在示例正文上 + 真实的官方/社区卡片行
 *
 * 只读。退出码 0 = 通过。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const file = process.argv[2] || path.join(REPO, "client.js");

function extractArray(src, name) {
  const start = "const " + name + " = [";
  const i = src.indexOf(start);
  if (i < 0) throw new Error("找不到 " + name);
  const end = "].join('\\n')";
  const j = src.indexOf(end, i);
  if (j < 0) throw new Error("找不到 " + name + " 的结尾");
  const literal = src.slice(i + start.length, j);
  // 只在这一个文件自身的两个数组上求值；内容是我们自己写的 CSS 字符串。
  // eslint-disable-next-line no-new-func
  return new Function("return [" + literal + "]")();
}

const src = fs.readFileSync(file, "utf8");
const panel = extractArray(src, "PANEL_CSS").join("\n");
const chip = extractArray(src, "CHIP_CSS").join("\n");
const css = panel + "\n" + chip;

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

// 1. 令牌齐全
for (const tok of ["--wg-bg", "--wg-bg-raised", "--wg-border"]) {
  ok(css.includes(tok + ":"), "缺少令牌声明 " + tok);
}

// 2. 表面不再写死中性色板
const bgDecls = [...css.matchAll(/background:([^;}]+)/g)].map((m) => m[1].trim());
const STATUS = /green|red|violet|static-(green|red|violet)/;
const hardBg = bgDecls.filter((d) => d.includes("--dsw-static-neutral-bluish-") && !STATUS.test(d));
ok(hardBg.length === 0, "仍有写死 neutral-bluish 的表面底: " + JSON.stringify(hardBg));

// 3. 文字走宿主标签墨
const colorDecls = [...css.matchAll(/(?:^|[;{])\s*color:([^;}]+)/g)].map((m) => m[1].trim());
const hardInk = colorDecls.filter((d) => d.includes("--dsw-static-neutral-bluish-") && !STATUS.test(d));
ok(hardInk.length === 0, "仍有写死 neutral-bluish 的文字色: " + JSON.stringify(hardInk));

// 4. 玻璃两个变体
for (const sel of ["body[data-we-glass-page] .wg-panel", "body[data-ds-dark-theme][data-we-glass-page] .wg-panel",
                   "body[data-we-glass-page] .wg-chip", "body[data-ds-dark-theme][data-we-glass-page] .wg-chip",
                   "body[data-we-glass-page] .wg-popover", "body[data-ds-dark-theme][data-we-glass-page] .wg-popover"]) {
  ok(css.includes(sel + "{"), "缺少玻璃变体 " + sel);
}

// 5. 方案 C：基色 --we-panel-color + 釉色 --we-surface-tint-* + 本插件浓度 --wg-surface-opacity
ok(!css.includes("--wg-wash"), "旧方案②的 --wg-wash 又回来了（应改用 --wg-surface-opacity）");
ok(!css.includes("--we-readability-floor"), "方案 A 的 --we-readability-floor 又回来了（实测 24% 不透明，用户报字看不清）");
ok(!css.includes("(1 - var(--wg-surface-opacity"), "旧端点写法又回来了：0% 会变成釉色实底、两端都不透明");
ok(css.includes("var(--we-panel-color") && css.includes("var(--we-surface-tint-light") && css.includes("var(--we-surface-tint-dark"),
   "玻璃变体缺少基色 --we-panel-color 或釉色 --we-surface-tint-light/dark");
const opacityRefs = (css.match(/var\(--wg-surface-opacity,0\.85\)/g) || []).length;
ok(opacityRefs >= 4, "浓度令牌 --wg-surface-opacity 出现次数过少（chip/panel/popover 与 raised 变体都要用），实际 " + opacityRefs);

// 6. 文字配对：标题/正文/次要三档都在
for (const tok of ["--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary"]) {
  ok(css.includes("var(" + tok), "文字未使用 " + tok);
}

// 7. 滑杆与浓度持久化
ok(css.includes(".wg-range{") && css.includes(".wg-range input{") && css.includes(".wg-range-val{"), "缺少滑杆样式");
ok(src.includes("const DEFAULT_SURFACE_OPACITY") && src.includes("const applySurfaceOpacity") && src.includes("const clampOpacity"),
   "缺少浓度 helper（DEFAULT_SURFACE_OPACITY / applySurfaceOpacity / clampOpacity）");
ok(src.includes("const commitOpacity") && src.includes("'/appearance'"), "缺少浓度落盘（commitOpacity → PUT /appearance）");
ok(src.includes("--wg-surface-opacity"), "helper 未把浓度写到 documentElement 的 --wg-surface-opacity");

// 8. 外观卡片里的实时预览（滑杆效果要能在 chip 与卡片两类表面上同时看到）
for (const sel of [".wg-preview{", ".wg-preview-copy{", ".wg-preview-chipwrap{", ".wg-preview-rows{"]) {
  ok(css.includes(sel), "缺少预览样式 " + sel);
}
ok(src.includes("tt('appearance.preview.copy')") && src.includes("tt('appearance.preview.hint')"), "缺少预览文案 key");
ok(src.includes("const previewGroups") && src.includes("const previewOfficial") && src.includes("const previewCommunity"),
   "缺少预览数据（previewGroups / previewOfficial / previewCommunity）");
ok(src.includes("className: 'wg-chip', style: S.chip"), "预览里的 chip 未复用真实 chip 的 className/style");
if (fails.length) {
  console.log("FAIL " + fails.length + " 项：");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("PASS 玻璃适配样式回归（8 组不变量） — " + path.basename(file));
