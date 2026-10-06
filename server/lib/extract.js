/**
 * KBPRO — 文档内容抽取与在线预览
 *  统一入口：任意受支持格式 → { text, html, pages, meta, engine }
 *  支持：txt / md / csv / json / xml / html / 代码文件 / pdf / docx / xlsx / pptx
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { normalizeWhitespace, escapeHtml, safeFileName, splitExt, sanitizeHtml } from './text.js';
import { markdownToHtml, markdownToText } from './markdown.js';

/* ------------------------------------------------------------------ 类型判定 */

export const PREVIEW_KIND = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  pptx: 'pptx',
  txt: 'text',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  tsv: 'csv',
  json: 'code',
  xml: 'code',
  yml: 'code',
  yaml: 'code',
  html: 'html',
  htm: 'html',
  log: 'text',
  ini: 'code',
  toml: 'code',
  sql: 'code',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive'
};

const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'r', 'lua',
  'pl', 'dart', 'vue', 'svelte', 'css', 'scss', 'less', 'graphql', 'proto', 'dockerfile', 'makefile']);

const TEXT_EXTS = new Set(['txt', 'log', 'ini', 'conf', 'cfg', 'env', 'properties', 'gitignore', 'editorconfig']);

export function detectPreviewKind(ext, mime = '') {
  const e = String(ext || '').toLowerCase();
  if (PREVIEW_KIND[e]) return PREVIEW_KIND[e];
  if (CODE_EXTS.has(e)) return 'code';
  if (TEXT_EXTS.has(e)) return 'text';
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  if (/^text\//.test(mime)) return 'text';
  return 'binary';
}

export function isExtractable(kind) {
  return ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'markdown', 'csv', 'code', 'html', 'json'].includes(kind);
}

/* ------------------------------------------------------------------ 解码 */

/** 多编码纯文本解码：BOM → UTF-8 → GBK/GB18030 → Latin1 */
export function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.length) return { text: '', encoding: 'utf-8' };

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    let body = buf.subarray(2);
    if (body.length % 2 === 1) body = body.subarray(0, body.length - 1);
    const swapped = Buffer.from(body);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }

  // NUL 字节占比高 → 判定为二进制
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nul = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nul++;
  if (nul / sample.length > 0.02) return { text: '', encoding: 'binary' };

  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad / Math.max(1, utf8.length) < 0.004) return { text: utf8, encoding: 'utf-8' };

  for (const enc of ['gb18030', 'gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    try {
      const decoded = new TextDecoder(enc, { fatal: false }).decode(buf);
      const badCount = (decoded.match(/\uFFFD/g) || []).length;
      if (badCount / Math.max(1, decoded.length) < 0.004) return { text: decoded, encoding: enc };
    } catch { /* 该编码不受支持 */ }
  }
  return { text: utf8, encoding: 'utf-8-lossy' };
}

/* ------------------------------------------------------------------ CSV / JSON / HTML */

export function csvToHtml(text, { delimiter } = {}) {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return '';
  const head = rows[0];
  let html = '<table class="csv-table"><thead><tr>' + head.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows.slice(1)) {
    html += '<tr>' + head.map((_, i) => `<td>${escapeHtml(r[i] ?? '')}</td>`).join('') + '</tr>';
  }
  return html + '</tbody></table>';
}

export function parseCsv(text, delimiter) {
  const s = String(text ?? '');
  const firstLine = s.split(/\r?\n/)[0] || '';
  const d = delimiter || (countChar(firstLine, '\t') > countChar(firstLine, ',') ? '\t' : ',');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // 忽略
    } else field += ch;
    if (rows.length > 20000) break;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

function countChar(s, c) {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}

export function jsonToHtml(text) {
  let data;
  try { data = JSON.parse(text); } catch { return ''; }
  return `<pre class="json-view"><code>${escapeHtml(JSON.stringify(data, null, 2))}</code></pre>`;
}

export function htmlToReadableHtml(html) {
  let s = String(html ?? '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|noscript)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  return sanitizeHtml(s);
}

/* ------------------------------------------------------------------ 主入口 */

/**
 * 抽取文档内容。
 * @param {Buffer} buffer
 * @param {{ext?:string, mime?:string, name?:string}} info
 * @returns {Promise<{ok:boolean, text:string, html:string, pages:Array, pageCount:number,
 *                    meta:object, engine:string, warning:string, previewKind:string, encoding?:string}>}
 */
export async function extractDocument(buffer, info = {}) {
  const started = Date.now();
  const name = info.name || 'document';
  const { ext } = info.ext ? { ext: info.ext } : splitExt(name);
  const kind = detectPreviewKind(ext, info.mime || '');
  const cfg = loadConfig();
  const maxChars = cfg.maxExtractChars || 4 * 1024 * 1024;

  const base = {
    ok: false, text: '', html: '', pages: [], pageCount: 0,
    meta: { name: safeFileName(name) }, engine: 'none', warning: '', previewKind: kind, ms: 0
  };

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) {
    return { ...base, warning: '文件为空', ms: Date.now() - started };
  }

  try {
    switch (kind) {
      case 'markdown': {
        const { text, encoding } = decodeText(buf);
        const html = markdownToHtml(text);
        const plain = normalizeWhitespace(markdownToText(text) || text);
        return {
          ...base, ok: true, engine: 'markdown', encoding,
          text: plain.slice(0, maxChars), html,
          meta: { ...base.meta, encoding, headings: extractHeadings(text) },
          ms: Date.now() - started
        };
      }
      case 'html': {
        const { text, encoding } = decodeText(buf);
        const { htmlToText } = await import('./text.js');
        const plain = normalizeWhitespace(htmlToText(text));
        return {
          ...base, ok: true, engine: 'html', encoding,
          text: plain.slice(0, maxChars), html: htmlToReadableHtml(text),
          meta: { ...base.meta, encoding, title: extractTitle(text) },
          ms: Date.now() - started
        };
      }
      case 'csv': {
        const { text, encoding } = decodeText(buf);
        return {
          ...base, ok: true, engine: 'csv', encoding,
          text: text.slice(0, maxChars), html: csvToHtml(text),
          meta: { ...base.meta, encoding, rows: parseCsv(text).length - 1 },
          ms: Date.now() - started
        };
      }
      case 'code': {
        const { text, encoding } = decodeText(buf);
        const lines = text.split('\n').length;
        return {
          ...base, ok: true, engine: 'code', encoding,
          text: text.slice(0, maxChars),
          html: ext === 'json' ? (jsonToHtml(text) || `<pre class="code-view"><code>${escapeHtml(text)}</code></pre>`)
            : `<pre class="code-view" data-lang="${escapeHtml(ext)}"><code>${escapeHtml(text)}</code></pre>`,
          meta: { ...base.meta, encoding, lines, language: ext },
          ms: Date.now() - started
        };
      }
      case 'text': {
        const { text, encoding } = decodeText(buf);
        return {
          ...base, ok: true, engine: 'text', encoding,
          text: text.slice(0, maxChars),
          html: `<pre class="text-view">${escapeHtml(text.slice(0, 200000))}</pre>`,
          meta: { ...base.meta, encoding, lines: text.split('\n').length },
          ms: Date.now() - started
        };
      }
      case 'pdf': {
        const { extractPdfText } = await import('./pdf.js');
        const r = await extractPdfText(buf, { maxPages: 800 });
        const pages = (r.pages || []).map((p) => ({ index: p.index, text: p.text }));
        return {
          ...base, ok: !!r.ok, engine: 'pdf',
          text: String(r.text || '').slice(0, maxChars),
          html: '', pages, pageCount: r.pageCount || pages.length,
          meta: { ...base.meta, ...(r.meta || {}), isEncrypted: !!r.isEncrypted, hasToUnicode: !!r.hasToUnicode },
          warning: r.warning || (r.isImageOnly ? '该 PDF 为扫描件，未提取到文本层，建议使用 OCR' : ''),
          ms: Date.now() - started
        };
      }
      case 'docx': {
        const { docxToHtml } = await import('./officedoc.js');
        const r = await docxToHtml(buf);
        return {
          ...base, ok: !!r.ok, engine: 'docx',
          text: String(r.text || '').slice(0, maxChars),
          html: r.html || '',
          meta: { ...base.meta, ...(r.meta || {}) },
          warning: r.warning || '',
          ms: Date.now() - started
        };
      }
      case 'xlsx': {
        const { xlsxToHtml } = await import('./officedoc.js');
        const r = await xlsxToHtml(buf);
        return {
          ...base, ok: !!r.ok, engine: 'xlsx',
          text: String(r.text || '').slice(0, maxChars),
          html: r.html || '',
          meta: { ...base.meta, ...(r.meta || {}), sheets: (r.sheets || []).map((s) => s.name) },
          warning: r.warning || '',
          ms: Date.now() - started
        };
      }
      case 'pptx': {
        const { pptxToHtml } = await import('./officedoc.js');
        const r = await pptxToHtml(buf);
        return {
          ...base, ok: !!r.ok, engine: 'pptx',
          text: String(r.text || '').slice(0, maxChars),
          html: r.html || '',
          meta: { ...base.meta, ...(r.meta || {}) },
          warning: r.warning || '',
          ms: Date.now() - started
        };
      }
      default: {
        // 二进制：尝试文本解码，失败则跳过
        const { text, encoding } = decodeText(buf);
        if (encoding === 'binary' || !text.trim()) {
          return { ...base, ok: false, engine: 'none', warning: '该格式不支持内容抽取（可在文件库中预览或下载）', ms: Date.now() - started };
        }
        return {
          ...base, ok: true, engine: 'fallback', encoding,
          text: text.slice(0, maxChars), html: '',
          meta: { ...base.meta, encoding },
          warning: '未知格式，已按纯文本尝试解析',
          ms: Date.now() - started
        };
      }
    }
  } catch (err) {
    return {
      ...base, ok: false,
      warning: `解析失败：${err?.message || String(err)}`,
      ms: Date.now() - started
    };
  }
}

function extractHeadings(md) {
  const out = [];
  const re = /^\s{0,3}(#{1,6})\s+(.*)$/gm;
  let m;
  while ((m = re.exec(md)) && out.length < 60) out.push({ level: m[1].length, text: m[2].trim() });
  return out;
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].trim().slice(0, 200) : '';
}

/** 供上传流程使用的 MIME 推断 */
export function guessMime(ext, fallback = 'application/octet-stream') {
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4'
  };
  return map[String(ext || '').toLowerCase()] || fallback;
}

export { path };
