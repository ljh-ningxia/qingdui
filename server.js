// 托管平台启动入口：首次启动时若库为空，先灌入演示数据，再交给主服务。
// 本地开发请直接用 `node src/server/index.js`，无需走这里。
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.QD_DB || path.join(DATA_DIR, 'qingdui.db');

function ensureDemoData() {
  if (DB_FILE === ':memory:') return;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  process.env.QD_DB = DB_FILE;

  const seedPath = path.join(__dirname, 'scripts', 'seed-demo.js');
  if (!fs.existsSync(seedPath)) return;

  try {
    const { seed } = require(seedPath);
    seed(); // 内部会检查库是否为空，不会覆盖已有数据
  } catch (e) {
    console.warn('[轻队] 演示数据写入失败，将以空库启动：', e.message);
  }
}

ensureDemoData();

require('./src/server/index.js').start();
