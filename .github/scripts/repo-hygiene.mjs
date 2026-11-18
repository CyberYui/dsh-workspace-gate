'use strict';

/**
 * 仓库卫生与 CI 门禁（本仓库自有的最小实现）。
 *
 * 上游 e lysia395/dsh-wallpaper-engine 的做法是「先分类变更，再只跑受影响的分支，
 * 最后由一个总是运行的结果 job 汇总」。这里保留同样的形状，但工具链换成本仓库的：
 * 插件运行时零依赖、没有 package-lock，所以不需要 npm install。
 *
 * 子命令：
 *   classify —— 计算本次变更触及 plugin / docs，写入 GITHUB_OUTPUT（fail-closed）
 *   verify   —— 源码与结构静态门禁（解析、回归标记、禁用写法）
 *   result   —— 汇总 verify.yml 里各 job 的结论，写 $GITHUB_OUTPUT 并决定退出码
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function out(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, name + '=' + value + '\n');
  console.log('set-output ' + name + '=' + value);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function changedFiles() {
  const payloadPath = process.env.GITHUB_EVENT_PATH;
  if (!payloadPath || !existsSync(payloadPath)) return null;
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const base = payload && payload.pull_request && payload.pull_request.base && payload.pull_request.base.sha ? payload.pull_request.base.sha : payload && payload.before;
  if (!base || base === '0000000000000000000000000000000000000000') return null;
  const result = run('git', ['diff', '--name-only', base, 'HEAD']);
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const PLUGIN_PATTERNS = [/^index\.js$/, /^client\.js$/, /^cordis\.patch\.yml$/, /^package\.json$/, /^test\//, /^\.github\//, /^icon\.svg$/];
const DOCS_PATTERNS = [/^README\.md$/, /^CONTRIBUTING\.md$/, /^LICENSE$/, /^docs\//];
const WORKFLOW_FILES = ['.github/workflows/verify.yml', '.github/workflows/issue-claim.yml', '.github/workflows/issue-claim-policy.yml'];

function classify() {
  const files = changedFiles();
  // 拿不到基线（新分支首个提交、workflow_dispatch）=> 视为全量变更，两个分支都跑。
  if (!files) {
    out('plugin', 'true');
    out('docs', 'true');
    return 0;
  }
  const plugin = files.some((file) => PLUGIN_PATTERNS.some((pattern) => pattern.test(file)));
  const docs = files.some((file) => DOCS_PATTERNS.some((pattern) => pattern.test(file)));
  out('plugin', String(plugin));
  out('docs', String(docs));
  console.log('changed files: ' + files.length + ' | plugin: ' + plugin + ' | docs: ' + docs);
  return 0;
}

/**
 * 回归标记门禁。断言刻意写成「必须存在」而不是「必须通过测试」——
 * test/host-regression.mjs 负责行为，这里负责防止有人把修复整段删掉之后
 * 测试因为夹具一起被改而假绿。
 */
const REQUIRED_MARKERS = [
  ['index.js', 'profileOff.has(entry.id)', 'B1：profile 自己关闭的条目不得被门控重新打开'],
  ['index.js', 'ignored.push(item)', 'B2：未知 id 必须被忽略而不是写进策略'],
  ['index.js', 'lastWriteError', 'B7：写状态失败必须上报'],
  ['index.js', 'packageCache', 'B4：包元信息按 mtime 缓存'],
  ['index.js', 'dumpSig', 'B3：dump 快照按签名去重'],
  ['index.js', 'function agents()', 'B8：agents 服务缺失时兜底'],
  ['index.js', "ctx.get('agents')", 'B8：必须同步取一次 agents，不能只靠异步 inject'],
  ['issue-claim-policy.cjs', 'async function withRetry(', 'S4：checks.update 必须走有界重试（create→update 传播窗口）'],
];
const FORBIDDEN_PATTERNS = [
  ['index.js', /providedNames/, 'B6：条目 id / 包名与服务名不是同一命名空间'],
  ['index.js', /agentRegistry\.list\(\)/, 'B8：必须用局部 registry，避免兜底拿到服务后仍读旧变量'],
  ['client.js', /setInterval\(read,\s*1000\)/, 'B9：会话 id 不得 1s 轮询'],
  ['issue-claim-policy.cjs', /await github\.rest\.checks\.update\(/, 'S5：不得出现未包裹的 checks.update（会被传播窗口 404 打断）'],
];

function readSource(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

function verify() {
  const problems = [];
  for (const [file, marker, why] of REQUIRED_MARKERS) {
    if (!readSource(file).includes(marker)) problems.push(file + ' 缺少回归标记 ' + JSON.stringify(marker) + '（' + why + '）');
  }
  for (const [file, pattern, why] of FORBIDDEN_PATTERNS) {
    if (pattern.test(readSource(file))) problems.push(file + ' 命中禁用写法 ' + String(pattern) + '（' + why + '）');
  }
  for (const file of ['index.js', 'client.js']) {
    const parsed = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    if (parsed.status !== 0) problems.push(file + ' 语法检查失败：' + String(parsed.stderr || '').trim());
  }
  // workflow 里的 ${{ 必须是真的表达式。曾经有 7 处被写成字面反斜杠，GitHub 把反斜杠
  // 当 runner label 的字面前缀（runs-on 变成 "\\ubuntu-latest"），plugin 两个矩阵 job
  // 排队 15 小时从未拿到 runner，ci/result 也永远不会出现。
  for (const file of WORKFLOW_FILES) {
    if (!existsSync(path.join(ROOT, file))) continue;
    const text = readSource(file);
    const escaped = text.match(/\\\$\{\{/g);
    if (escaped) problems.push(file + ' 有 ' + escaped.length + ' 处被转义的 ${{（必须写成 ${{）');
  }
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'LICENSE']) {
    if (!existsSync(path.join(ROOT, file))) problems.push('缺少必需文件 ' + file);
  }
  if (problems.length) {
    for (const problem of problems) console.error(' - ' + problem);
    return 1;
  }
  console.log('repo-hygiene verify: OK');
  return 0;
}

function result() {
  const needs = JSON.parse(process.env.NEEDS || '{}');
  const failed = [];
  for (const job of ['plugin', 'docs']) {
    const value = needs[job] && needs[job].result;
    if (value === 'failure' || value === 'cancelled' || value === 'timed_out') failed.push(job + '=' + value);
  }
  out('failed', failed.length ? failed.join(',') : 'none');
  if (failed.length) {
    console.error('verify 未通过：' + failed.join(', '));
    return 1;
  }
  console.log('verify 通过');
  return 0;
}

const command = process.argv[2] || 'verify';
const table = { classify, verify, result };
if (!table[command]) {
  console.error('未知子命令 ' + command + '；可用：' + Object.keys(table).join(', '));
  process.exit(2);
}
process.exit(table[command]());