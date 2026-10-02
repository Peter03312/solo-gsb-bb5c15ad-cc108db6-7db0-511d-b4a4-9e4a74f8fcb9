'use strict';

// 端到端 API 行为测试：node test/e2e.js
// 使用独立临时数据库，不依赖 data/app.db
process.env.DB_PATH = require('path').join(__dirname, 'test-e2e.db');
process.env.SEED_ON_START = '0';

const assert = require('assert');
const fs = require('fs');

const BASE = 'http://localhost:3999';
process.env.PORT = '3999';

let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }

async function req(jar, method, url, body, expectStatus = 200) {
  const res = await fetch(BASE + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...((jar && jar.init.headers) || {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== expectStatus) {
    throw new Error(`[${method} ${url}] 期望 ${expectStatus}，得到 ${res.status}：${JSON.stringify(data)}`);
  }
  return data;
}
function cookieJar() {
  const jar = {};
  return {
    setFrom(res) {
      const sc = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of sc) jar.c = c.split(';')[0];
    },
    get init() { return { headers: jar.c ? { Cookie: jar.c } : {} }; }
  };
}

async function login(username, password) {
  const jar = cookieJar();
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.strictEqual(res.status, 200, `${username} 登录`);
  jar.setFrom(res);
  return jar;
}

async function raw(jar, method, url, body) {
  return fetch(BASE + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...((jar && jar.init.headers) || {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function main() {
  // 启动服务器
  require('../src/server');
  await new Promise(r => setTimeout(r, 800));

  const db = require('../src/db').getDb();
  const { hashPassword, now } = require('../src/util');
  // 自建最小数据
  const t = now();
  const insUser = db.prepare(`INSERT INTO users (username,name,role,pass_hash,created_at) VALUES (?,?,?,?,?)`);
  const director = insUser.run('dir', '导演', 'director', hashPassword('p'), t).lastInsertRowid;
  const actorA = insUser.run('a', '演员甲', 'actor', hashPassword('p'), t).lastInsertRowid;
  const actorB = insUser.run('b', '演员乙', 'actor', hashPassword('p'), t).lastInsertRowid;
  const insChar = db.prepare(`INSERT INTO characters (name, actor_id, created_at) VALUES (?,?,?)`);
  const charX = insChar.run('角色X', actorA, t).lastInsertRowid;
  const charY = insChar.run('角色Y', actorB, t).lastInsertRowid;

  const dir = await login('dir', 'p');
  const a = await login('a', 'p');
  const b = await login('b', 'p');

  console.log('— 鉴权 —');
  let r = await raw(a, 'GET', '/director/versions');
  assert.strictEqual(r.status, 403); ok('演员访问导演接口 403');
  r = await raw(null, 'POST', '/director/revisions', {});
  assert.strictEqual(r.status, 401); ok('未登录 401');

  console.log('— 首版 —');
  r = await raw(dir, 'POST', '/director/versions', {
    lines: [
      { scene: 1, sort: 1, char_id: charX, content: 'X1 原文' },
      { scene: 1, sort: 2, char_id: charY, content: 'Y1 原文' },
      { scene: 2, sort: 1, char_id: charX, content: 'X2 原文' },
      { scene: 3, sort: 1, char_id: charY, content: 'Z1 原文' }
    ]
  });
  assert.strictEqual(r.status, 201);
  const v1 = (await r.json()).versionId;
  ok('创建首版 v1');

  r = await raw(dir, 'POST', '/director/versions', { lines: [{ scene: 1, sort: 1, char_id: charX, content: 'z' }] });
  assert.strictEqual(r.status, 409); ok('已有版本后禁止再直接建版');

  // 直接 SQL 改已发布版本应被触发器拒绝
  assert.throws(() => db.prepare('UPDATE lines SET content=? WHERE version_id=?').run('hack', v1),
    /不可改写/);
  assert.throws(() => db.prepare('DELETE FROM versions WHERE id=?').run(v1), /不可删除/);
  ok('触发器禁止改写/删除已发布版本');

  console.log('— 修订与冲突发布 —');
  // 两个修订都基于 v1，都改 line 1 => 互相冲突
  const rev1 = (await req(dir, 'POST', '/director/revisions', { title: '修订一', base_version_id: v1 }, 201)).id;
  const rev2 = (await req(dir, 'POST', '/director/revisions', { title: '修订二', base_version_id: v1 }, 201)).id;

  await req(dir, 'POST', `/director/revisions/${rev1}/items`, { line_id: 1, new_content: 'X1 修订一' }, 201);
  await req(dir, 'POST', `/director/revisions/${rev2}/items`, { line_id: 1, new_content: 'X1 修订二' }, 201);
  // rev2 再改一条不冲突的
  await req(dir, 'POST', `/director/revisions/${rev2}/items`, { line_id: 2, new_content: 'Y1 修订二' }, 201);
  ok('提交改动须带原文（服务端从基准版快照）');

  // 无效台词
  r = await raw(dir, 'POST', `/director/revisions/${rev1}/items`, { line_id: 999, new_content: 'x' });
  assert.strictEqual(r.status, 404); ok('基准版本中不存在的台词 → 404');

  let pub = await raw(dir, 'POST', '/director/publish', { revision_ids: [rev1, rev2] });
  assert.strictEqual(pub.status, 409);
  const conflictBody = await pub.json();
  assert.strictEqual(conflictBody.conflicts.length, 1);
  assert.match(conflictBody.conflicts[0].reason, /同一条台词|原文已变化/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM versions').get().c, 1, '冲突时不产生新版本');
  ok('同台词互改 → 409 且本次发布不生效');

  // 删除 rev1 的冲突条目，仅发布 rev2（两条不冲突修改）
  // rev1 删掉
  const rev1Item = db.prepare('SELECT id FROM revision_items WHERE revision_id=?').get(rev1);
  await req(dir, 'DELETE', `/director/revisions/${rev1}/items/${rev1Item.id}`, undefined, 200);
  pub = await req(dir, 'POST', '/director/publish', { revision_ids: [rev2] }, 201);
  const v2Id = pub.new_version_id;
  assert.strictEqual(pub.new_version, 2);
  ok('互不冲突修订发布生成 v2');

  const v2lines = (await req(dir, 'GET', `/director/versions/${v2Id}/lines`)).lines;
  const l1 = v2lines.find(x => x.id === 1), l2 = v2lines.find(x => x.id === 2), l3 = v2lines.find(x => x.id === 3);
  assert.strictEqual(l1.content, 'X1 修订二');
  assert.strictEqual(l2.content, 'Y1 修订二');
  assert.strictEqual(l3.content, 'X2 原文');
  ok('新版本保留行 ID，仅改动条目生效，其余沿用原文');

  // rev1 基于旧版 v1：再给它加两条改动——
  //   line1（原文 X1 原文）在现行 v2 中已被 rev2 改动 => 冲突
  //   line3（原文 X2 原文）在现行 v2 中未变 => 可合入
  await req(dir, 'POST', `/director/revisions/${rev1}/items`, { line_id: 1, new_content: 'X1 迟到再改' }, 201);
  await req(dir, 'POST', `/director/revisions/${rev1}/items`, { line_id: 3, new_content: 'X2 迟到的改' }, 201);
  r = await raw(dir, 'POST', '/director/publish', { revision_ids: [rev1] });
  assert.strictEqual(r.status, 409);
  const staleBody = await r.json();
  assert.strictEqual(staleBody.conflicts.length, 1);
  const cLine1 = staleBody.conflicts[0];
  assert.strictEqual(cLine1.line_id, 1);
  assert.strictEqual(cLine1.reason, '原文已变化');
  assert.strictEqual(cLine1.expected, 'X1 原文');
  assert.strictEqual(cLine1.actual, 'X1 修订二');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM versions').get().c, 2, '冲突时不产生新版本');
  ok('修订基于旧版且条目原文已被他人改动 → 409，本次发布不生效（同修订内不冲突条目也不生效）');

  // 删除冲突条目后，剩下 line3 在现行版仍为原文，可干净合入 => v3
  const staleItems = db.prepare('SELECT id, line_id FROM revision_items WHERE revision_id=?').all(rev1);
  await req(dir, 'DELETE', `/director/revisions/${rev1}/items/${staleItems.find(i => i.line_id === 1).id}`, undefined, 200);
  let pubx = await req(dir, 'POST', '/director/publish', { revision_ids: [rev1] }, 201);
  const v3Id = pubx.new_version_id;
  assert.strictEqual(pubx.new_version, 3);
  ok('修订基于旧版但条目原文在现行版未变 → 可合入新版 v3');

  // 两个不同基准版本的修订（v2 / v3）改不同行，互不冲突，可合入同一新版本 v4
  const rev5 = (await req(dir, 'POST', '/director/revisions', { title: '修订五', base_version_id: v2Id }, 201)).id;
  const rev6 = (await req(dir, 'POST', '/director/revisions', { title: '修订六', base_version_id: v3Id }, 201)).id;
  await req(dir, 'POST', `/director/revisions/${rev5}/items`, { line_id: 4, new_content: 'Z1 五五' }, 201);
  await req(dir, 'POST', `/director/revisions/${rev6}/items`, { line_id: 2, new_content: 'Y1 六六' }, 201);
  pubx = await req(dir, 'POST', '/director/publish', { revision_ids: [rev5, rev6] }, 201);
  assert.strictEqual(pubx.new_version, 4);
  const v4lines = (await req(dir, 'GET', `/director/versions/${pubx.new_version_id}/lines`)).lines;
  assert.strictEqual(v4lines.find(x => x.id === 4).content, 'Z1 五五');
  assert.strictEqual(v4lines.find(x => x.id === 2).content, 'Y1 六六');
  assert.strictEqual(v4lines.find(x => x.id === 3).content, 'X2 迟到的改');
  ok('不同基准、互不冲突的修订合入同一新版 v4');

  // 再发布一个基于旧版 v2、改 line4 的修订：line4 现行文本已被 rev5 改动 => 冲突
  const rev7 = (await req(dir, 'POST', '/director/revisions', { title: '修订七', base_version_id: v2Id }, 201)).id;
  await req(dir, 'POST', `/director/revisions/${rev7}/items`, { line_id: 4, new_content: 'Z1 七七' }, 201);
  r = await raw(dir, 'POST', '/director/publish', { revision_ids: [rev7] });
  assert.strictEqual(r.status, 409);
  const body7 = await r.json();
  assert.strictEqual(body7.conflicts[0].reason, '原文已变化');
  assert.strictEqual(body7.conflicts[0].expected, 'Z1 原文');
  assert.strictEqual(body7.conflicts[0].actual, 'Z1 五五');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM versions').get().c, 4, '冲突发布不增加版本');
  ok('现行原文已变 → 冲突详情含 expected/actual，发布不生效');

  // 已合入修订冻结
  assert.throws(() => db.prepare('UPDATE revisions SET title=? WHERE id=?').run('x', rev5), /不可修改/);
  ok('已合入修订不可修改');

  console.log('— 排练 / 确认 / 换版 / 改派 —');
  // 排练创建固定引用 v2
  const rh = (await req(dir, 'POST', '/director/rehearsals', { name: '联排', version_id: v2Id }, 201)).id;
  await req(dir, 'POST', `/director/rehearsals/${rh}/characters`, { char_id: charX }, 201);
  await req(dir, 'POST', `/director/rehearsals/${rh}/characters`, { char_id: charY }, 201);

  // 无效版本
  r = await raw(dir, 'POST', '/director/rehearsals', { name: 'x', version_id: 9999 });
  assert.strictEqual(r.status, 404); ok('排练引用无效版本 → 404');

  // 演员甲(X) 看到排练，乙(Y) 也能；未分配角色的不行（这里都分配了）
  let my = await req(a, 'GET', '/my/rehearsals');
  assert.strictEqual(my.rehearsals.length, 1);
  assert.deepStrictEqual(my.rehearsals[0].pending_scenes.map(p => p.scene).sort(), [1, 2]);
  ok('演员只看到自己角色的排练，初始两场待确认');

  // 越权：甲访问乙的台词确认（Y）
  r = await raw(a, 'POST', `/my/rehearsals/${rh}/confirm`, { char_id: charY, scene: 1 });
  assert.strictEqual(r.status, 403); ok('替他人角色确认 → 403');

  // 甲确认 X 第1场；乙确认 Y 第1、3场；X 第2场留作待确认
  await req(a, 'POST', `/my/rehearsals/${rh}/confirm`, { char_id: charX, scene: 1 }, 200);
  await req(b, 'POST', `/my/rehearsals/${rh}/confirm`, { char_id: charY, scene: 1 }, 200);
  await req(b, 'POST', `/my/rehearsals/${rh}/confirm`, { char_id: charY, scene: 3 }, 200);

  let status = (await req(dir, 'GET', `/director/rehearsals/${rh}`));
  assert.strictEqual(status.pending.length, 1);
  assert.strictEqual(status.pending[0].char_id, charX);
  assert.strictEqual(status.pending[0].scene, 2);
  ok('导演端看待确认：仅剩 X 第2场');

  // 演员甲的排练稿只含 X 的台词，不含 Y
  const script = await req(a, 'GET', `/my/rehearsals/${rh}/script`);
  assert.ok(script.lines.every(l => l.char_id === charX));
  assert.strictEqual(script.lines.length, 2);
  assert.deepStrictEqual(script.confirmed, [`${charX}:1`]);
  ok('演员排练稿仅含本人角色台词与确认状态');

  // 越权：甲访问不存在/未参与的排练 —— 构造另一个无 X 的排练
  const rh2 = (await req(dir, 'POST', '/director/rehearsals', { name: '只Y', version_id: v2Id }, 201)).id;
  await req(dir, 'POST', `/director/rehearsals/${rh2}/characters`, { char_id: charY }, 201);
  r = await raw(a, 'GET', `/my/rehearsals/${rh2}/script`);
  assert.strictEqual(r.status, 403);
  r = await raw(a, 'GET', `/my/rehearsals/9999/script`);
  assert.strictEqual(r.status, 404);
  ok('未参与排练 403；无效排练 404');

  // 换版 v2 -> v3：v3 相对 v2 仅 line3(X,场2) 内容变化 => 只需 X 重新确认；Y 不受影响
  const sw = await req(dir, 'POST', `/director/rehearsals/${rh}/switch-version`, { version_id: v3Id }, 200);
  assert.deepStrictEqual(sw.reset_char_ids, [charX]);
  status = await req(dir, 'GET', `/director/rehearsals/${rh}`);
  assert.deepStrictEqual(
    status.pending.map(p => `${p.char_id}:${p.scene}`).sort(),
    [`${charX}:1`, `${charX}:2`]);
  ok('换版仅重置台词变化角色(X) 的全部场次；Y 确认保留');

  // 甲重新逐场确认后全部完成
  await req(a, 'POST', `/my/rehearsals/${rh}/confirm`, { char_id: charX, scene: 1 }, 200);
  await req(a, 'POST', `/my/rehearsals/${rh}/confirm`, { char_id: charX, scene: 2 }, 200);
  status = await req(dir, 'GET', `/director/rehearsals/${rh}`);
  assert.strictEqual(status.pending.length, 0);
  ok('重新确认后无待办');

  // 角色改派 X: 甲 -> 乙？乙已有 Y，改派给一个新演员；直接把 X 改派为 actorB
  await req(dir, 'POST', `/director/characters/${charX}/assign`, { actor_id: actorB }, 200);
  status = await req(dir, 'GET', `/director/rehearsals/${rh}`);
  // X 的场次1、2 都需乙重新确认；Y 是乙自己确认的，仍有效
  const pend = status.pending;
  assert.deepStrictEqual(pend.map(p => `${p.char_id}:${p.scene}`).sort(), [`${charX}:1`, `${charX}:2`]);
  ok('改派后原演员确认不计入，X 两场重新待确认（Y 保持已确认）');

  // 甲已无任何角色在该排练
  my = await req(a, 'GET', '/my/rehearsals');
  assert.strictEqual(my.rehearsals.length, 0);
  ok('改派后甲看不到该排练');

  console.log(`\n全部通过（${passed} 项断言）`);
  process.exit(0);
}

main().catch(e => { console.error('测试失败:', e); process.exit(1); });
