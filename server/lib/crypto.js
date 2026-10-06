/**
 * KBPRO — 加密与口令工具
 *  - scrypt 口令哈希（用户登录）
 *  - AES-256-GCM 内容加密（私密文档、AI 密钥、备份包）
 *  - 主密钥落盘于 data/.master.key（首次启动生成，权限 0600）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KEY_PATH, ensureDirs } from '../config.js';

/* ------------------------------------------------------------------ 口令 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** @returns {{hash:string, salt:string, algo:string}} */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2
  });
  return { hash: hash.toString('hex'), salt: salt.toString('hex'), algo: 'scrypt' };
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  try {
    const salt = Buffer.from(stored.salt, 'hex');
    const expected = Buffer.from(stored.hash, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function passwordStrength(pw) {
  const s = String(pw || '');
  let score = 0;
  if (s.length >= 8) score++;
  if (s.length >= 12) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/\d/.test(s)) score++;
  if (/[^\w\s]/.test(s)) score++;
  const labels = ['极弱', '弱', '一般', '较强', '强', '很强'];
  return { score, label: labels[Math.min(score, 5)] };
}

/* ------------------------------------------------------------------ 令牌 */

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function shortHash(buf, len = 16) {
  return sha256(buf).slice(0, len);
}

/* ------------------------------------------------------------------ 主密钥 */

let masterKeyCache = null;

export function getMasterKey() {
  if (masterKeyCache) return masterKeyCache;
  ensureDirs();
  if (fs.existsSync(KEY_PATH)) {
    const raw = fs.readFileSync(KEY_PATH, 'utf8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) {
      masterKeyCache = key;
      return key;
    }
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(KEY_PATH, 0o600); } catch { /* windows 上可能不支持 */ }
  masterKeyCache = key;
  return key;
}

/**
 * 使用口令派生密钥（用于备份包，可脱离主密钥恢复）
 * 返回 { key, salt }，salt 需随包保存。
 */
export function deriveKeyFromPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return { key, salt: salt.toString('base64') };
}

/* ------------------------------------------------------------------ 内容加密 */

const MAGIC = Buffer.from('KBP1');

/**
 * AES-256-GCM 加密。输出 `KBP1 | iv(12) | tag(16) | ciphertext`
 * @param {Buffer|string} data
 * @param {Buffer} [key]
 */
export function encryptBuffer(data, key = getMasterKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, enc]);
}

export function decryptBuffer(payload, key = getMasterKey()) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('密文格式不正确');
  }
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const data = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** 加密为字符串（存库用） */
export function encryptText(plain, key = getMasterKey()) {
  return encryptBuffer(Buffer.from(String(plain ?? ''), 'utf8'), key).toString('base64');
}

export function decryptText(b64, key = getMasterKey()) {
  if (!b64) return '';
  try {
    return decryptBuffer(Buffer.from(b64, 'base64'), key).toString('utf8');
  } catch {
    return '';
  }
}

export function isEncryptedPayload(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC);
}

/** 生成可读的恢复码，如 KBP-3F9A-22C7-... */
export function recoveryCode(groups = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) s += alphabet[bytes[i] % alphabet.length];
    parts.push(s);
  }
  return 'KBP-' + parts.join('-');
}
