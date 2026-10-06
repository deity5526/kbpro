/**
 * KBPRO — 文件存储层
 *  布局：data/files/<workspaceId>/<yyyy-MM>/<fileId>.<ext>
 *  支持透明加解密（私密文件落盘即密文），以及流式读取。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { FILES_DIR, ensureDirs } from '../config.js';
import { encryptBuffer, decryptBuffer, isEncryptedPayload, sha256 } from './crypto.js';

export function monthBucket(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 计算相对存储路径（存库用，避免暴露绝对路径） */
export function relativeStoragePath(workspaceId, fileId, ext) {
  const safeExt = String(ext || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  return path.posix.join(String(workspaceId), monthBucket(), `${fileId}${safeExt ? '.' + safeExt : ''}`);
}

export function absoluteStoragePath(storageKey) {
  const safe = String(storageKey).replace(/\\/g, '/').replace(/\.\.+/g, '__');
  const full = path.join(FILES_DIR, safe.split('/').join(path.sep));
  const rel = path.relative(FILES_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('非法存储路径');
  return full;
}

/** 从临时文件搬移到正式位置；encrypt=true 时加密落盘 */
export async function persistUpload(tmpPath, storageKey, { encrypt = false, move = true } = {}) {
  ensureDirs();
  const dest = absoluteStoragePath(storageKey);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  if (encrypt) {
    const raw = await fsp.readFile(tmpPath);
    const sealed = encryptBuffer(raw);
    await fsp.writeFile(dest, sealed);
    if (move) await fsp.unlink(tmpPath).catch(() => {});
    return { path: dest, size: raw.length, sealedSize: sealed.length, encrypted: true, checksum: sha256(raw) };
  }

  if (move) {
    try {
      await fsp.rename(tmpPath, dest);
    } catch {
      await fsp.copyFile(tmpPath, dest);
      await fsp.unlink(tmpPath).catch(() => {});
    }
  } else {
    await fsp.copyFile(tmpPath, dest);
  }
  const stat = await fsp.stat(dest);
  return { path: dest, size: stat.size, sealedSize: stat.size, encrypted: false };
}

/** 读取完整内容（自动解密） */
export async function readStored(storageKey, encrypted = false) {
  const p = absoluteStoragePath(storageKey);
  const buf = await fsp.readFile(p);
  if (encrypted || isEncryptedPayload(buf)) {
    try { return decryptBuffer(buf); } catch { return buf; }
  }
  return buf;
}

/** 返回可读流（加密文件先解密到内存） */
export async function streamStored(storageKey, encrypted = false) {
  const p = absoluteStoragePath(storageKey);
  if (encrypted) {
    const buf = await readStored(storageKey, true);
    const { Readable } = await import('node:stream');
    return { stream: Readable.from(buf), size: buf.length };
  }
  const stat = await fsp.stat(p).catch(() => null);
  return { stream: createReadStream(p), size: stat?.size ?? 0 };
}

export async function storedSize(storageKey) {
  try { return (await fsp.stat(absoluteStoragePath(storageKey))).size; } catch { return 0; }
}

export async function existsStored(storageKey) {
  try { await fsp.access(absoluteStoragePath(storageKey)); return true; } catch { return false; }
}

export async function deleteStored(storageKey) {
  try { await fsp.unlink(absoluteStoragePath(storageKey)); return true; } catch { return false; }
}

/** 计算临时文件校验和 */
export async function checksumFile(p) {
  const buf = await fsp.readFile(p);
  return { checksum: sha256(buf), size: buf.length };
}

export function tmpUploadPath(prefix = 'up') {
  ensureDirs();
  const { TMP_DIR } = globalThis.__kbproDirs || {};
  return path.join(TMP_DIR || path.join(FILES_DIR, '..', 'tmp'), `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
}

export function humanStoragePath(storageKey) {
  return path.join(FILES_DIR, String(storageKey).split('/').join(path.sep));
}

export { fs, fsp };
