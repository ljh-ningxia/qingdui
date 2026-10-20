// 极简测试运行器（零依赖）
const results = [];
let currentSuite = '';

function suite(name, fn) {
  currentSuite = name;
  fn();
}

function test(name, fn) {
  return { name, fn };
}

const CASE_TIMEOUT = Number(process.env.QD_CASE_TIMEOUT || 30000);

function withTimeout(promise, ms, name) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`用例超时（${ms}ms）：${name}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function runAll(tests) {
  for (const t of tests) {
    const started = Date.now();
    // 实时输出，避免整体卡住时看不到进度
    if (process.env.QD_VERBOSE !== '0') process.stderr.write(`  … ${t.name}\n`);
    try {
      await withTimeout(Promise.resolve().then(() => t.fn()), CASE_TIMEOUT, t.name);
      results.push({ suite: currentSuite, name: t.name, ok: true, ms: Date.now() - started });
    } catch (e) {
      results.push({ suite: currentSuite, name: t.name, ok: false, ms: Date.now() - started, error: e });
    }
  }
  return results;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

function includes(hay, needle, msg) {
  if (!String(hay).includes(needle)) throw new Error(`${msg || '未包含'}：在「${String(hay).slice(0, 120)}」中找不到「${needle}」`);
}

function report(results) {
  const lines = [];
  let pass = 0; let fail = 0;
  let lastSuite = '';
  for (const r of results) {
    if (r.suite !== lastSuite) { lines.push(`\n  ${r.suite}`); lastSuite = r.suite; }
    if (r.ok) { pass++; lines.push(`    ✓ ${r.name}`); }
    else { fail++; lines.push(`    ✗ ${r.name}\n        → ${r.error.message}`); }
  }
  lines.push('');
  lines.push(`  通过 ${pass} / ${results.length}${fail ? `　失败 ${fail}` : ''}`);
  return { text: lines.join('\n'), pass, fail, total: results.length };
}

module.exports = { suite, test, runAll, assert, eq, includes, report, results };
