'use strict';

const express = require('express');
const { getDb } = require('../db');
// 鉴权由挂载点统一施加（/api/director/* 与 /api/my/*）
const { now } = require('../util');

const directorRouter = express.Router();
const actorRouter = express.Router();

// 某排练在当前引用版本下，每个角色每场的确认状态。
// 规则：确认只计入“当前被分配到该角色”的演员；角色改派后原演员记录不再计入。
function rehearsalStatus(db, rehearsal) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(rehearsal.version_id);
  const chars = db.prepare(`
    SELECT c.id, c.name, c.actor_id, u.name AS actor_name, u.username AS actor_username
    FROM rehearsal_characters rc
    JOIN characters c ON c.id = rc.char_id
    LEFT JOIN users u ON u.id = c.actor_id
    WHERE rc.rehearsal_id = ? ORDER BY c.id`).all(rehearsal.id);

  const scenes = db.prepare(
    'SELECT DISTINCT scene FROM lines WHERE version_id = ? ORDER BY scene'
  ).all(rehearsal.version_id).map(r => r.scene);

  const charMap = new Map(chars.map(c => [c.id, c]));
  const charScenes = new Map();   // charId -> Set(scene)（该角色实际有台词的场次）
  for (const row of db.prepare(
    'SELECT char_id, scene FROM lines WHERE version_id = ? GROUP BY char_id, scene'
  ).all(rehearsal.version_id)) {
    if (!charMap.has(row.char_id)) continue;
    if (!charScenes.has(row.char_id)) charScenes.set(row.char_id, new Set());
    charScenes.get(row.char_id).add(row.scene);
  }

  const confirms = db.prepare(
    'SELECT char_id, scene, actor_id, confirmed_at FROM confirmations WHERE rehearsal_id = ?'
  ).all(rehearsal.id);

  const pending = []; // {char_id, char_name, actor_id, actor_name, scene}
  for (const c of chars) {
    const sceneSet = charScenes.get(c.id) || new Set();
    for (const scene of scenes) {
      if (!sceneSet.has(scene)) continue; // 只确认该角色有台词的场次
      const con = confirms.find(x => x.char_id === c.id && x.scene === scene);
      const valid = con && c.actor_id != null && con.actor_id === c.actor_id;
      if (!valid) {
        pending.push({
          char_id: c.id, char_name: c.name,
          actor_id: c.actor_id || null,
          actor_name: c.actor_id ? c.actor_name : null,
          actor_username: c.actor_id ? c.actor_username : null,
          scene
        });
      }
    }
  }

  return { version, chars, scenes: [...scenes], pending };
}

// ================= 导演端 =================
directorRouter.get('/rehearsals', (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM rehearsals ORDER BY id DESC').all();
  const result = list.map(r => {
    const s = rehearsalStatus(db, r);
    return {
      id: r.id, name: r.name, version_id: r.version_id,
      version_number: s.version ? s.version.number : null,
      pending: s.pending,
      characters: s.chars
    };
  });
  res.json({ rehearsals: result });
});

directorRouter.post('/rehearsals', (req, res) => {
  const db = getDb();
  const name = String((req.body || {}).name || '').trim();
  const versionId = Number((req.body || {}).version_id);
  if (!name) return res.status(400).json({ error: '排练名称必填' });

  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) return res.status(404).json({ error: '无效版本：引用版本不存在' });

  const id = db.prepare(
    'INSERT INTO rehearsals (name, version_id, created_at) VALUES (?, ?, ?)'
  ).run(name, version.id, now()).lastInsertRowid;
  res.status(201).json({ id, version_id: version.id });
});

// 换版（显式操作）：固定引用改为新版本，仅“台词内容发生变化”的角色需重新确认
directorRouter.post('/rehearsals/:id/switch-version', (req, res) => {
  const db = getDb();
  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(req.params.id);
  if (!rehearsal) return res.status(404).json({ error: '排练不存在' });

  const newVersionId = Number((req.body || {}).version_id);
  const newVersion = db.prepare('SELECT * FROM versions WHERE id = ?').get(newVersionId);
  if (!newVersion) return res.status(404).json({ error: '无效版本：目标版本不存在' });
  if (newVersion.id === rehearsal.version_id) {
    return res.status(400).json({ error: '排练已引用该版本' });
  }

  // 找出两个版本间“台词内容发生变化”的角色。
  // 按需求：只有这些角色须重新确认，未变化角色的确认继续有效。
  const changedCharIds = db.prepare(`
    SELECT DISTINCT a.char_id AS char_id
    FROM lines a JOIN lines b ON a.id = b.id
    WHERE a.version_id = ? AND b.version_id = ? AND a.content <> b.content`
  ).all(rehearsal.version_id, newVersion.id).map(r => r.char_id);

  const t = now();
  const reset = db.transaction(() => {
    db.prepare('UPDATE rehearsals SET version_id = ? WHERE id = ?')
      .run(newVersion.id, rehearsal.id);
    // 受影响角色的既有确认全部作废，由演员重新逐场确认
    const del = db.prepare(
      'DELETE FROM confirmations WHERE rehearsal_id = ? AND char_id = ?'
    );
    for (const charId of changedCharIds) del.run(rehearsal.id, charId);
  });
  reset();
  res.json({
    ok: true,
    version_id: newVersion.id,
    reset_char_ids: changedCharIds
  });
});

directorRouter.post('/rehearsals/:id/characters', (req, res) => {
  const db = getDb();
  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(req.params.id);
  if (!rehearsal) return res.status(404).json({ error: '排练不存在' });
  const charId = Number((req.body || {}).char_id);
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    db.prepare(
      'INSERT INTO rehearsal_characters (rehearsal_id, char_id) VALUES (?, ?)'
    ).run(rehearsal.id, char.id);
  } catch (e) {
    return res.status(409).json({ error: '该角色已在此排练中' });
  }
  res.status(201).json({ ok: true });
});

directorRouter.delete('/rehearsals/:id/characters/:charId', (req, res) => {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      'DELETE FROM rehearsal_characters WHERE rehearsal_id = ? AND char_id = ?'
    ).run(req.params.id, req.params.charId);
    db.prepare(
      'DELETE FROM confirmations WHERE rehearsal_id = ? AND char_id = ?'
    ).run(req.params.id, req.params.charId);
  });
  tx();
  res.json({ ok: true });
});

directorRouter.get('/rehearsals/:id', (req, res) => {
  const db = getDb();
  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(req.params.id);
  if (!rehearsal) return res.status(404).json({ error: '排练不存在' });
  const status = rehearsalStatus(db, rehearsal);
  res.json({
    rehearsal: { id: rehearsal.id, name: rehearsal.name, version_id: rehearsal.version_id },
    version: status.version,
    characters: status.chars,
    scenes: status.scenes,
    pending: status.pending
  });
});

// ================= 演员端 =================
// 演员只看得到自己获分配角色所参与的排练
actorRouter.get('/rehearsals', (req, res) => {
  const db = getDb();
  const actorId = req.session.user.id;
  const rows = db.prepare(`
    SELECT r.id, r.name, r.version_id, v.number AS version_number
    FROM rehearsals r
    JOIN rehearsal_characters rc ON rc.rehearsal_id = r.id
    JOIN characters c ON c.id = rc.char_id AND c.actor_id = ?
    JOIN versions v ON v.id = r.version_id
    GROUP BY r.id ORDER BY r.id DESC`).all(actorId);

  const result = rows.map(row => {
    const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(row.id);
    const status = rehearsalStatus(db, rehearsal);
    const myChars = status.chars.filter(c => c.actor_id === actorId);
    const myPending = status.pending.filter(p => p.actor_id === actorId);
    return {
      ...row,
      my_characters: myChars.map(c => ({ id: c.id, name: c.name })),
      pending_scenes: myPending
    };
  });
  res.json({ rehearsals: result });
});

// 演员的排练稿：仅包含自己所分配角色在该排练中的台词
actorRouter.get('/rehearsals/:id/script', (req, res) => {
  const db = getDb();
  const actorId = req.session.user.id;
  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(req.params.id);
  if (!rehearsal) return res.status(404).json({ error: '排练不存在' });

  const myChars = db.prepare(`
    SELECT c.id, c.name FROM rehearsal_characters rc
    JOIN characters c ON c.id = rc.char_id
    WHERE rc.rehearsal_id = ? AND c.actor_id = ?`).all(rehearsal.id, actorId);
  if (myChars.length === 0) {
    return res.status(403).json({ error: '越权访问：你未获分配该排练中的角色' });
  }

  const charIds = myChars.map(c => c.id);
  const placeholders = charIds.map(() => '?').join(',');
  const lines = db.prepare(`
    SELECT l.scene, l.sort, l.char_id, l.content, c.name AS char_name
    FROM lines l JOIN characters c ON c.id = l.char_id
    WHERE l.version_id = ? AND l.char_id IN (${placeholders})
    ORDER BY l.scene, l.sort, l.id`).all(rehearsal.version_id, ...charIds);

  const confirms = db.prepare(`
    SELECT char_id, scene FROM confirmations WHERE rehearsal_id = ? AND actor_id = ?
  `).all(rehearsal.id, actorId);
  const confirmedSet = new Set(confirms.map(c => `${c.char_id}:${c.scene}`));

  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(rehearsal.version_id);
  res.json({
    rehearsal: { id: rehearsal.id, name: rehearsal.name },
    version,
    characters: myChars,
    lines,
    confirmed: [...confirmedSet]
  });
});

// 演员逐场确认自己所分配的角色
actorRouter.post('/rehearsals/:id/confirm', (req, res) => {
  const db = getDb();
  const actorId = req.session.user.id;
  const charId = Number((req.body || {}).char_id);
  const scene = Number((req.body || {}).scene);
  if (!charId || !scene) return res.status(400).json({ error: '需指定角色与场次' });

  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(req.params.id);
  if (!rehearsal) return res.status(404).json({ error: '排练不存在' });

  // 越权校验：角色必须在排练中且当前分配给该演员
  const owns = db.prepare(`
    SELECT c.id FROM rehearsal_characters rc
    JOIN characters c ON c.id = rc.char_id
    WHERE rc.rehearsal_id = ? AND c.id = ? AND c.actor_id = ?`
  ).get(rehearsal.id, charId, actorId);
  if (!owns) {
    return res.status(403).json({ error: '越权访问：该角色未分配给你或不在此排练中' });
  }

  const hasLine = db.prepare(
    'SELECT 1 FROM lines WHERE version_id = ? AND char_id = ? AND scene = ? LIMIT 1'
  ).get(rehearsal.version_id, charId, scene);
  if (!hasLine) return res.status(400).json({ error: '该角色在此场次没有台词' });

  db.prepare(`
    INSERT INTO confirmations (rehearsal_id, char_id, scene, actor_id, confirmed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(rehearsal_id, char_id, scene) DO UPDATE
      SET actor_id = excluded.actor_id, confirmed_at = excluded.confirmed_at
  `).run(rehearsal.id, charId, scene, actorId, now());
  res.json({ ok: true });
});

module.exports = { directorRouter, actorRouter };
