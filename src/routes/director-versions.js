'use strict';

const express = require('express');
const { getDb } = require('../db');
const { now } = require('../util');

const router = express.Router();

// 鉴权由挂载点 app.use('/api/director', requireDirector, ...) 统一施加

// ---------- 角色 ----------
router.get('/characters', (req, res) => {
  const rows = getDb().prepare(`
    SELECT c.id, c.name, c.actor_id, u.name AS actor_name, u.username AS actor_username
    FROM characters c LEFT JOIN users u ON u.id = c.actor_id
    ORDER BY c.id`).all();
  res.json({ characters: rows });
});

router.post('/characters', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '角色名必填' });
  try {
    const info = getDb().prepare(
      'INSERT INTO characters (name, created_at) VALUES (?, ?)'
    ).run(name, now());
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '角色名已存在' });
    }
    throw e;
  }
});

// 角色改派：原演员的全部相关确认在事务内一并作废
router.post('/characters/:id/assign', (req, res) => {
  const db = getDb();
  const charId = Number(req.params.id);
  const actorId = req.body.actor_id == null ? null : Number(req.body.actor_id);

  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });

  if (actorId != null) {
    const actor = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'actor'`).get(actorId);
    if (!actor) return res.status(400).json({ error: '指定用户不是演员' });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE characters SET actor_id = ? WHERE id = ?').run(actorId, charId);
    // 角色改派后原演员的确认不再计入：删除该角色全部确认记录
    db.prepare('DELETE FROM confirmations WHERE char_id = ?').run(charId);
  });
  tx();
  res.json({ ok: true });
});

// ---------- 演员名单 ----------
router.get('/actors', (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, username, name FROM users WHERE role = 'actor' ORDER BY name`
  ).all();
  res.json({ actors: rows });
});

// ---------- 版本 ----------
router.get('/versions', (req, res) => {
  const rows = getDb().prepare(`
    SELECT v.id, v.number, v.label, v.created_at,
           u.name AS created_by_name,
           (SELECT COUNT(*) FROM lines l WHERE l.version_id = v.id) AS line_count
    FROM versions v JOIN users u ON u.id = v.created_by
    ORDER BY v.number DESC`).all();
  res.json({ versions: rows });
});

router.get('/versions/:id/lines', (req, res) => {
  const db = getDb();
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.id);
  if (!version) return res.status(404).json({ error: '无效版本：该版本不存在' });
  const lines = db.prepare(`
    SELECT l.id, l.scene, l.sort, l.char_id, l.content, c.name AS char_name
    FROM lines l JOIN characters c ON c.id = l.char_id
    WHERE l.version_id = ? ORDER BY l.scene, l.sort, l.id`).all(version.id);
  res.json({ version, lines });
});

// 首个版本：导演直接录入全部台词。此后修改必须走修订流程。
router.post('/versions', (req, res) => {
  const db = getDb();
  const { label, lines } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: '首个版本至少包含一条台词' });
  }

  const existing = db.prepare('SELECT COUNT(*) AS c FROM versions').get().c;
  if (existing > 0) {
    return res.status(409).json({
      error: '已有发布版本；后续修改必须基于已发布版本创建修订并发布'
    });
  }

  const charIds = new Set(db.prepare('SELECT id FROM characters').all().map(r => r.id));
  for (const ln of lines) {
    if (![ln.scene, ln.sort, ln.char_id, ln.content].every(v => v !== undefined && v !== null && v !== '')) {
      return res.status(400).json({ error: '每条台词需包含场次、顺序、角色和内容' });
    }
    if (!charIds.has(Number(ln.char_id))) {
      return res.status(400).json({ error: '存在无效角色引用' });
    }
  }

  const t = now();
  const tx = db.transaction(() => {
    const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM versions').get().n;
    const versionId = db.prepare(
      'INSERT INTO versions (number, label, created_by, created_at) VALUES (?, ?, ?, ?)'
    ).run(number, String(label || '').trim() || null, req.session.user.id, t).lastInsertRowid;

    const ins = db.prepare(
      'INSERT INTO lines (id, version_id, scene, sort, char_id, content) VALUES (?, ?, ?, ?, ?, ?)'
    );
    lines.forEach((ln, i) => {
      ins.run(i + 1, versionId, Number(ln.scene), Number(ln.sort), Number(ln.char_id), String(ln.content));
    });
    return { versionId, number };
  });
  res.status(201).json(tx());
});

module.exports = router;
