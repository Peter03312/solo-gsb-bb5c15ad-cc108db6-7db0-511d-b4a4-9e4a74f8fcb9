'use strict';

// 鉴权辅助
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: '未登录' });
    if (req.session.user.role !== role) {
      return res.status(403).json({ error: `越权访问：需要${role === 'director' ? '导演' : '演员'}身份` });
    }
    next();
  };
}

const requireDirector = requireRole('director');
const requireActor = requireRole('actor');

module.exports = { requireAuth, requireDirector, requireActor };
