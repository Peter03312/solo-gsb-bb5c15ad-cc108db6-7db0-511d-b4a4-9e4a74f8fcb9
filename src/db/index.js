'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { SCHEMA_SQL, FREEZE_SQL } = require('./schema');

const DB_PATH = process.env.DB_PATH ||
  path.join(__dirname, '..', '..', 'data', 'app.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(FREEZE_SQL);
  _db = db;
  return db;
}

module.exports = { getDb, DB_PATH };
