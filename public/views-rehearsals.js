/* 导演：排练与确认 + 总览 */
async function loadRehearsalsTab() {
  const panel = document.getElementById('tab-rehearsals');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  if (!state.plays.length) await refreshPlayList();
  const { rehearsals } = await api('GET', '/api/rehearsals');
  panel.innerHTML = '';

  const create = el(`
    <div class="card">
      <h2>创建排练（创建时固定引用一个版本，换版须显式操作）</h2>
      <form id="newRehForm" class="flex">
        <select name="playId" required></select>
        <select name="versionId" required></select>
        <input name="name" placeholder="排练名称（可选）" />
        <button class="btn primary" type="submit">创建</button>
      </form>
    </div>`);
  const playSel = create.querySelector('[name=playId]');
  const verSel = create.querySelector('[name=versionId]');
  playSel.innerHTML = state.plays
    .filter((p) => p.latestVersionId)
    .map((p) => `<option value="${p.id}">《${esc(p.title)}》</option>`)
    .join('');
  async function fillVersions() {
    if (!playSel.value) { verSel.innerHTML = ''; return; }
    const { versions } = await api('GET', `/api/plays/${playSel.value}/versions`);
    verSel.innerHTML = versions
      .slice()
      .reverse()
      .map((v) => `<option value="${v.id}">固定引用 v${v.versionNo}</option>`)
      .join('');
  }
  playSel.addEventListener('change', fillVersions);
  fillVersions();
  create.querySelector('#newRehForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/plays/${fd.get('playId')}/rehearsals`, {
        versionId: Number(fd.get('versionId')),
        name: fd.get('name'),
      });
      toast('排练已创建');
      loadRehearsalsTab();
    } catch (err) { toast(err.message, true); }
  });
  panel.appendChild(create);

  const list = el('<div class="card"><h2>排练列表</h2><div id="rehList"></div></div>');
  panel.appendChild(list);
  const box = list.querySelector('#rehList');
  for (const r of rehearsals) {
    const row = el(`
      <div class="line-row">
        <div class="flex">
          <div class="grow">
            <strong>${esc(r.name)}</strong>
            <span class="badge v">《${esc(r.playTitle)}》固定 v${r.versionNo}</span>
          </div>
          <button class="btn small openBtn">打开</button>
        </div>
        <div id="rehDetail-${r.id}"></div>
      </div>`);
    row.querySelector('.openBtn').addEventListener('click', () => toggleRehearsalDetail(r.id));
    box.appendChild(row);
  }
  if (!rehearsals.length) box.innerHTML = '<span class="muted">暂无排练</span>';
}

async function toggleRehearsalDetail(id) {
  const box = document.getElementById(`rehDetail-${id}`);
  if (box.dataset.open) { box.innerHTML = ''; box.dataset.open = ''; return; }
  box.dataset.open = '1';
  box.innerHTML = '<span class="muted">加载中…</span>';
  const data = await api('GET', `/api/rehearsals/${id}`);
  box.innerHTML = '';
  box.appendChild(renderRehearsalDetail(data, () => toggleRehearsalDetail(id).then(() => {})));
}

function renderRehearsalDetail(data, reload) {
  const wrap = el('<div style="margin-top:10px"></div>');
  const { rehearsal, cast, pending, versionLog, lastPublishAttempt } = data;

  // 换版
  const ver = el(`
    <div class="flex" style="margin:8px 0">
      <strong>固定版本 v${rehearsal.versionNo}</strong>
      <select class="switchVer" style="max-width:200px"></select>
      <button class="btn small switchBtn">显式换版</button>
    </div>
    <div class="verLog muted"></div>`);
  api('GET', `/api/plays/${rehearsal.playId}/versions`).then(({ versions }) => {
    ver.querySelector('.switchVer').innerHTML = versions
      .map((v) => `<option value="${v.id}" ${v.id === rehearsal.versionId ? 'disabled' : ''}>v${v.versionNo}${v.id === rehearsal.versionId ? '（当前）' : ''}</option>`)
      .join('');
  });
  ver.querySelector('.switchBtn').addEventListener('click', async () => {
    const vid = Number(ver.querySelector('.switchVer').value);
    if (!confirm(`确定将排练切换固定到 v? 仅文本变化的角色×场次需要重新确认。`)) return;
    try {
      const r = await api('POST', `/api/rehearsals/${rehearsal.id}/switch-version`, { versionId: vid });
      toast(`已换版；待确认 ${r.pending.length} 项`);
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(err.message, true); }
  });
  ver.querySelector('.verLog').textContent = versionLog.length
    ? '换版历史：' + versionLog.map((l) => `v${l.fromNo}→v${l.toNo}`).join('，')
    : '尚未换过版';
  wrap.appendChild(ver);

  // 派角
  const castBox = el(`
    <div style="margin-top:8px">
      <h3>派角 / 改派（改派后原演员确认不再计入）</h3>
      <div class="castRows"></div>
      <form class="flex assignForm" style="margin-top:6px">
        <select name="roleId" class="roleSel"></select>
        <select name="actorId" class="actorSel"></select>
        <button class="btn small">派角/改派</button>
      </form>
    </div>`);
  const roleSel = castBox.querySelector('.roleSel');
  const actorSel = castBox.querySelector('.actorSel');
  Promise.all([
    api('GET', `/api/plays/${rehearsal.playId}`),
    loadActors(),
  ]).then(([detail, actors]) => {
    roleSel.innerHTML = detail.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    actorSel.innerHTML = actors.map((a) => `<option value="${a.id}">${esc(a.displayName)}（@${esc(a.username)}）</option>`).join('');
  });
  castBox.querySelector('.assignForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/rehearsals/${rehearsal.id}/cast`, {
        roleId: Number(roleSel.value),
        actorId: Number(actorSel.value),
      });
      toast('派角已更新（相关确认已重置）');
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(err.message, true); }
  });
  const rows = castBox.querySelector('.castRows');
  rows.innerHTML = cast.length
    ? `<table><tr><th>角色</th><th>演员</th><th>操作</th></tr>${
        cast.map((c) => `<tr><td>${esc(c.roleName)}</td><td>${esc(c.actorName)}（@${esc(c.actorUsername)}）</td>
          <td><button class="btn small danger unassign" data-role="${c.roleId}">取消派角</button></td></tr>`).join('')
      }</table>`
    : '<span class="muted">尚未派角</span>';
  castBox.querySelectorAll('.unassign').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/rehearsals/${rehearsal.id}/cast/${b.dataset.role}`);
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(err.message, true); }
  }));
  wrap.appendChild(castBox);

  // 待确认
  const pendBox = el(`<div style="margin-top:8px"><h3>待确认（${pending.length} 项）</h3><div class="pendRows"></div></div>`);
  pendBox.querySelector('.pendRows').innerHTML = pending.length
    ? `<table><tr><th>演员</th><th>角色</th><th>场次</th><th>原因</th></tr>${
        pending.map((p) => `<tr><td>${esc(p.actorName)}</td><td>${esc(p.roleName)}</td><td>${esc(p.sceneTitle)}</td><td><span class="badge pending">${esc(p.reason)}</span></td></tr>`).join('')
      }</table>`
    : '<span class="badge done">全部确认完毕</span>';
  wrap.appendChild(pendBox);

  // 冲突详情
  if (lastPublishAttempt && lastPublishAttempt.hadConflict) {
    const cbox = el(`<div style="margin-top:8px"><h3>最近一次发布冲突（本次发布未生效）</h3></div>`);
    for (const c of lastPublishAttempt.conflicts) {
      cbox.appendChild(el(`
        <div class="conflict">
          <div class="kind">[${esc(c.kind)}] 修订 #${c.revisionId} · 台词 #${c.lineId ?? '-'}</div>
          <div>${esc(c.reason)}</div>
          ${c.baseText ? `<div class="diff old">原文：${esc(c.baseText)}</div>` : ''}
          ${c.currentText ? `<div class="diff new">现行：${esc(c.currentText)}</div>` : ''}
        </div>`));
    }
    wrap.appendChild(cbox);
  }
  return wrap;
}

async function loadActors() {
  // 导演可通过演员列表接口获取；若未暴露则从后端 dashboard 不可得，这里走专用端点
  return (await api('GET', '/api/actors')).actors;
}

async function loadDashboard() {
  const panel = document.getElementById('tab-dashboard');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  const d = await api('GET', '/api/dashboard');
  panel.innerHTML = '';
  const card = el('<div class="card"><h2>各排练待确认</h2></div>');
  for (const item of d.rehearsals) {
    const block = el(`
      <div class="line-row">
        <strong>${esc(item.rehearsal.name)}</strong>
        <span class="badge v">v${item.rehearsal.versionId}</span>
        <span class="badge ${item.pending.length ? 'pending' : 'done'}">待确认 ${item.pending.length}</span>
        <table style="margin-top:6px">
          <tr><th>演员</th><th>角色</th><th>场次</th><th>原因</th></tr>
          ${item.pending.map((p) => `<tr><td>${esc(p.actorName)}</td><td>${esc(p.roleName)}</td><td>${esc(p.sceneTitle)}</td><td>${esc(p.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">无</td></tr>'}
        </table>
      </div>`);
    card.appendChild(block);
  }
  panel.appendChild(card);

  const cc = el('<div class="card"><h2>最近冲突详情</h2></div>');
  if (!d.recentConflicts.length) {
    cc.innerHTML += '<span class="muted">暂无冲突发布</span>';
  }
  for (const a of d.recentConflicts) {
    const block = el(`
      <div class="conflict">
        <div class="kind">《${esc(a.playTitle)}》· ${a.createdAt} · ${esc(a.note)}</div>
        ${a.details.map((c) => `<div style="margin-top:4px">
          [${esc(c.kind)}] 修订 #${c.revisionId} 台词 #${c.lineId ?? '-'}：${esc(c.reason)}
          ${c.baseText ? `<div class="diff old">原文：${esc(c.baseText)}</div>` : ''}
          ${c.currentText ? `<div class="diff new">现行：${esc(c.currentText)}</div>` : ''}
        </div>`).join('')}
      </div>`);
    cc.appendChild(block);
  }
  panel.appendChild(cc);
}

/* ---------- 演员视图 ---------- */
async function loadActorHome() {
  const panel = document.getElementById('actorView');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  const { rehearsals } = await api('GET', '/api/rehearsals');
  panel.innerHTML = '';
  const card = el('<div class="card"><h2>我的排练</h2></div>');
  for (const r of rehearsals) {
    const row = el(`
      <div class="line-row" style="cursor:pointer">
        <strong>${esc(r.name)}</strong>
        <span class="badge v">《${esc(r.playTitle)}》固定 v${r.versionNo}</span>
        <div class="muted">点击查看只含你所派角色的排练稿</div>
      </div>`);
    row.addEventListener('click', () => loadActorScript(r.id));
    card.appendChild(row);
  }
  if (!rehearsals.length) card.innerHTML += '<p class="muted">你暂时没有被分配到任何排练。</p>';
  panel.appendChild(card);
}

async function loadActorScript(rehearsalId) {
  const panel = document.getElementById('actorView');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  let data;
  try {
    data = await api('GET', `/api/rehearsals/${rehearsalId}/script`);
  } catch (err) {
    toast(err.message, true);
    loadActorHome();
    return;
  }
  const { rehearsal, lines, confirmations } = data;
  const confMap = new Map(confirmations.map((c) => [`${c.roleId}:${c.sceneId}`, c]));

  panel.innerHTML = '';
  const head = el(`
    <div class="card">
      <button class="btn small" id="backBtn">← 返回我的排练</button>
      <h2 style="margin-top:8px">${esc(reh2(rehearsal))}</h2>
      <div class="muted">排练固定引用 v${rehearsal.versionNo}；仅显示你获分配角色的台词。请逐场确认。</div>
    </div>`);
  head.querySelector('#backBtn').addEventListener('click', loadActorHome);
  panel.appendChild(head);

  const scenes = new Map();
  for (const l of lines) {
    if (!scenes.has(l.sceneId)) scenes.set(l.sceneId, { code: l.sceneCode, title: l.sceneTitle, seq: l.sceneSeq, lines: [] });
    scenes.get(l.sceneId).lines.push(l);
  }
  for (const [sceneId, s] of [...scenes.entries()].sort((a, b) => a[1].seq - b[1].seq)) {
    const roleIds = [...new Set(s.lines.map((l) => l.roleId))];
    // 一个场次若有多个所派角色，合并到一张确认卡
    const statuses = roleIds.map((rid) => confMap.get(`${rid}:${sceneId}`));
    const allDone = statuses.every((c) => c && c.confirmed);
    const block = el(`
      <div class="card scene-card">
        <div class="flex">
          <h2 class="grow">${esc(s.code)} · ${esc(s.title)}</h2>
          <span class="badge ${allDone ? 'done' : 'pending'}">${allDone ? '已确认' : '待确认'}</span>
        </div>
        <div class="line-list"></div>
        <div class="confirmArea" style="margin-top:8px"></div>
      </div>`);
    for (const l of s.lines) {
      block.querySelector('.line-list').appendChild(el(`
        <div class="line-row">
          <div class="meta">${esc(l.roleName)} · 顺序 ${l.seq}</div>
          <div>${esc(l.text)}</div>
        </div>`));
    }
    const area = block.querySelector('.confirmArea');
    for (const rid of roleIds) {
      const c = confMap.get(`${rid}:${sceneId}`);
      const roleName = s.lines.find((l) => l.roleId === rid)?.roleName || rid;
      const btn = el(`
        <div class="flex" style="margin:4px 0">
          <span class="grow">角色「${esc(roleName)}」${c?.confirmed ? `<span class="badge done">已于 ${c.confirmedAt} 确认</span>` : '<span class="badge pending">未确认</span>'}</span>
          <button class="btn small primary">${c?.confirmed ? '重新确认本场' : '确认本场台词'}</button>
        </div>`);
      btn.querySelector('button').addEventListener('click', async () => {
        try {
          await api('POST', `/api/rehearsals/${rehearsalId}/confirm`, { roleId: rid, sceneId: Number(sceneId) });
          toast('已确认');
          loadActorScript(rehearsalId);
        } catch (err) { toast(err.message, true); }
      });
      area.appendChild(btn);
    }
    panel.appendChild(block);
  }
}

function reh2(r) {
  return `${r.name}（《${r.playTitle}》）`;
}
