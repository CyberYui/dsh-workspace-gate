// S4 回归：issue-claim-policy 写 check run 必须走 withRetry 的有界重试。
//
// 背景（P11 实测）：checks.create 之后立刻 checks.update 会命中 GitHub 的 check-run
// 传播窗口，PATCH /repos/{owner}/{repo}/check-runs/{id} 回 404 "Not Found"；
// 同一请求延后几十毫秒再发即成功。三次运行里紧随 create 的主 update 3/3 失败，
// catch 里的补写 2/3 成功。没有重试时，政策验证通过的 PR 也会挂一个红 check。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import policy from '../.github/scripts/issue-claim-policy.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log('ok - ' + name);
}

// ---- 行为：withRetry ----
const errorWith = (status) => Object.assign(new Error('HTTP ' + status), { status });

await (async () => {
  let calls = 0;
  const value = await policy.withRetry(async () => {
    calls += 1;
    if (calls < 3) throw errorWith(404);
    return 'done';
  }, { attempts: 5, delayMs: 5 });
  assert.equal(calls, 3);
  assert.equal(value, 'done');
  checks += 1;
  console.log('ok - 404 重试后成功（第 3 次成功）');
})();

await (async () => {
  let calls = 0;
  await assert.rejects(
    () => policy.withRetry(async () => { calls += 1; throw errorWith(404); }, { attempts: 3, delayMs: 5 }),
    (error) => error.status === 404,
  );
  assert.equal(calls, 3);
  checks += 1;
  console.log('ok - 持续 404 在 attempts 次后抛出最后一次错误');
})();

await (async () => {
  let calls = 0;
  await assert.rejects(
    () => policy.withRetry(async () => { calls += 1; throw errorWith(403); }, { attempts: 4, delayMs: 5 }),
    (error) => error.status === 403,
  );
  assert.equal(calls, 1);
  checks += 1;
  console.log('ok - 403 非瞬时状态不重试');
})();

await (async () => {
  let calls = 0;
  await policy.withRetry(async () => { calls += 1; if (calls === 1) throw errorWith(503); return 'ok'; }, { attempts: 3, delayMs: 5 });
  assert.equal(calls, 2);
  checks += 1;
  console.log('ok - 5xx 重试后成功');
})();

// ---- 静态：两个 update 调用点都必须包在 withRetry 里 ----
const script = read('.github/scripts/issue-claim-policy.cjs');
check('脚本含 withRetry 定义与导出', () => {
  assert.match(script, /async function withRetry\(/);
  assert.match(script, /withRetry, parseIssueReferences/);
});
check('脚本不得出现未包裹的 await github.rest.checks.update(', () => {
  assert.doesNotMatch(script, /await github\.rest\.checks\.update\(/);
});
check('两个 check 写入点都走 withRetry', () => {
  const wrapped = script.match(/withRetry\(\(\) => github\.rest\.checks\.update\(/g) || [];
  assert.equal(wrapped.length, 2, '期望主 update 与 catch 补写各一处，实际 ' + wrapped.length);
});
check('重试状态集排除 400/401/403/422', () => {
  assert.match(script, /status === 404 \|\| status === 409 \|\| status === 429/);
});

// ---- 接线：测试与 workflow 都要跑到本文件 ----
check('package.json test/verify 含本测试', () => {
  const pkg = read('package.json');
  assert.match(pkg, /node test\/checks-update-retry\.mjs/);
});
check('verify.yml plugin job 含本测试', () => {
  const wf = read('.github/workflows/verify.yml');
  assert.match(wf, /node test\/checks-update-retry\.mjs/);
});

console.log('PASS checks-update-retry (' + checks + ' assertions)');
