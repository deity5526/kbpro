/**
 * KBPRO — 归档工具（ZIP 写入 / 读取）
 *  自包含实现，零依赖，用于：知识库导出、批量备份、笔记与附件打包。
 *  写入使用 deflate（方法 8），兼容 Windows 资源管理器 / unzip / 7-Zip。
 */
import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ 时间戳 */

function dosDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: day };
}

/* ------------------------------------------------------------------ 写入 */

/**
 * 创建 ZIP 归档。
 * @param {{name:string, data:Buffer|string, compress?:boolean, mtime?:Date}[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const MAX32 = 0xffffffff;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosDateTime(entry.mtime || new Date());
    if (raw.length > MAX32 || offset > MAX32) {
      throw new Error('归档超出标准 ZIP 的 4GB 限制，请分批导出/备份');
    }

    let method = 0;
    let payload = raw;
    if (entry.compress !== false && raw.length > 0) {
      try {
        const deflated = zlib.deflateRawSync(raw, { level: 6 });
        if (deflated.length < raw.length) { method = 8; payload = deflated; }
      } catch { /* 退化为存储 */ }
    }

    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs（必须无符号）
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  if (centralBuf.length > MAX32 || offset > MAX32) {
    throw new Error('归档超出标准 ZIP 的 4GB 限制，请分批导出/备份');
  }
  if (entries.length > 0xffff) {
    throw new Error('归档条目数超过 65535，请分批导出/备份');
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ 目录遍历 */

/**
 * 递归收集目录内容为 ZIP 条目。
 * @param {string} root
 * @param {{prefix?:string, maxBytes?:number, onProgress?:Function, skip?:(p:string)=>boolean}} opts
 */
export async function directoryToEntries(root, opts = {}) {
  const prefix = opts.prefix ?? '';
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const entries = [];
  let total = 0;

  async function walk(dir) {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (opts.skip && opts.skip(rel)) continue;
      if (it.isDirectory()) {
        await walk(full);
      } else if (it.isFile()) {
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) continue;
        total += stat.size;
        if (total > maxBytes) throw new Error(`归档内容超过上限 ${Math.round(maxBytes / 1048576)} MB`);
        const data = await fsp.readFile(full);
        entries.push({ name: prefix ? `${prefix}/${rel}` : rel, data, mtime: stat.mtime });
        opts.onProgress?.({ file: rel, total });
      }
    }
  }
  await walk(root);
  return entries;
}

/* ------------------------------------------------------------------ 读取（按需） */

/** 轻量读取：仅解析中央目录，用于列出归档内容 */
export function listZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compSize, rawSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 从归档中提取单个条目 */
export function readZipEntry(buffer, meta) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const p = meta.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('本地文件头损坏');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + meta.compSize);
  if (meta.method === 0) return Buffer.from(data);
  if (meta.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的压缩方法：${meta.method}`);
}

/** 安全文件名（归档内部路径） */
export function safeArchiveName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

/** 生成时间戳文件名 */
export function timestampName(prefix = 'kbpro', ext = 'zip') {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

export { fsp };
