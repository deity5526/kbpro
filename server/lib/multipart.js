/**
 * KBPRO — 流式 multipart/form-data 解析器
 *  零依赖，边收边落盘，支持进度回调与大文件（默认上限 200MB）。
 *
 *  设计要点：
 *   · 所有解析步骤通过单一 Promise 链串行化，避免 'data' 与 'end' 事件并发重入
 *   · 文件内容以背压安全的方式写入临时文件，不在内存中堆积
 *   · 仅当 part 带有 filename 参数时才视为文件（普通表单字段保持为字符串）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpError } from './http.js';
import { safeFileName } from './text.js';

const CRLF = Buffer.from('\r\n');
const CRLFCRLF = Buffer.from('\r\n\r\n');
const DASH_DASH = Buffer.from('--');

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {object} opts
 * @param {string} opts.tmpDir      临时文件目录
 * @param {number} [opts.maxBytes]  总体上限
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxFieldBytes]
 * @param {(info:{received:number,total:number,percent:number,filename:string})=>void} [opts.onProgress]
 * @param {(file:object)=>void} [opts.onFile]
 * @returns {Promise<{fields:Record<string,string>, files:Array<object>, total:number}>}
 */
export async function parseMultipart(req, opts = {}) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data/i.test(contentType)) {
    throw httpError(400, '请求不是 multipart/form-data');
  }
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundaryRaw = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : '';
  if (!boundaryRaw) throw httpError(400, '缺少 multipart boundary');

  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 50;
  const maxFieldBytes = opts.maxFieldBytes ?? 256 * 1024;
  const declaredTotal = Number(req.headers['content-length'] || 0);
  const tmpDir = opts.tmpDir || process.env.TEMP || '.';
  await fsp.mkdir(tmpDir, { recursive: true });

  const delimiter = Buffer.from(`--${boundaryRaw}`);
  const delimiterWithCrlf = Buffer.concat([CRLF, delimiter]);

  const fields = Object.create(null);
  const files = [];

  let buffer = Buffer.alloc(0);
  let state = 'PREAMBLE';
  let current = null;
  let totalReceived = 0;
  let finished = false;
  let settled = false;
  let chain = Promise.resolve();
  let resolveFn;
  let rejectFn;

  const finishedPromise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  /* ---------------------------------------------------------- part 管理 */

  function parseHeaders(headerBuf) {
    const lines = headerBuf.toString('utf8').split(/\r\n/);
    const headers = Object.create(null);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    // 按引号规则解析参数，避免把 name 值里的 "; filename=" 误判为文件
    const params = Object.create(null);
    const paramRe = /;\s*([\w*.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
    let pm;
    while ((pm = paramRe.exec(disposition))) {
      let val = pm[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
      params[pm[1].toLowerCase()] = val;
    }
    const name = params.name ?? '';
    const hasFilename = Object.prototype.hasOwnProperty.call(params, 'filename')
      || Object.prototype.hasOwnProperty.call(params, 'filename*');
    let filename = params.filename;
    const starred = params['filename*'];
    if (starred) {
      const v = String(starred).replace(/^[^']*''/, '');
      try { filename = decodeURIComponent(v); } catch { filename = v; }
    }
    return {
      name,
      isFile: hasFilename,
      filename: hasFilename ? (filename ?? '') : undefined,
      contentType: headers['content-type'] || ''
    };
  }

  async function beginPart(meta) {
    if (meta.isFile) {
      if (files.length >= maxFiles) throw httpError(413, `一次最多上传 ${maxFiles} 个文件`);
      const tmpPath = path.join(tmpDir, `up_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`);
      const writeStream = fs.createWriteStream(tmpPath);
      const part = {
        kind: 'file',
        name: meta.name || 'file',
        filename: meta.filename || 'unnamed',
        contentType: meta.contentType || 'application/octet-stream',
        tmpPath,
        writeStream,
        size: 0,
        streamError: null,
        hash: crypto.createHash('sha256')
      };
      writeStream.on('error', (err) => { part.streamError = err; });
      current = part;
    } else {
      current = { kind: 'field', name: meta.name || 'field', chunks: [], size: 0 };
    }
  }

  async function writeChunk(data) {
    const part = current;
    if (!part || !data.length) return;
    if (part.kind === 'field') {
      part.chunks.push(data);
      part.size += data.length;
      if (part.size > maxFieldBytes) throw httpError(413, `表单字段 ${part.name} 过大`);
      return;
    }
    if (!part.writeStream) return;
    await new Promise((resolve, reject) => {
      part.writeStream.write(data, (err) => (err ? reject(err) : resolve()));
    });
    if (part.streamError) throw part.streamError;
    part.size += data.length;
    part.hash.update(data);
  }

  /** 关键：同步摘取 current，防止并发重入导致重复 finalize */
  async function finalizePart() {
    const part = current;
    if (!part) return;
    current = null;

    if (part.kind === 'field') {
      fields[part.name] = Buffer.concat(part.chunks).toString('utf8');
      return;
    }
    const writeStream = part.writeStream;
    await new Promise((resolve, reject) => {
      writeStream.once('error', reject);
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });
    if (part.streamError) throw part.streamError;
    const info = {
      field: part.name,
      filename: safeFileName(part.filename || 'unnamed', 'unnamed'),
      contentType: part.contentType || 'application/octet-stream',
      size: part.size,
      tmpPath: part.tmpPath,
      checksum: part.hash.digest('hex')
    };
    files.push(info);
    opts.onFile?.(info);
  }

  async function discardCurrent() {
    const part = current;
    current = null;
    if (!part) return;
    if (part.writeStream) {
      try { part.writeStream.destroy(); } catch { /* ignore */ }
    }
    if (part.tmpPath) await fsp.unlink(part.tmpPath).catch(() => {});
  }

  /* ---------------------------------------------------------- 状态机 */

  async function pump() {
    for (;;) {
      if (finished) return;

      if (state === 'PREAMBLE') {
        const idx = buffer.indexOf(delimiter);
        if (idx < 0) {
          const keep = delimiter.length + 8;
          if (buffer.length > keep) buffer = buffer.subarray(buffer.length - keep);
          return;
        }
        let after = idx + delimiter.length;
        if (buffer.length < after + 2) return; // 边界尾部尚未到齐
        if (buffer.subarray(after, after + 2).equals(DASH_DASH)) { finished = true; return; }
        if (buffer.subarray(after, after + 2).equals(CRLF)) after += 2;
        buffer = buffer.subarray(after);
        state = 'HEADER';
        continue;
      }

      if (state === 'HEADER') {
        const idx = buffer.indexOf(CRLFCRLF);
        if (idx < 0) {
          if (buffer.length > 64 * 1024) throw httpError(400, 'multipart 头部异常');
          return;
        }
        const meta = parseHeaders(buffer.subarray(0, idx));
        buffer = buffer.subarray(idx + 4);
        await beginPart(meta);
        state = 'BODY';
        continue;
      }

      if (state === 'BODY') {
        const idx = buffer.indexOf(delimiterWithCrlf);
        if (idx >= 0) {
          const boundaryEnd = idx + delimiterWithCrlf.length;
          if (buffer.length < boundaryEnd + 2) return; // 等待边界后的 -- 或 CRLF 到齐
          const payload = buffer.subarray(0, idx);
          if (payload.length) await writeChunk(payload);
          const isEnd = buffer.subarray(boundaryEnd, boundaryEnd + 2).equals(DASH_DASH);
          const hasCrlf = buffer.subarray(boundaryEnd, boundaryEnd + 2).equals(CRLF);
          // 先切换缓冲，再 finalize，避免任何重入看到旧状态
          buffer = buffer.subarray(boundaryEnd + ((isEnd || hasCrlf) ? 2 : 0));
          await finalizePart();
          if (isEnd) { finished = true; return; }
          state = 'HEADER';
          continue;
        }
        // 保留尾部（boundary 可能跨越 chunk）
        const keep = delimiterWithCrlf.length + 4;
        if (buffer.length > keep) {
          const flush = buffer.subarray(0, buffer.length - keep);
          buffer = buffer.subarray(buffer.length - keep);
          await writeChunk(flush);
        }
        return;
      }
    }
  }

  /* ---------------------------------------------------------- 串行调度 */

  /** 所有解析动作串行执行，杜绝 'data' / 'end' 并发重入 */
  function enqueue(task) {
    const next = chain.then(() => task(), () => task());
    chain = next.catch(() => {});
    return next;
  }

  function fail(err) {
    if (settled) return;
    settled = true;
    enqueue(async () => { await discardCurrent(); })
      .catch(() => {})
      .finally(() => {
        try { req.destroy(); } catch { /* ignore */ }
        rejectFn(err);
      });
  }

  function succeed() {
    if (settled) return;
    settled = true;
    resolveFn({ fields: { ...fields }, files, total: totalReceived });
  }

  req.on('data', (chunk) => {
    req.pause();
    enqueue(async () => {
      try {
        if (settled || finished) return;
        totalReceived += chunk.length;
        if (totalReceived > maxBytes) {
          throw httpError(413, `上传内容超过上限 ${Math.round(maxBytes / 1048576)} MB`);
        }
        opts.onProgress?.({
          received: totalReceived,
          total: declaredTotal,
          percent: declaredTotal ? Math.min(100, Math.round((totalReceived / declaredTotal) * 100)) : 0,
          filename: current?.filename || ''
        });
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        await pump();
        if (finished) {
          await finalizePart();
          succeed();
          return;
        }
        if (!settled) req.resume();
      } catch (err) {
        fail(err);
      }
    });
  });

  req.on('end', () => {
    enqueue(async () => {
      if (settled) return;
      try {
        if (!finished) {
          await pump();
          if (!finished) await finalizePart();
        }
        succeed();
      } catch (err) {
        fail(err);
      }
    });
  });

  req.on('error', (err) => fail(httpError(400, `上传连接异常：${err.message}`)));
  req.on('aborted', () => fail(httpError(499, '上传已中断')));

  return finishedPromise;
}

/** 请求是否为 multipart */
export function isMultipart(req) {
  return /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
}
