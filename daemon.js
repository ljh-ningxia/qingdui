// 后台启动器：把服务作为「脱离父进程」的独立进程拉起，关掉终端也不会停。
// 用法：node daemon.js  [端口]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.argv[2] || process.env.QD_PORT || 3001);
const ROOT = __dirname;
const LOG = path.join(ROOT, 'server.log');

function probe(port, cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => {
    res.resume();
    cb(null, res.statusCode);
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
}

probe(PORT, (err, code) => {
  if (!err && code) {
    console.log(`服务已在运行： http://127.0.0.1:${PORT}`);
    process.exit(0);
  }

  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js'), String(PORT)], {
    cwd: ROOT,
    detached: true,          // 关键：脱离父进程的进程组
    stdio: ['ignore', out, out],
    env: { ...process.env, QD_PORT: String(PORT) },
    windowsHide: true,
  });
  child.unref();             // 父进程退出时不等待它

  console.log(`正在启动（PID ${child.pid}），日志：server.log`);

  let tries = 0;
  const tick = () => {
    tries += 1;
    probe(PORT, (e, code2) => {
      if (!e && code2) {
        console.log(`\n启动成功： http://127.0.0.1:${PORT}\n`);
        process.exit(0);
      }
      if (tries >= 25) {
        console.error('启动超时，请查看 server.log');
        process.exit(1);
      }
      setTimeout(tick, 300);
    });
  };
  setTimeout(tick, 400);
});
