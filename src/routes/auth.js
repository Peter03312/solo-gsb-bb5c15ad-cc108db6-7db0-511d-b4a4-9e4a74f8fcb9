'use strict';

const express = require('express');
const { getDb } = require('../db');
const { verifyPassword } = require('../util');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.pass_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

module.exports = router;
