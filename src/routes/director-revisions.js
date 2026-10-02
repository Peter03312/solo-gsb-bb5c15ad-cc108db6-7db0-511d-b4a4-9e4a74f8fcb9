'use strict';

const express = require('express');
const { getDb } = require('../db');
const { now } = require('../util');

const router = express.Router();

// 鉴权由挂载点统一施加

// 当前最高版本（即现行文本）
function latestVersion(db) {
  return db.prepare('SELECT * FROM versions ORDER BY number DESC LIMIT 1').get();
}

// ---------- 修订 ----------
router.get('/revisions', (req, res) => {
  const db = getDb();
  const revisions = db.prepare(`
    SELECT r.*, v.number AS base_number,
           (SELECT COUNT(*) FROM revision_items i WHERE i.revision_id = r.id) AS item_count
    FROM revisions r JOIN versions v ON v.id = r.base_version
    ORDER BY r.status, r.id DESC`).all();
  for (const r of revisions) {
    r.items = db.prepare(`
      SELECT i.*, c.name AS char_name
      FROM revision_items i JOIN characters c ON c.id = i.char_id
      WHERE i.revision_id = ? ORDER BY i.id`).all(r.id);
  }
  res.json({ revisions });
});

// 创建修订：以某个已发布版本为基准
router.post('/revisions', (req, res) => {
  const db = getDb();
  const baseVersionId = Number((req.body || {}).base_version_id);
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ error: '修订标题必填' });

  const base = db.prepare('SELECT * FROM versions WHERE id = ?').get(baseVersionId);
  if (!base) return res.status(404).json({ error: '无效版本：基准版本不存在' });

  const id = db.prepare(
    `INSERT INTO revisions (base_version, title, created_by, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(base.id, title, req.session.user.id, now()).lastInsertRowid;
  res.status(201).json({ id });
});

// 提交一条改动：必须标明被改台词原文与新文
router.post('/revisions/:id/items', (req, res) => {
  const db = getDb();
  const revision = db.prepare('SELECT * FROM revisions WHERE id = ?').get(req.params.id);
  if (!revision) return res.status(404).json({ error: '修订不存在' });
  if (revision.status !== 'open') return res.status(409).json({ error: '该修订已合入，不可再改' });

  const { line_id, new_content } = req.body || {};
  if (line_id == null || typeof new_content !== 'string' || !new_content.trim()) {
    return res.status(400).json({ error: '需指定被改台词并提供新文' });
  }

  // 从基准版本取现行原文
  const line = db.prepare(
    'SELECT * FROM lines WHERE id = ? AND version_id = ?'
  ).get(Number(line_id), revision.base_version);
  if (!line) {
    return res.status(404).json({ error: '基准版本中不存在该台词（无效版本或无效台词）' });
  }

  const dup = db.prepare(
    'SELECT id FROM revision_items WHERE revision_id = ? AND line_id = ?'
  ).get(revision.id, line.id);
  if (dup) return res.status(409).json({ error: '该修订已包含这条台词的改动，请先删除原条目' });

  const info = db.prepare(
    `INSERT INTO revision_items (revision_id, line_id, scene, char_id, base_content, new_content)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(revision.id, line.id, line.scene, line.char_id, line.content, String(new_content));

  res.status(201).json({
    id: info.lastInsertRowid,
    base_content: line.content
  });
});

router.delete('/revisions/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const info = db.prepare(
    `DELETE FROM revision_items WHERE id = ? AND revision_id = ?`
  ).run(req.params.itemId, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '条目不存在' });
  res.json({ ok: true });
});

router.delete('/revisions/:id', (req, res) => {
  const db = getDb();
  const revision = db.prepare('SELECT * FROM revisions WHERE id = ?').get(req.params.id);
  if (!revision) return res.status(404).json({ error: '修订不存在' });
  if (revision.status !== 'open') return res.status(409).json({ error: '已合入修订不可删除' });
  db.prepare('DELETE FROM revision_items WHERE revision_id = ?').run(revision.id);
  db.prepare('DELETE FROM revisions WHERE id = ?').run(revision.id);
  res.json({ ok: true });
});

// ---------- 发布：逐条核对现行文本 ----------
// 规则：
//  - 所有待发布修订必须基于同一基准版本（即上一发布版）；
//  - 逐条拿条目原文(base_content)与现行版本文本核对；不一致即冲突；
//  - 同一批次中多个修订改了同一条台词也视为相互冲突；
//  - 存在任意冲突 => 本次发布整体不生效，返回 409 与冲突详情；
//  - 全部不冲突 => 复制现行版本为新版本并套用改动，修订标记 integrated。
router.post('/publish', (req, res) => {
  const db = getDb();
  const revisionIds = (req.body && req.body.revision_ids) || [];
  if (!Array.isArray(revisionIds) || revisionIds.length === 0) {
    return res.status(400).json({ error: '请选择至少一个修订' });
  }

  const current = latestVersion(db);
  if (!current) return res.status(409).json({ error: '尚无任何版本，请先创建首个版本' });

  const revisions = revisionIds
    .map(id => db.prepare('SELECT * FROM revisions WHERE id = ?').get(id))
    .filter(Boolean);
  if (revisions.length !== revisionIds.length) {
    return res.status(404).json({ error: '存在无效修订' });
  }
  if (revisions.some(r => r.status !== 'open')) {
    return res.status(409).json({ error: '只能发布处于开放状态的修订' });
  }
  // 修订可基于任意已发布版本；能否合入完全取决于逐条核对现行文本的结果。

  // 逐条核对现行文本
  const currentLineStmt = db.prepare(
    'SELECT * FROM lines WHERE id = ? AND version_id = ?'
  );
  const conflicts = [];
  const seen = new Map(); // line_id -> 首个改动条目，用于检测互改
  const accepted = [];    // {revisionId, item, line}

  for (const revision of revisions) {
    const items = db.prepare('SELECT * FROM revision_items WHERE revision_id = ?').all(revision.id);
    for (const item of items) {
      const line = currentLineStmt.get(item.line_id, current.id);
      if (!line) {
        conflicts.push({
          revision_id: revision.id, revision_title: revision.title,
          line_id: item.line_id, scene: item.scene,
          reason: '台词在现行版本中不存在',
          expected: item.base_content, actual: null
        });
        continue;
      }
      if (line.content !== item.base_content) {
        conflicts.push({
          revision_id: revision.id, revision_title: revision.title,
          line_id: item.line_id, scene: item.scene,
          reason: '原文已变化',
          expected: item.base_content, actual: line.content
        });
        continue;
      }
      if (seen.has(item.line_id)) {
        const first = seen.get(item.line_id);
        conflicts.push({
          revision_id: revision.id, revision_title: revision.title,
          line_id: item.line_id, scene: item.scene,
          reason: `与修订 #${first.revision_id}《${first.revision_title}》修改同一条台词`,
          expected: item.base_content, actual: line.content
        });
        continue;
      }
      seen.set(item.line_id, { revision_id: revision.id, revision_title: revision.title });
      accepted.push({ revisionId: revision.id, item, line });
    }
  }

  const attempt = {
    revision_ids: JSON.stringify(revisionIds),
    detail: JSON.stringify({
      base_version: current.number,
      conflicts,
      accepted_count: accepted.length
    })
  };

  if (conflicts.length > 0) {
    // 本次发布不生效：仅记录尝试，不产生新版本，修订保持 open
    db.prepare(
      `INSERT INTO publish_attempts (revision_ids, status, detail, by_user, created_at)
       VALUES (?, 'conflict', ?, ?, ?)`
    ).run(attempt.revision_ids, attempt.detail, req.session.user.id, now());
    return res.status(409).json({
      error: '存在冲突，本次发布不生效',
      current_version: current.number,
      conflicts
    });
  }

  const t = now();
  const result = db.transaction(() => {
    const number = current.number + 1;
    const newVersionId = db.prepare(
      'INSERT INTO versions (number, label, created_by, created_at) VALUES (?, ?, ?, ?)'
    ).run(number, null, req.session.user.id, t).lastInsertRowid;

    // 复制现行版本全部台词（保留跨版本行 id），插入时即套用不冲突的改动。
    // 不使用 UPDATE：任何已存在的行都受不可变触发器保护。
    const changeMap = new Map(accepted.map(a => [a.item.line_id, a.item.new_content]));
    const ins = db.prepare(
      'INSERT INTO lines (id, version_id, scene, sort, char_id, content) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const currentLines = db.prepare('SELECT * FROM lines WHERE version_id = ?').all(current.id);
    for (const l of currentLines) {
      ins.run(l.id, newVersionId, l.scene, l.sort, l.char_id,
        changeMap.has(l.id) ? changeMap.get(l.id) : l.content);
    }

    for (const revision of revisions) {
      db.prepare(
        'UPDATE revisions SET status = ?, integrated_version = ? WHERE id = ?'
      ).run('integrated', newVersionId, revision.id);
    }

    db.prepare(
      `INSERT INTO publish_attempts (revision_ids, status, detail, by_user, created_at)
       VALUES (?, 'success', ?, ?, ?)`
    ).run(attempt.revision_ids, attempt.detail, req.session.user.id, t);

    return { newVersionId, number, changed_line_ids: accepted.map(a => a.item.line_id) };
  })();

  res.status(201).json({
    ok: true,
    new_version: result.number,
    new_version_id: result.newVersionId,
    changed_line_ids: result.changed_line_ids
  });
});

// 最近发布尝试（冲突详情留痕）
router.get('/publish/attempts', (req, res) => {
  const rows = getDb().prepare(`
    SELECT id, revision_ids, status, detail, created_at
    FROM publish_attempts ORDER BY id DESC LIMIT 20`).all()
    .map(r => ({ ...r, revision_ids: JSON.parse(r.revision_ids), detail: JSON.parse(r.detail) }));
  res.json({ attempts: rows });
});

module.exports = router;
