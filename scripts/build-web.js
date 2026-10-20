// 把 src/web 下的四个文件打成一个自包含的 dist/index.html。
//
// 为什么要这么做：托管平台的分享链接是 `?sharecode=xxx`，页面里对 /style.css、
// /app.js 的第二次请求不会带上这个 query，会被网关直接拦成 403。打成一个文件后，
// 页面本身就是完整的，不再依赖任何外部请求。
//
// 用法：node scripts/build-web.js
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'src', 'web');
const DIST = path.join(ROOT, 'dist');

const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

const css = read('style.css');
// api.js 全是 export 声明，去掉 export 后就是普通函数声明
const api = read('api.js').replace(/^export\s+/gm, '');
// app.js 开头从 api.js 导入，合并后去掉 import 语句
const app = read('app.js')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/api\.js';\s*/m, '')
  .replace(/^export\s+/gm, '');

const bundle = api + '\n\n' + app;

// 写盘前先做一次真正的语法校验，别把坏代码发到线上
const tmp = path.join(os.tmpdir(), `qingdui-bundle-${process.pid}.mjs`);
fs.writeFileSync(tmp, bundle);
const check = cp.spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);
if (check.status !== 0) {
  console.error('打包后的脚本有语法错误，已中止：\n' + check.stderr);
  process.exit(1);
}

let html = read('index.html');
if (!html.includes('<link rel="stylesheet" href="/style.css">')) {
  console.error('index.html 里没有找到样式表占位，无法内联');
  process.exit(1);
}
if (!html.includes('<script type="module" src="/app.js"></script>')) {
  console.error('index.html 里没有找到脚本占位，无法内联');
  process.exit(1);
}
// 注意：String.prototype.replace 的替换串里 `$'`、`$/`、`$&` 是特殊模式，
// 源码里正则结尾的 `'/?'` + `$'` 会被当成“插入匹配点之后的所有内容”，
// 结果就是整段 HTML 被塞进 JS 中间。所以这里必须用函数式替换。
html = html.replace('<link rel="stylesheet" href="/style.css">', () => '<style>\n' + css + '\n</style>');
html = html.replace(
  '<script type="module" src="/app.js"></script>',
  () => '<script type="module">\n' + bundle + '\n</script>',
);

fs.mkdirSync(DIST, { recursive: true });
const outFile = path.join(DIST, 'index.html');
fs.writeFileSync(outFile, html);

// 落盘后再从磁盘读回来校验一次，确保写进去的就是能跑的那份
const written = fs.readFileSync(outFile, 'utf8');
const inline = written.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!inline) {
  console.error('生成的 dist/index.html 里找不到内联脚本');
  process.exit(1);
}
const tmp2 = path.join(os.tmpdir(), `qingdui-dist-${process.pid}.mjs`);
fs.writeFileSync(tmp2, inline[1]);
const check2 = cp.spawnSync(process.execPath, ['--check', tmp2], { encoding: 'utf8' });
fs.unlinkSync(tmp2);
if (check2.status !== 0) {
  console.error('落盘后的内联脚本有语法错误，已中止：\n' + check2.stderr);
  process.exit(1);
}

console.log(
  `dist/index.html 已生成：${(Buffer.byteLength(html) / 1024).toFixed(1)} KB` +
    `（样式 ${(css.length / 1024).toFixed(1)} KB，脚本 ${(bundle.length / 1024).toFixed(1)} KB）`,
);
