const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

let db = null;

function openDb(file) {
  if (db) return db;
  const target = file || process.env.QD_DB || path.join(__dirname, '..', '..', 'data', 'qingdui.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec(SCHEMA);
  return db;
}

function getDb() {
  if (!db) openDb();
  return db;
}

// 事务封装（node:sqlite 无内置 transaction helper）
function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

function one(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}
function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}
function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { openDb, getDb, tx, one, all, run, closeDb };
