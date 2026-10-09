/**
 * KBPRO — HTTP 基础工具：路由、请求体解析、响应、SSE、静态文件。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';

/* ------------------------------------------------------------------ 响应 */

export function sendJson(res, status, data, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(data ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text ?? ''), 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
  res.end(body);
}

export function sendBuffer(res, status, buf, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function httpError(status, message, extra) {
  return new HttpError(status, message, extra);
}

/* ------------------------------------------------------------------ 请求 */

const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function readBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, `请求体过大（上限 ${Math.round(limit / 1048576)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(httpError(400, `读取请求失败：${e.message}`)));
    req.on('aborted', () => reject(httpError(499, '客户端中断请求')));
  });
}

export async function readJson(req, limit = MAX_JSON_BYTES) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function parseQuery(reqUrl) {
  const q = {};
  const idx = reqUrl.indexOf('?');
  if (idx < 0) return q;
  const sp = new URLSearchParams(reqUrl.slice(idx + 1));
  for (const [k, v] of sp) {
    if (k in q) {
      if (Array.isArray(q[k])) q[k].push(v);
      else q[k] = [q[k], v];
    } else q[k] = v;
  }
  return q;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/* ------------------------------------------------------------------ 路由 */

export class Router {
  constructor() {
    /** @type {{method:string, pattern:string, regex:RegExp, keys:string[], handler:Function}[]} */
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp('^' + pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        if (seg === '*') { keys.push('wildcard'); return '(.*)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/') + '/?$');
    this.routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    const m = method.toUpperCase();
    const allowed = new Set();
    for (const route of this.routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      allowed.add(route.method);
      if (route.method !== m) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(found[i + 1]); });
      return { route, params };
    }
    // 路径存在但方法不匹配时，把该路径实际支持的方法一并带回去，
    // 否则「方法 DELETE 不被支持」这句提示帮不上任何忙
    return allowed.size ? { methodMismatch: true, allowed: [...allowed].sort() } : null;
  }
}

/* ------------------------------------------------------------------ 静态文件 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm'
};

export function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 防目录穿越：把 urlPath 解析到 root 内 */
export function resolveStaticPath(root, urlPath) {
  let decoded = String(urlPath).split('?')[0];
  try { decoded = decodeURIComponent(decoded); } catch { return null; }
  const safe = path.normalize(decoded).replace(/^(\.\.[\\/])+/, '');
  const full = path.join(root, safe);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

export async function serveStatic(req, res, root, urlPath, { spa = false } = {}) {
  let target = resolveStaticPath(root, urlPath);
  if (!target) { sendText(res, 403, 'Forbidden'); return true; }
  try {
    let stat = await fsp.stat(target).catch(() => null);
    if (stat && stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fsp.stat(target).catch(() => null);
    }
    if (!stat) {
      if (spa) {
        const fallback = path.join(root, 'index.html');
        const fs2 = await fsp.stat(fallback).catch(() => null);
        if (fs2) { await streamFile(req, res, fallback, fs2); return true; }
      }
      return false;
    }
    await streamFile(req, res, target, stat);
    return true;
  } catch {
    return false;
  }
}

async function streamFile(req, res, filePath, stat) {
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate'
  };
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') { res.end(); return; }
  await new Promise((resolve) => {
    const stream = createReadStream(filePath);
    stream.on('error', () => { try { res.end(); } catch { /* */ } resolve(); });
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

/* ------------------------------------------------------------------ SSE */

export function sseStart(res, { retry = 3000 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`retry: ${retry}\n\n`);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function sseSend(res, event, data, id) {
  if (res.writableEnded) return false;
  try {
    let payload = '';
    if (id !== undefined && id !== null) payload += `id: ${id}\n`;
    if (event) payload += `event: ${event}\n`;
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    for (const line of String(body).split('\n')) payload += `data: ${line}\n`;
    payload += '\n';
    return res.write(payload);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 其他 */

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

/** RFC 5987 兼容的 Content-Disposition */
export function contentDisposition(filename, type = 'attachment') {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function safeJoin(root, ...parts) {
  const full = path.join(root, ...parts.map((p) => String(p).replace(/[\\/]/g, path.sep)));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw httpError(400, '非法路径');
  return full;
}

export { fs, fsp };
