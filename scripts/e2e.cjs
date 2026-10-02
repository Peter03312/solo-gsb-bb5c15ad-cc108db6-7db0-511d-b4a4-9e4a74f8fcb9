/**
 * 端到端业务流程测试（对已运行的服务器执行）。
 * 用法: BASE=http://127.0.0.1:3210 node scripts/e2e.cjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

async function req(method, path, token, body, expectStatus = 200) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  const acceptable = expectStatus === 200 ? [200, 201] : [expectStatus];
  if (!acceptable.includes(res.status)) {
    throw new Error(`${method} ${path} 期望 ${expectStatus} 得到 ${res.status}: ${text}`);
  }
  return json;
}
const J = (p, t, b, s) => req('POST', p, t, b, s);
const G = (p, t, s = 200) => req('GET', p, t, undefined, s);
const D = (p, t, s = 200) => req('DELETE', p, t, undefined, s);

async function login(u, p) {
  const r = await J('/api/login', null, { username: u, password: p }, 200);
  return r.token;
}

async function main() {
  console.log('— 认证与越权 —');
  await J('/api/login', null, { username: 'director', password: 'wrong' }, 401);
  const director = await login('director', 'director123');
  const lin = await login('lin', 'actor123');
  const chen = await login('chen', 'actor123');
  await G('/api/me', null, 401);
  // 演员不能建剧本/看演员名册
  await J('/api/plays', lin, { title: 'x' }, 403);
  await G('/api/actors', lin, 403);
  check('错误密码 401 / 未登录 401 / 演员越权导演接口 403', true);

  console.log('— 种子数据 —');
  const { plays } = await G('/api/plays', director);
  check('种子剧本存在', plays.length >= 1);
  const playId = plays[0].id;
  const detail = await G(`/api/plays/${playId}`, director);
  check('首版已发布', detail.play.latestVersionId === 1);
  check('种子台词 7 条', detail.lines.length === 7, String(detail.lines.length));
  // 已发布后直接改行台词被拒
  await req('PATCH', `/api/lines/${detail.lines[0].id}`, director, { text: 'x' }, 409);
  check('发布后禁止直接改现行文本（409）', true);

  console.log('— 无效版本 / 越权访问剧本 —');
  await G('/api/versions/99999', director, 404);
  // 周海未派角应 403；陈默在种子排练中被派了船员，可以访问
  const zhou = await login('zhou', 'actor123');
  await G(`/api/plays/${playId}`, zhou, 403);
  check('未派角演员访问剧本 403；已派角演员可访问', true);
  const chenPlay = await G(`/api/plays/${playId}`, chen, 200);
  check('已派角演员可看剧本', !!chenPlay.play);
  check('演员剧本详情只含所派角色台词', chenPlay.lines.every((l) => {
    const r = detail.roles.find((x) => x.id === l.roleId);
    return r.code === 'SAILOR';
  }) && chenPlay.lines.length >= 2, String(chenPlay.lines.length));
  const chenV1 = await G('/api/versions/1', chen, 200);
  check('演员版本视图只含所派角色台词', chenV1.lines.every((l) => l.roleCode === 'SAILOR') && chenV1.lines.length === 3, String(chenV1.lines.length));

  console.log('— 修订提交：必须标明原文且与基准一致 —');
  const line1 = detail.lines[0]; // 守塔人 s1
  const line2 = detail.lines[1]; // 船员 s1
  // 原文错误 -> 409 OLD_TEXT_MISMATCH
  const badRev = await J(`/api/plays/${playId}/revisions`, director, {
    title: '错误原文', baseVersionId: 1, items: [],
  }, 201);
  await J(`/api/revisions/${badRev.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: '瞎写的原文', newText: '新的文本',
  }, 409);
  check('原文与基准不一致时拒绝提交', true);

  // 修订 A：改 line1
  const revA = await J(`/api/plays/${playId}/revisions`, director, { title: '修订A-浪高', baseVersionId: 1 }, 201);
  await J(`/api/revisions/${revA.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚的浪比昨天高得多，灯油还够烧到后半夜。',
  });
  // 修订 B：改 line2（与 A 互不冲突）
  const revB = await J(`/api/plays/${playId}/revisions`, director, { title: '修订B-船舵' }, 201);
  await J(`/api/revisions/${revB.id}/items`, director, {
    action: 'modify', lineId: line2.id, oldText: line2.text, newText: '船舵彻底失灵了，我们只能跟着潮水漂。',
  });
  // 修订 C：也改 line1，同样基于 v1 原文（与 A 冲突，内容不同）
  const revC = await J(`/api/plays/${playId}/revisions`, director, { title: '修订C-同句不同改' }, 201);
  await J(`/api/revisions/${revC.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚风浪不小，但灯油足够撑到天明。',
  });
  // 修订 D：和 A 完全相同的改动（幂等，不算冲突）
  const revD = await J(`/api/plays/${playId}/revisions`, director, { title: '修订D-同改相同' }, 201);
  await J(`/api/revisions/${revD.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚的浪比昨天高得多，灯油还够烧到后半夜。',
  });

  console.log('— 发布 A+B+C：有冲突，整体不生效 —');
  const conflictPub = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revA.id, revB.id, revC.id], note: '尝试1',
  }, 409);
  check('冲突时返回 409', conflictPub.error === 'PUBLISH_CONFLICT');
  check('冲突条目数为 1（C 撞 A）', conflictPub.conflicts.length === 1, JSON.stringify(conflictPub.conflicts));
  check('冲突指明 line1 与修订', conflictPub.conflicts[0].lineId === line1.id && conflictPub.conflicts[0].revisionId === revC.id);
  const stillV1 = await G(`/api/plays/${playId}`, director);
  check('冲突后未生成新版本', stillV1.play.latestVersionId === 1);
  check('冲突后修订仍是 open', (await G(`/api/revisions/${revA.id}`, director)).status === 'open');

  console.log('— 发布 A+D+B：相同改动幂等，互不冲突，合成 v2 —');
  const pub2 = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revA.id, revD.id, revB.id], note: 'v2 合入',
  }, 201);
  check('生成 v2', pub2.newVersion.versionNo === 2);
  check('三个修订都标记 merged', (await G(`/api/revisions/${revD.id}`, director)).status === 'merged');
  const v2 = await G('/api/versions/2', director);
  const v2line1 = v2.lines.find((l) => l.lineId === line1.id);
  const v2line2 = v2.lines.find((l) => l.lineId === line2.id);
  check('v2 含 A 的新文', v2line1.text.includes('后半夜'));
  check('v2 含 B 的新文', v2line2.text.includes('彻底失灵'));
  // v1 快照未变（不可改写）
  const v1 = await G('/api/versions/1', director);
  check('v1 快照保持原文', v1.lines.find((l) => l.lineId === line1.id).text === line1.text);

  console.log('— 修订 C 基于旧原文：发布时核对现行文本，报 text_changed —');
  const pub3 = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revC.id],
  }, 409);
  check('C 报 text_changed 冲突', pub3.conflicts[0].kind === 'text_changed');
  check('冲突含原文与现行文本', pub3.conflicts[0].baseText === line1.text && pub3.conflicts[0].currentText.includes('后半夜'));

  console.log('— 删除修订与发布 —');
  const revDel = await J(`/api/plays/${playId}/revisions`, director, { title: '删一句' }, 201);
  await J(`/api/revisions/${revDel.id}/items`, director, {
    action: 'delete', lineId: line2.id, oldText: '船舵彻底失灵了，我们只能跟着潮水漂。',
  });
  const pub4 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revDel.id] }, 201);
  check('删除后生成 v3', pub4.newVersion.versionNo === 3);
  const v3 = await G('/api/versions/3', director);
  check('v3 中该句已删除', !v3.lines.find((l) => l.lineId === line2.id));
  check('v2 中该句仍在（历史版本不变）', !!(await G('/api/versions/2', director)).lines.find((l) => l.lineId === line2.id));
  // 再拿一个基于 v2 原文想改已删句子的修订 -> line_deleted
  const revZ = await J(`/api/plays/${playId}/revisions`, director, { title: '改已删句', baseVersionId: 2 }, 201);
  // 提交时基准 v2 里还在，允许提交
  await J(`/api/revisions/${revZ.id}/items`, director, {
    action: 'modify', lineId: line2.id, oldText: '船舵彻底失灵了，我们只能跟着潮水漂。', newText: 'x',
  });
  const pub5 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revZ.id] }, 409);
  check('现行已删 -> line_deleted 冲突', pub5.conflicts[0].kind === 'line_deleted');

  console.log('— 新增台词修订 —');
  const revAdd = await J(`/api/plays/${playId}/revisions`, director, { title: '加一句' }, 201);
  await J(`/api/revisions/${revAdd.id}/items`, director, {
    action: 'add', sceneId: detail.scenes[0].id, roleId: detail.roles[1].id, newText: '快看，灯塔的光转过来了！',
  });
  const pub6 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revAdd.id] }, 201);
  check('新增合入 v4', pub6.newVersion.versionNo === 4);
  const v4 = await G('/api/versions/4', director);
  check('v4 含新增句', v4.lines.some((l) => l.text === '快看，灯塔的光转过来了！'));
  // 作废 open 修订
  await J(`/api/revisions/${revC.id}/abandon`, director, {}, 200);
  await J(`/api/revisions/${revC.id}/abandon`, director, {}, 400);
  check('作废幂等保护（再次作废 400）', true);

  console.log('— 版本不可改写（数据库触发器） —');
  const { db } = require('/workspace/src/db.js');
  let blockedUpdate = false;
  try { db.prepare('UPDATE versions SET note = ? WHERE id = 1').run('hacked'); } catch { blockedUpdate = true; }
  let blockedVL = false;
  try { db.prepare('UPDATE version_lines SET text = ? WHERE line_id = 1 AND version_id = 1').run('h'); } catch { blockedVL = true; }
  let blockedDel = false;
  try { db.prepare('DELETE FROM versions WHERE id = 1').run(); } catch { blockedDel = true; }
  check('versions UPDATE/DELETE 与 version_lines UPDATE 被触发器拒绝', blockedUpdate && blockedVL && blockedDel);

  console.log('— 排练：创建固定版本、派角、确认、换版 —');
  // 无效版本创建排练
  await J(`/api/plays/${playId}/rehearsals`, director, { versionId: 99999 }, 400);
  const reh = await J(`/api/plays/${playId}/rehearsals`, director, { versionId: 1, name: '测试排练固定v1' }, 201);
  check('排练创建时固定 v1', reh.versionId === 1);
  const actors = (await G('/api/actors', director)).actors;
  const zhouId = actors.find((a) => a.username === 'zhou').id;
  const linId = actors.find((a) => a.username === 'lin').id;
  const keeperRole = detail.roles.find((r) => r.code === 'KEEPER').id;
  const sailorRole = detail.roles.find((r) => r.code === 'SAILOR').id;
  await J(`/api/rehearsals/${reh.id}/cast`, director, { roleId: keeperRole, actorId: linId }, 201);
  // 演员不能看未派角排练
  await G(`/api/rehearsals/${reh.id}/script`, chen, 403);
  // 演员不能给别人的角色确认
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: sailorRole, sceneId: detail.scenes[0].id }, 403);
  // 无效场次确认
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: 99999 }, 400);
  check('越权确认 / 无效场次被拒', true);

  // 林晚确认两个场次（v1 守塔人：s1 第1句、s2 第5/7句）
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: detail.scenes[0].id });
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: detail.scenes[1].id });
  let rehView = await G(`/api/rehearsals/${reh.id}`, director);
  check('林晚两场确认后，其角色无待确认', !rehView.pending.some((p) => p.actorId === linId));

  // 换版到 v2：守塔人 s1 文本变了，s2 没变 -> s1 重新待确认，s2 保留
  const sw = await J(`/api/rehearsals/${reh.id}/switch-version`, director, { versionId: 2 }, 200);
  const linPend = sw.pending.filter((p) => p.actorId === linId);
  check('换版 v2：守塔人 s1 需重新确认', linPend.some((p) => p.sceneId === detail.scenes[0].id), JSON.stringify(linPend));
  check('换版 v2：守塔人 s2（文本未变）不需确认', !linPend.some((p) => p.sceneId === detail.scenes[1].id));

  // 改派：守塔人改派给周海 -> 原林晚确认不计入；周海两场都待确认
  await J(`/api/rehearsals/${reh.id}/cast`, director, { roleId: keeperRole, actorId: zhouId }, 200);
  rehView = await G(`/api/rehearsals/${reh.id}`, director);
  const zhouPend = rehView.pending.filter((p) => p.actorId === zhouId);
  check('改派后新演员待确认（s1）', zhouPend.some((p) => p.sceneId === detail.scenes[0].id));
  // s2 保留了林晚的旧确认 -> 周海看到的原因是“已改派，原确认不计入”
  const s2p = zhouPend.find((p) => p.sceneId === detail.scenes[1].id);
  check('s2 标注“原演员确认不计入”', !!s2p && s2p.reason.includes('改派'), s2p?.reason);
  check('改派后原演员不再出现在待确认（她已无角色）', !rehView.pending.some((p) => p.actorId === linId));
  // 周海用演员视角看稿，只能看到守塔人台词
  const zhouToken = await login('zhou', 'actor123');
  const script = await G(`/api/rehearsals/${reh.id}/script`, zhouToken);
  check('演员排练稿只含所派角色', script.lines.every((l) => l.roleId === keeperRole) && script.lines.length > 0);

  // 换版到 v3（删掉了船员的句子）；未派船员，只看守塔人：v3 守塔人内容与 v2 相同 => 无需再确认
  // 先把 s1 确认掉
  await J(`/api/rehearsals/${reh.id}/confirm`, zhouToken, { roleId: keeperRole, sceneId: detail.scenes[0].id });
  await J(`/api/rehearsals/${reh.id}/confirm`, zhouToken, { roleId: keeperRole, sceneId: detail.scenes[1].id });
  const sw3 = await J(`/api/rehearsals/${reh.id}/switch-version`, director, { versionId: 3 }, 200);
  check('v2→v3 守塔人无文本变化 => 无待确认', !sw3.pending.some((p) => p.actorId === zhouId), JSON.stringify(sw3.pending));

  console.log('— 待确认演员与冲突详情展示 —');
  const dash = await G('/api/dashboard', director);
  check('总览含每个排练的 pending', Array.isArray(dash.rehearsals[0].pending));
  check('总览含冲突详情', dash.recentConflicts.some((c) => c.details.length > 0));
  const attempts = (await G(`/api/plays/${playId}/publish-attempts`, director)).attempts;
  check('发布尝试历史含成功与冲突两种', attempts.some((a) => a.hadConflict) && attempts.some((a) => !a.hadConflict));

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常中断:', e.message);
  process.exit(1);
});
