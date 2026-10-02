'use strict';

// 数据库结构。已发布版本及其台词通过触发器禁止 UPDATE / DELETE；
// 已合入的修订与其条目同样冻结，保证“发布版本不可改写”。

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('director','actor')),
  pass_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY,
  number      INTEGER NOT NULL UNIQUE,
  label       TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

-- 台词行：id 为跨版本稳定身份（新版本通过复制保留 id），
-- (version_id, id) 定位某个版本中的具体文本。
CREATE TABLE IF NOT EXISTS lines (
  id          INTEGER NOT NULL,
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  scene       INTEGER NOT NULL,
  sort        INTEGER NOT NULL,
  char_id     INTEGER NOT NULL REFERENCES characters(id),
  content     TEXT NOT NULL,
  PRIMARY KEY (id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_lines_version ON lines(version_id);
CREATE INDEX IF NOT EXISTS idx_lines_char_version ON lines(version_id, char_id);

-- 修订：以某个已发布版本为基准
CREATE TABLE IF NOT EXISTS revisions (
  id           INTEGER PRIMARY KEY,
  base_version INTEGER NOT NULL REFERENCES versions(id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','integrated')),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  integrated_version INTEGER REFERENCES versions(id)
);

-- 修订条目：标明被改台词的原文与新文。
-- base_content 为提交时从基准版本拷贝的原文，用于发布时逐条核对。
CREATE TABLE IF NOT EXISTS revision_items (
  id             INTEGER PRIMARY KEY,
  revision_id    INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  line_id        INTEGER NOT NULL,
  scene          INTEGER NOT NULL,
  char_id        INTEGER NOT NULL REFERENCES characters(id),
  base_content   TEXT NOT NULL,
  new_content    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id           INTEGER PRIMARY KEY,
  revision_ids TEXT NOT NULL,          -- 本次试图发布的修订，JSON 数组
  status       TEXT NOT NULL,          -- 'success' | 'conflict'
  detail       TEXT NOT NULL,          -- JSON
  by_user      INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rehearsals (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  version_id   INTEGER NOT NULL REFERENCES versions(id),  -- 创建时固定引用
  created_at   INTEGER NOT NULL
);

-- 排练与角色多对多
CREATE TABLE IF NOT EXISTS rehearsal_characters (
  rehearsal_id INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  char_id      INTEGER NOT NULL REFERENCES characters(id),
  PRIMARY KEY (rehearsal_id, char_id)
);

-- 演员对所分配角色逐场确认（唯一性保证一场只需确认一次）
CREATE TABLE IF NOT EXISTS confirmations (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  char_id       INTEGER NOT NULL REFERENCES characters(id),
  scene         INTEGER NOT NULL,
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  confirmed_at  INTEGER NOT NULL,
  UNIQUE (rehearsal_id, char_id, scene)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expired INTEGER NOT NULL
);

-- ---- 不可变性触发器 ----
CREATE TRIGGER IF NOT EXISTS trg_versions_immutable
BEFORE UPDATE ON versions
BEGIN
  SELECT RAISE(ABORT, '已发布版本不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_versions_nodelete
BEFORE DELETE ON versions
BEGIN
  SELECT RAISE(ABORT, '已发布版本不可删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_lines_immutable
BEFORE UPDATE ON lines
BEGIN
  SELECT RAISE(ABORT, '已发布版本的台词不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_lines_nodelete
BEFORE DELETE ON lines
BEGIN
  SELECT RAISE(ABORT, '已发布版本的台词不可删除');
END;
`;

// 修订 / 条目冻结触发器（建库后单独追加，便于以后维护）
const FREEZE_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_revisions_freeze
BEFORE UPDATE ON revisions
WHEN OLD.status = 'integrated'
BEGIN
  SELECT RAISE(ABORT, '已合入的修订不可修改');
END;

CREATE TRIGGER IF NOT EXISTS trg_revision_items_no_update
BEFORE UPDATE ON revision_items
BEGIN
  SELECT RAISE(ABORT, '修订条目不可修改，请删除后重建');
END;

CREATE TRIGGER IF NOT EXISTS trg_revision_items_freeze_delete
BEFORE DELETE ON revision_items
WHEN EXISTS (SELECT 1 FROM revisions r WHERE r.id = OLD.revision_id AND r.status = 'integrated')
BEGIN
  SELECT RAISE(ABORT, '已合入修订的条目不可删除');
END;
`;

module.exports = { SCHEMA_SQL, FREEZE_SQL };
