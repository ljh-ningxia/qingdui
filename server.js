// 托管平台启动入口：首次启动时若库为空，灌入演示数据，再交给主服务。
// 本地开发请直接用 `node src/server/index.js`，无需走这里。
//
// 注意：演示数据的初始化是异步进行的，绝不能阻塞服务监听——
// 托管平台只给 30 秒启动窗口，SQLite 在陌生文件系统上可能很慢，
// 初始化卡住会导致整个部署被判为「启动失败」。
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.QD_DB || path.join(DATA_DIR, 'qingdui.db');

function startServer() {
  try {
    require('./src/server/index.js').start();
  } catch (e) {
    console.error('[轻队] 服务启动失败：', e);
    process.exit(1);
  }
}

function seedDemoDataInBackground() {
  if (DB_FILE === ':memory:') return;
  const seedPath = path.join(__dirname, 'scripts', 'seed-demo.js');
  if (!fs.existsSync(seedPath)) return;

  // 延迟到下一个事件循环，确保 HTTP 监听已经就绪
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      process.env.QD_DB = DB_FILE;
      const { seed } = require(seedPath); // 内部会检查库是否为空，不会覆盖已有数据
      seed();
    } catch (e) {
      console.warn('[轻队] 演示数据写入失败，将以空库运行：', e.message);
    }
  });
}

// 环境变量 QD_DB 已设置说明平台/调用方明确指定了数据库位置，直接用它；
// 否则落到 data/ 下的默认路径。
if (!process.env.QD_DB) process.env.QD_DB = DB_FILE;

startServer();
seedDemoDataInBackground();
