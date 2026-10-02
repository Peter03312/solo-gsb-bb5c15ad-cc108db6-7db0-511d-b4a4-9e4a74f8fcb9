'use strict';

// 初始化数据库：建表 + 写入演示数据（幂等，已存在则跳过种子）。
// 用法：node src/init-db.js
//   同时可设置 SEED=0 只建表不写演示数据。

const fs = require('fs');
const path = require('path');
const { getDb, DB_PATH } = require('./db');
const { hashPassword, now } = require('./util');

function seed(db) {
  const t = now();
  const insertUser = db.prepare(
    `INSERT INTO users (username, name, role, pass_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const directorId = insertUser.run(
    'director', '王导演', 'director', hashPassword('director123'), t
  ).lastInsertRowid;

  const hamletActor = insertUser.run(
    'hamlet', '周 Hamlet', 'actor', hashPassword('actor123'), t
  ).lastInsertRowid;
  const opheliaActor = insertUser.run(
    'ophelia', '吴 Ophelia', 'actor', hashPassword('actor123'), t
  ).lastInsertRowid;
  const ghostActor = insertUser.run(
    'ghost', '郑 Ghost', 'actor', hashPassword('actor123'), t
  ).lastInsertRowid;

  const insChar = db.prepare(
    `INSERT INTO characters (name, actor_id, created_at) VALUES (?, ?, ?)`
  );
  const hamlet = insChar.run('哈姆雷特', hamletActor, t).lastInsertRowid;
  const ophelia = insChar.run('奥菲莉亚', opheliaActor, t).lastInsertRowid;
  const ghost = insChar.run('鬼魂', ghostActor, t).lastInsertRowid;

  // v1
  const v1 = db.prepare(
    `INSERT INTO versions (number, label, created_by, created_at)
     VALUES (1, '首版（初排稿）', ?, ?)`
  ).run(directorId, t).lastInsertRowid;

  const insLine = db.prepare(
    `INSERT INTO lines (id, version_id, scene, sort, char_id, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const linesV1 = [
    [1, 1, 1, hamlet, '生存还是毁灭，这是一个问题。'],
    [2, 1, 1, ghost, '我是你父亲的灵魂。'],
    [3, 1, 2, hamlet, '你可以疑心星星是火把。'],
    [4, 1, 2, ophelia, '哎哟，多么高贵的心陨落了！'],
    [5, 1, 3, hamlet, '演这出戏，我要揪住国王的良心。'],
  ];
  for (const [id, scene, sort, charId, content] of linesV1) {
    insLine.run(id, v1, scene, sort, charId, content);
  }

  // 一个演示排练，固定引用 v1
  const rh = db.prepare(
    `INSERT INTO rehearsals (name, version_id, created_at) VALUES (?, ?, ?)`
  ).run('周三晚排《城堡》', v1, t).lastInsertRowid;
  db.prepare(
    `INSERT INTO rehearsal_characters (rehearsal_id, char_id) VALUES (?, ?)`
  ).run(rh, hamlet);
  db.prepare(
    `INSERT INTO rehearsal_characters (rehearsal_id, char_id) VALUES (?, ?)`
  ).run(rh, ophelia);

  console.log('种子数据已写入');
}

function main() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = getDb();
  initIfEmpty(db);
  db.close();
}

// 供 server.js 首次启动时调用
function initIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) {
    console.log('数据库已有数据，跳过种子。数据库文件：', DB_PATH);
    return false;
  }
  if (process.env.SEED === '0') {
    console.log('SEED=0，仅建表。数据库文件：', DB_PATH);
    return false;
  }
  const tx = db.transaction(() => seed(db));
  tx();
  console.log('初始化完成。数据库文件：', DB_PATH);
  console.log('演示账号：director/director123，hamlet|ophelia|ghost/actor123');
  return true;
}

if (require.main === module) main();

module.exports = { initIfEmpty };
