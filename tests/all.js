// 一键跑完全部测试：30 条 PRD 验收 + 前端冒烟
// 用法：node tests/all.js
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const node = process.execPath;
const files = [
  ['PRD 11.1 验收测试（AC-01 ~ AC-30）', 'acceptance.test.js'],
  ['前端冒烟测试（真实执行 app.js）', 'ui.test.js'],
];

let failed = 0;
const summary = [];

for (const [label, file] of files) {
  console.log('\n' + '='.repeat(64));
  console.log('▶ ' + label);
  console.log('='.repeat(64));
  try {
    const out = execFileSync(node, [path.join(__dirname, file)], {
      encoding: 'utf8',
      env: { ...process.env, QD_DB: ':memory:' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(out.replace(/^\(node:\d+\) ExperimentalWarning.*\n(\(Use .*\n)?/gm, ''));
    const m = out.match(/通过 (\d+) \/ (\d+)/);
    summary.push({ label, pass: m ? +m[1] : 0, total: m ? +m[2] : 0 });
    if (!m || m[1] !== m[2]) failed++;
  } catch (e) {
    process.stdout.write(String(e.stdout || ''));
    if (e.stderr) process.stderr.write(String(e.stderr));
    const m = String(e.stdout || '').match(/通过 (\d+) \/ (\d+)/);
    summary.push({ label, pass: m ? +m[1] : 0, total: m ? +m[2] : 0 });
    failed++;
  }
}

console.log('\n' + '='.repeat(64));
console.log('汇总');
console.log('='.repeat(64));
let tp = 0; let tt = 0;
for (const s of summary) {
  tp += s.pass; tt += s.total;
  console.log(`  ${s.pass === s.total ? '✓' : '✗'} ${s.label}：${s.pass} / ${s.total}`);
}
console.log(`\n  合计：${tp} / ${tt}　${failed ? `有 ${failed} 个文件未全通过` : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
