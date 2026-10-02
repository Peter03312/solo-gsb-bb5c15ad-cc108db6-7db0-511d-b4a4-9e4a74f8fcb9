'use strict';

let currentUser = null;
let versionsCache = [];
let charactersCache = [];
let revisionsCache = [];

// ---------- API ----------
async function api(url, opts = {}) {
  const res = await fetch('/api' + url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

// ---------- 登录 ----------
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  document.getElementById('login-error').textContent = '';
  try {
    const { user } = await api('/login', { method: 'POST',
      body: { username: fd.get('username'), password: fd.get('password') } });
    currentUser = user;
    enterApp();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
});

async function logout() {
  await api('/logout', { method: 'POST' });
  location.reload();
}

// ---------- 启动 ----------
async function boot() {
  const { user } = await api('/me');
  if (user) { currentUser = user; enterApp(); }
}

function enterApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('user-bar').classList.remove('hidden');
  document.getElementById('user-info').textContent =
    `${currentUser.name}（${currentUser.role === 'director' ? '导演' : '演员'}）`;

  if (currentUser.role === 'director') {
    document.getElementById('director-view').classList.remove('hidden');
    initDirector();
  } else {
    document.getElementById('actor-view').classList.remove('hidden');
    loadMyRehearsals();
  }
}

// ---------- Tab 切换 ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
    if (tab.dataset.tab === 'revisions') loadRevisions();
    if (tab.dataset.tab === 'rehearsals') loadRehearsals();
    if (tab.dataset.tab === 'characters') loadCharacters();
  });
});

// ================= 导演 =================
async function initDirector() {
  await Promise.all([loadVersions(), loadCharacters()]);
  loadRevisions();
}

async function loadCharacters() {
  const { characters } = await api('/director/characters');
  charactersCache = characters;
  const { actors } = await api('/director/actors');
  const tbody = document.querySelector('#char-table tbody');
  tbody.innerHTML = characters.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${c.actor_name ? esc(c.actor_name) + ' <span class="muted">(' + esc(c.actor_username) + ')</span>' : '<span class="muted">未分配</span>'}</td>
      <td>
        <select onchange="assignCharacter(${c.id}, this.value)">
          <option value="">— 取消分配 —</option>
          ${actors.map(a => `<option value="${a.id}" ${a.id === c.actor_id ? 'selected' : ''}>${esc(a.name)}（${esc(a.username)}）</option>`).join('')}
        </select>
      </td>
    </tr>`).join('');
}

async function assignCharacter(charId, actorId) {
  if (!confirm('改派角色将使原演员对该角色的全部确认失效，确认？')) {
    return loadCharacters();
  }
  await api(`/director/characters/${charId}/assign`, { method: 'POST', body: { actor_id: actorId ? Number(actorId) : null } });
  await loadCharacters();
  alert('已改派，原演员确认已失效');
}

document.getElementById('char-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/director/characters', { method: 'POST', body: { name: new FormData(e.target).get('name') } });
  e.target.reset();
  loadCharacters();
});

// ----- 版本 -----
async function loadVersions(selectDetailId) {
  const { versions } = await api('/director/versions');
  versionsCache = versions;

  document.getElementById('version-list').innerHTML = versions.length
    ? versions.map(v => `
      <div style="margin:6px 0">
        <button onclick="loadVersionLines(${v.id})">v${v.number}</button>
        ${v.label ? esc(v.label) : '<span class="muted">（无说明）</span>'}
        <span class="muted">${v.line_count} 条台词 · ${esc(v.created_by_name)} · ${fmtTime(v.created_at)}</span>
      </div>`).join('')
    : '<p class="hint">尚无版本。请先在下方创建首个发布版本。</p>';

  // 首版录入卡
  document.getElementById('create-version-card').classList.toggle('hidden', versions.length > 0);
  if (versions.length === 0) renderNewLineTable();

  // 下拉
  const baseSel = document.getElementById('revision-base');
  baseSel.innerHTML = versions.map(v => `<option value="${v.id}">v${v.number}${v.label ? ' ' + esc(v.label) : ''}</option>`).join('');
  const rhSel = document.getElementById('rehearsal-version');
  rhSel.innerHTML = versions.map(v => `<option value="${v.id}">v${v.number}${v.label ? ' ' + esc(v.label) : ''}</option>`).join('');

  if (selectDetailId) loadVersionLines(selectDetailId);
}

function renderNewLineTable() {
  const tbody = document.querySelector('#new-lines-table tbody');
  tbody.innerHTML = '';
  addNewLineRow(); addNewLineRow(); addNewLineRow();
}

function addNewLineRow() {
  const tbody = document.querySelector('#new-lines-table tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input style="width:70px" name="scene" type="number" min="1" value="1"></td>
    <td><input style="width:70px" name="sort" type="number" min="1"></td>
    <td><select name="char_id">${charactersCache.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></td>
    <td><input style="min-width:300px;width:100%" name="content"></td>
    <td><button class="danger btn-small" type="button" onclick="this.closest('tr').remove()">删</button></td>`;
  tbody.appendChild(tr);
}

async function createFirstVersion() {
  const rows = [...document.querySelectorAll('#new-lines-table tbody tr')];
  const lines = rows.map(tr => ({
    scene: Number(tr.querySelector('[name=scene]').value),
    sort: Number(tr.querySelector('[name=sort]').value),
    char_id: Number(tr.querySelector('[name=char_id]').value),
    content: tr.querySelector('[name=content]').value
  })).filter(l => l.content.trim());
  if (lines.length === 0) return alert('请至少填写一条台词');
  try {
    const r = await api('/director/versions', { method: 'POST',
      body: { label: document.getElementById('new-version-label').value, lines } });
    await loadVersions(r.newVersionId || r.versionId);
    alert('首版已发布');
  } catch (e) { alert(e.message); }
}

async function loadVersionLines(versionId) {
  const { version, lines } = await api(`/director/versions/${versionId}/lines`);
  document.getElementById('version-detail-card').classList.remove('hidden');
  document.getElementById('version-detail-title').textContent =
    `v${version.number}${version.label ? ' · ' + version.label : ''}`;
  document.getElementById('version-lines').innerHTML = renderLinesTable(lines, {
    editable: false
  });
}

function groupByScene(lines) {
  const map = new Map();
  for (const l of lines) {
    if (!map.has(l.scene)) map.set(l.scene, []);
    map.get(l.scene).push(l);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function renderLinesTable(lines) {
  let html = '';
  for (const [scene, arr] of groupByScene(lines)) {
    html += `<div class="scene-header">第 ${scene} 场</div><table>
      <thead><tr><th style="width:50px">顺序</th><th style="width:120px">角色</th><th>台词</th></tr></thead><tbody>`;
    for (const l of arr) {
      html += `<tr><td>${l.sort}</td><td>${esc(l.char_name)}</td><td>${esc(l.content)}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  return html;
}

// ----- 修订 -----
document.getElementById('revision-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/director/revisions', { method: 'POST',
    body: { title: fd.get('title'), base_version_id: Number(fd.get('base_version_id')) } });
  e.target.reset();
  loadRevisions();
});

async function loadRevisions() {
  const [{ revisions }, { versions }] = await Promise.all([
    api('/director/revisions'),
    api('/director/versions')
  ]);
  revisionsCache = revisions;
  versionsCache = versions;

  document.getElementById('revision-list').innerHTML = revisions.length
    ? revisions.map(r => renderRevision(r)).join('')
    : '<p class="hint">暂无修订。</p>';

  // 为每个开放修订填充“选台词”下拉
  for (const r of revisions.filter(x => x.status === 'open')) {
    const { lines } = await api(`/director/versions/${r.base_version}/lines`);
    const sel = document.getElementById(`add-item-line-${r.id}`);
    if (!sel) continue;
    sel.innerHTML = lines.map(l =>
      `<option value="${l.id}">第${l.scene}场/${esc(l.char_name)}：${esc(l.content.slice(0, 24))}…</option>`
    ).join('');
  }

  // 发布勾选（仅 open 修订）
  const open = revisions.filter(r => r.status === 'open');
  document.getElementById('publish-checkboxes').innerHTML = open.length
    ? open.map(r => `
      <label style="display:block;margin:4px 0">
        <input type="checkbox" class="publish-check" value="${r.id}">
        #${r.id}《${esc(r.title)}》基于 v${r.base_number}（${r.item_count} 条改动）
      </label>`).join('')
    : '<p class="hint">没有待发布的开放修订。</p>';
  document.getElementById('publish-result').innerHTML = '';
  loadAttempts();
}

function renderRevision(r) {
  const statusBadge = r.status === 'open'
    ? '<span class="badge badge-open">开放中</span>'
    : `<span class="badge badge-integrated">已合入 v${(versionsCache.find(v => v.id === r.integrated_version) || {}).number || '?'}</span>`;
  const items = r.items.length ? `
    <table><thead><tr><th>场次</th><th>角色</th><th>原文（提交时锁定）</th><th>新文</th><th></th></tr></thead><tbody>
    ${r.items.map(i => `
      <tr>
        <td>${i.scene}</td><td>${esc(i.char_name)}</td>
        <td class="muted">${esc(i.base_content)}</td>
        <td>${esc(i.new_content)}</td>
        <td>${r.status === 'open'
          ? `<button class="danger btn-small" onclick="deleteRevisionItem(${r.id}, ${i.id})">删</button>` : ''}</td>
      </tr>`).join('')}
    </tbody></table>` : '<p class="hint">还没有改动条目。</p>';

  const addForm = r.status === 'open' ? `
    <div style="margin:8px 0">
      <select id="add-item-line-${r.id}" style="min-width:480px"></select>
      <input id="add-item-new-${r.id}" placeholder="新台词文本" style="min-width:300px">
      <button onclick="addRevisionItem(${r.id})">提交改动</button>
      <button class="danger btn-small" onclick="deleteRevision(${r.id})">删除整个修订</button>
    </div>` : '';

  return `<div class="card" style="box-shadow:none;border:1px solid #eee">
    <h3 style="margin:4px 0">#${r.id}《${esc(r.title)}》${statusBadge}
      <span class="hint">基准 v${r.base_number}</span></h3>
    ${items}${addForm}
  </div>`;
}

async function addRevisionItem(revisionId) {
  const sel = document.getElementById(`add-item-line-${revisionId}`);
  const newContent = document.getElementById(`add-item-new-${revisionId}`).value;
  try {
    await api(`/director/revisions/${revisionId}/items`, { method: 'POST',
      body: { line_id: Number(sel.value), new_content: newContent } });
    await loadRevisions();
  } catch (e) { alert(e.message); }
}

async function deleteRevisionItem(revisionId, itemId) {
  await api(`/director/revisions/${revisionId}/items/${itemId}`, { method: 'DELETE' });
  loadRevisions();
}

async function deleteRevision(id) {
  if (!confirm('删除整个修订？')) return;
  await api(`/director/revisions/${id}`, { method: 'DELETE' });
  loadRevisions();
}

async function publishRevisions() {
  const ids = [...document.querySelectorAll('.publish-check:checked')].map(c => Number(c.value));
  if (ids.length === 0) return alert('请勾选修订');
  const box = document.getElementById('publish-result');
  box.innerHTML = '';
  try {
    const r = await api('/director/publish', { method: 'POST', body: { revision_ids: ids } });
    box.innerHTML = `<div class="badge badge-success">发布成功，已生成 v${r.new_version}，共合入 ${r.changed_line_ids.length} 条改动</div>`;
    await loadVersions();
    await loadRevisions();
  } catch (e) {
    // 409 冲突：展示详情
    box.innerHTML = `<div class="conflict-box">
      <strong class="error">${esc(e.message)}</strong>
      ${renderConflictDetail(e.data && e.data.conflicts)}
    </div>`;
    loadAttempts();
  }
}

function renderConflictDetail(conflicts) {
  if (!conflicts) return '';
  return `<table><thead><tr><th>修订</th><th>场次</th><th>原因</th><th>条目记录的原文</th><th>现行文本</th></tr></thead><tbody>
    ${conflicts.map(c => `<tr>
      <td>#${c.revision_id}《${esc(c.revision_title)}》</td>
      <td>第 ${c.scene} 场</td><td>${esc(c.reason)}</td>
      <td class="muted">${esc(c.expected)}</td>
      <td>${c.actual == null ? '<span class="muted">（不存在）</span>' : esc(c.actual)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

async function loadAttempts() {
  const { attempts } = await api('/director/publish/attempts');
  document.getElementById('attempt-list').innerHTML = attempts.length
    ? attempts.map(a => `
      <details style="margin:6px 0">
        <summary>
          <span class="badge ${a.status === 'success' ? 'badge-success' : 'badge-conflict'}">
            ${a.status === 'success' ? '成功' : '冲突未生效'}
          </span>
          修订 [${a.revision_ids.join(', ')}] · 基于 v${a.detail.base_version} ·
          ${fmtTime(a.created_at)}
          ${a.status === 'conflict' ? `· ${a.detail.conflicts.length} 处冲突` : ''}
        </summary>
        ${a.status === 'conflict' ? renderConflictDetail(a.detail.conflicts) :
          `<p class="hint">合入 ${a.detail.accepted_count} 条改动，无冲突。</p>`}
      </details>`).join('')
    : '<p class="hint">暂无发布记录。</p>';
}

// ----- 排练 -----
document.getElementById('rehearsal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/director/rehearsals', { method: 'POST',
    body: { name: fd.get('name'), version_id: Number(fd.get('version_id')) } });
  e.target.reset();
  loadRehearsals();
});

async function loadRehearsals() {
  const [{ rehearsals }, { versions }] = await Promise.all([
    api('/director/rehearsals'), api('/director/versions')
  ]);
  const box = document.getElementById('rehearsal-list');
  box.innerHTML = rehearsals.length ? rehearsals.map(r => {
    const opts = versions.map(v =>
      `<option value="${v.id}" ${v.id === r.version_id ? 'selected' : ''}>v${v.number}</option>`).join('');
    const pendingByChar = new Map();
    for (const p of r.pending) {
      if (!pendingByChar.has(p.char_id)) pendingByChar.set(p.char_id, []);
      pendingByChar.get(p.char_id).push(p);
    }
    return `<div class="card">
      <h3 style="margin:4px 0">${esc(r.name)}</h3>
      <div style="margin:6px 0">
        当前引用版本：<strong>v${r.version_number}</strong>
        <select id="switch-${r.id}">${opts}</select>
        <button onclick="switchVersion(${r.id})">显式换版</button>
        <span class="hint">换版后仅台词内容变化的角色需重新确认</span>
      </div>
      <div>
        <strong>参演角色：</strong>
        ${r.characters.map(c => `
          <span style="display:inline-block;margin:2px 6px">
            ${esc(c.name)}（${c.actor_name ? esc(c.actor_name) : '<span class="muted">未分配演员</span>'}）
            <button class="btn-small danger" onclick="removeRehearsalChar(${r.id}, ${c.id})">移除</button>
          </span>`).join('')}
        <select id="add-char-${r.id}">
          ${charactersCache.filter(c => !r.characters.some(rc => rc.id === c.id))
            .map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
        <button class="btn-small" onclick="addRehearsalChar(${r.id})">加入角色</button>
      </div>
      <div style="margin-top:10px">
        <strong>待确认（${r.pending.length} 项）：</strong>
        ${r.pending.length === 0 ? '<span class="badge badge-success">全部确认完毕</span>' : `
        <table><thead><tr><th>角色</th><th>演员</th><th>待确认场次</th></tr></thead><tbody>
          ${[...pendingByChar.entries()].map(([cid, list]) => `
            <tr>
              <td>${esc(list[0].char_name)}</td>
              <td>${list[0].actor_name ? esc(list[0].actor_name) + ' (' + esc(list[0].actor_username) + ')'
                : '<span class="muted">角色未分配演员</span>'}</td>
              <td>${list.map(p => `第${p.scene}场`).join('、')}</td>
            </tr>`).join('')}
        </tbody></table>`}
      </div>
    </div>`;
  }).join('') : '<p class="hint">暂无排练。</p>';
}

async function switchVersion(rehearsalId) {
  const versionId = Number(document.getElementById(`switch-${rehearsalId}`).value);
  try {
    const r = await api(`/director/rehearsals/${rehearsalId}/switch-version`, {
      method: 'POST', body: { version_id: versionId } });
    alert(`已换版。需重新确认的角色：${r.reset_char_ids.length} 个`);
    loadRehearsals();
  } catch (e) { alert(e.message); }
}

async function addRehearsalChar(rehearsalId) {
  const charId = Number(document.getElementById(`add-char-${rehearsalId}`).value);
  await api(`/director/rehearsals/${rehearsalId}/characters`, { method: 'POST', body: { char_id: charId } });
  loadRehearsals();
}

async function removeRehearsalChar(rehearsalId, charId) {
  await api(`/director/rehearsals/${rehearsalId}/characters/${charId}`, { method: 'DELETE' });
  loadRehearsals();
}

// ================= 演员 =================
async function loadMyRehearsals() {
  const { rehearsals } = await api('/my/rehearsals');
  const box = document.getElementById('my-rehearsals');
  box.innerHTML = `<div class="card"><h2>我的排练</h2>${
    rehearsals.length === 0 ? '<p class="hint">你目前没有获分配角色的排练。</p>' :
    rehearsals.map(r => `
      <div style="margin:8px 0">
        <button class="primary" onclick="loadMyScript(${r.id})">${esc(r.name)}</button>
        <span class="hint">v${r.version_number} · 角色：${r.my_characters.map(c => esc(c.name)).join('、')}</span>
        ${r.pending_scenes.length
          ? `<span class="badge badge-pending">待确认 ${r.pending_scenes.length} 场</span>`
          : '<span class="badge badge-success">已全部确认</span>'}
      </div>`).join('')
  }</div>`;
}

async function loadMyScript(rehearsalId) {
  try {
    const data = await api(`/my/rehearsals/${rehearsalId}/script`);
    document.getElementById('script-card').classList.remove('hidden');
    document.getElementById('script-title').textContent = data.rehearsal.name;
    document.getElementById('script-meta').textContent =
      `排练固定引用版本 v${data.version.number}${data.version.label ? ' · ' + data.version.label : ''}｜你的角色：${data.characters.map(c => c.name).join('、')}`;

    let html = '';
    for (const [scene, arr] of groupByScene(data.lines)) {
      const charScenes = new Map();
      for (const l of arr) {
        if (!charScenes.has(l.char_id)) charScenes.set(l.char_id, { name: l.char_name, confirmed: data.confirmed.includes(`${l.char_id}:${scene}`) });
      }
      html += `<div class="scene-header">第 ${scene} 场</div>`;
      for (const l of arr) {
        html += `<div class="script-line"><span class="char">${esc(l.char_name)}：</span>${esc(l.content)}</div>`;
      }
      for (const [charId, info] of charScenes) {
        html += `<div style="margin:6px 0 14px">
          <button class="confirm-btn" ${info.confirmed ? 'disabled' : ''}
            onclick="confirmScene(${rehearsalId}, ${charId}, ${scene}, this)">
            ${info.confirmed ? '✔ 你已确认第 ' + scene + ' 场（' + esc(info.name) + '）'
              : '确认第 ' + scene + ' 场台词无误（' + esc(info.name) + '）'}
          </button></div>`;
      }
    }
    document.getElementById('script-body').innerHTML = html;
  } catch (e) { alert(e.message); }
}

async function confirmScene(rehearsalId, charId, scene, btn) {
  try {
    await api(`/my/rehearsals/${rehearsalId}/confirm`, {
      method: 'POST', body: { char_id: charId, scene } });
    btn.disabled = true;
    btn.textContent = `✔ 你已确认第 ${scene} 场`;
    loadMyRehearsals();
  } catch (e) { alert(e.message); }
}

boot();
