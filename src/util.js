'use strict';

const crypto = require('crypto');

// 密码哈希：scrypt + 每用户随机盐
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === derived.length &&
    crypto.timingSafeEqual(expected, derived);
}

function now() {
  return Date.now();
}

module.exports = { hashPassword, verifyPassword, now };
