'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');

const { getDb, DB_PATH } = require('./db');
const { SqliteStore } = require('./session-store');
const authRoutes = require('./routes/auth');
const directorVersions = require('./routes/director-versions');
const directorRevisions = require('./routes/director-revisions');
const { directorRouter: directorRehearsals, actorRouter: actorRehearsals } =
  require('./routes/rehearsals');
const { requireDirector, requireActor } = require('./routes/auth-guard');

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';

// 确保数据库文件与目录存在，并执行初始化（容器首次启动即自动建库 + 种子）
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = getDb();
if (process.env.SEED_ON_START !== '0') {
  require('./init-db').initIfEmpty(db);
}

const app = express();
app.use(express.json());

app.use(session({
  store: new SqliteStore(db),
  name: 'troupe.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use('/api', authRoutes);

// 导演端：统一要求导演会话（中间件挂在子前缀上，不会影响演员端 /api/my/*）
app.use('/api/director', requireDirector, directorVersions, directorRevisions, directorRehearsals);

// 演员端
app.use('/api/my', requireActor, actorRehearsals);

// 版本台词查看接口也供演员在需要时复用（仅导演端有入口）；healthz 仅登录即可
app.get('/api/healthz', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// 统一错误处理
app.use((err, req, res, next) => {
  console.error(err);
  const msg = String(err.message || '服务器错误');
  if (/不可改写|不可删除|不可修改/.test(msg)) {
    return res.status(409).json({ error: msg });
  }
  res.status(500).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`剧团排练台词应用已启动: http://localhost:${PORT}`);
  console.log('数据库文件:', DB_PATH);
});
