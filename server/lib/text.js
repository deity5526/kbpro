/**
 * KBPRO — 文本处理基础库
 *  中文友好分词（CJK 二元组 + 拉丁词）、清洗、片段截取、命中高亮、关键词抽取。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_RE = /[a-z0-9]/;
const LATIN_RUN_RE = /[a-z0-9_+#.-]/;

export function isCJK(ch) {
  return CJK_RE.test(ch);
}

export function hasCJK(s) {
  return CJK_RE.test(String(s || ''));
}

const EN_STOP = new Set(`a an the and or but if then than that this these those of in on at to for from by with without into over under
is are was were be been being am do does did done have has had having will would shall should can could may might must
it its it's as not no nor so such too very can't cannot we you they he she i me my our your their his her them us
about above after again against all also any because before below between both during each few more most other some only
own same s t don now here there when where why how what which who whom while very just` .split(/\s+/).filter(Boolean));

const ZH_STOP = new Set('的 了 和 是 在 我 有 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 他 她 它 们 与 及 或 而 但 因 所以 如果 我们 你们 他们 这个 那个 什么 怎么 如何 可以 需要 进行 通过 以及 其中 对于 关于 根据 由于 并且 但是 因此 例如 一些 这些 那些'.split(/\s+/).filter(Boolean));

export function isStopword(tok) {
  return EN_STOP.has(tok) || ZH_STOP.has(tok);
}

/**
 * 分词：CJK 连续片段切成二元组（单字片段保留单字），拉丁/数字按词。
 * @param {string} text
 * @param {{stopwords?:boolean}} [opts]
 * @returns {string[]}
 */
export function tokenize(text, opts = {}) {
  const drop = opts.stopwords !== false;
  const s = String(text ?? '').toLowerCase();
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < s.length && CJK_RE.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length === 1) out.push(run);
      else for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2));
      i = j;
    } else if (LATIN_RE.test(ch)) {
      let j = i;
      while (j < s.length && LATIN_RUN_RE.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else {
      i++;
    }
  }
  const seenFiltered = drop ? out.filter((t) => t.length > 1 || CJK_RE.test(t)) : out;
  return drop ? seenFiltered.filter((t) => !isStopword(t)) : seenFiltered;
}

/** 词频统计 */
export function termFreq(tokens) {
  const map = new Map();
  for (const t of tokens) map.set(t, (map.get(t) || 0) + 1);
  return map;
}

/** 抽取查询词（用于高亮）：拉丁整词 + CJK 原片段 */
export function queryTerms(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const terms = new Set();
  const re = /[A-Za-z0-9_+#.-]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
  let m;
  while ((m = re.exec(s))) {
    const piece = m[0];
    if (CJK_RE.test(piece[0])) {
      terms.add(piece);
      if (piece.length > 1) for (let k = 0; k < piece.length - 1; k++) terms.add(piece.slice(k, k + 2));
    } else {
      terms.add(piece);
    }
  }
  return [...terms].filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
}

/* -------------------------------------------------------------- 清洗 / HTML */

export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const TAG_RE = /<[^>]*>/g;
const BLOCK_RE = /<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi;
const BR_RE = /<br\s*\/?>/gi;

/** HTML -> 纯文本（保留段落换行） */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(BR_RE, '\n');
  s = s.replace(BLOCK_RE, '\n');
  s = s.replace(TAG_RE, '');
  s = decodeEntities(s);
  return normalizeWhitespace(s);
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&amp;/gi, '&');
}

/** 去除脚本/事件属性，保留白名单标签（笔记 HTML 入库前净化） */
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption', 'span', 'div', 'input', 'section', 'details', 'summary']);

const ALLOWED_ATTR = new Set(['href', 'title', 'alt', 'src', 'class', 'style', 'colspan', 'rowspan',
  'data-lang', 'data-type', 'data-checked', 'type', 'checked', 'disabled', 'target', 'rel', 'width', 'height', 'id', 'start']);

/** 极简白名单净化器（不依赖第三方库） */
export function sanitizeHtml(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|form|svg|math)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*\/?>/gi, '');
  s = s.replace(/<\s*\/?\s*([a-zA-Z0-9-]+)([^<>]*)>/g, (match, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    const closing = /^<\s*\//.test(match);
    if (closing) return `</${tag}>`;
    const attrs = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = attrRe.exec(rawAttrs || ''))) {
      const name = m[1].toLowerCase();
      const value = m[3] ?? m[4] ?? m[5] ?? '';
      if (!ALLOWED_ATTR.has(name)) continue;
      if (/^on/i.test(name)) continue;
      if (name === 'href' || name === 'src') {
        const v = value.trim();
        const safe = /^(https?:|mailto:|tel:|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,|#|\/|\.\/)/i.test(v);
        if (!safe) continue;
        // data:image/svg+xml 可能携带脚本，直接拒绝
        if (/^data:image\/svg/i.test(v)) continue;
      }
      if (name === 'style') {
        if (/expression\s*\(|javascript:|url\s*\(\s*['"]?\s*javascript/i.test(value)) continue;
      }
      attrs.push(`${name}="${escapeHtml(value)}"`);
    }
    if (tag === 'a') {
      const hasTarget = /target=/.test(rawAttrs || '');
      if (hasTarget) attrs.push('rel="noopener noreferrer"');
    }
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  });
  return s;
}

/* -------------------------------------------------------------- 片段 / 高亮 */

/**
 * 在文本中定位首个命中位置，返回带上下文的片段。
 * @returns {{snippet:string, start:number, end:number}}
 */
export function makeSnippet(text, terms, { radius = 110, fallback = 200 } = {}) {
  const s = String(text ?? '');
  if (!s) return { snippet: '', start: 0, end: 0 };
  const lower = s.toLowerCase();
  let best = -1;
  let bestLen = 0;
  for (const t of terms || []) {
    if (!t) continue;
    const idx = lower.indexOf(String(t).toLowerCase());
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
      bestLen = String(t).length;
    }
  }
  if (best === -1) {
    const head = s.slice(0, fallback);
    return { snippet: head + (s.length > fallback ? '…' : ''), start: 0, end: Math.min(s.length, fallback) };
  }
  const start = Math.max(0, best - radius);
  const end = Math.min(s.length, best + bestLen + radius);
  return {
    snippet: (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : ''),
    start,
    end
  };
}

/**
 * 用 <mark> 包裹命中词；输入输出都是纯文本/已转义文本可安全使用。
 * @param {string} text 纯文本
 */
export function highlight(text, terms, { maxMarks = 400 } = {}) {
  const s = String(text ?? '');
  if (!s) return '';
  const list = (terms || []).filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  if (!list.length) return escapeHtml(s);
  const pattern = list.map(escapeRegExp).join('|');
  let re;
  try {
    re = new RegExp(pattern, 'gi');
  } catch {
    return escapeHtml(s);
  }
  let count = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (count >= maxMarks) break;
    if (m.index < last) { re.lastIndex = last; continue; }
    if (!m[0].length) { re.lastIndex++; continue; }
    out += escapeHtml(s.slice(last, m.index));
    out += `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    count++;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------- 统计 / 关键词 */

export function wordCount(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (s.match(/[A-Za-z0-9_]+/g) || []).length;
  return cjk + latin;
}

export function readingMinutes(text) {
  const w = wordCount(text);
  return Math.max(1, Math.round(w / 380));
}

export function truncate(s, n = 120) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

/** 基于 TF 的关键词抽取（CJK 二元组 + 拉丁词） */
export function extractKeywords(text, limit = 12) {
  const toks = tokenize(text);
  const tf = termFreq(toks);
  const scored = [];
  for (const [term, freq] of tf) {
    if (term.length < 2) continue;
    // 二元组按重叠度衰减：'知识' 与 '识库' 在 '知识库' 中各计一次
    const w = term.length === 2 && CJK_RE.test(term[0]) ? 1 : term.length >= 3 ? 1.6 : 1.2;
    scored.push([term, freq * w * Math.log(2 + term.length)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [term] of scored) {
    if (out.some((k) => k.includes(term) || term.includes(k))) continue;
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

/** 把文本切成句子（中文标点友好） */
export function splitSentences(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  return s
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9])/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}

/** 按标题层级切分 Markdown 风格文本 */
export function splitSections(text) {
  const lines = String(text ?? '').split('\n');
  const sections = [];
  let current = { heading: '', body: [] };
  for (const line of lines) {
    const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (current.body.length || current.heading) sections.push(current);
      current = { heading: m[2].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length || current.heading) sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, text: normalizeWhitespace(s.body.join('\n')) }))
    .filter((s) => s.text || s.heading);
}

export function toArray(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined);
  if (v === null || v === undefined || v === '') return [];
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return s.split(',').map((x) => x.trim()).filter(Boolean);
    }
  }
  return [v];
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 规范化标签：去空白、去 # 前缀、去重、限长 */
export function normalizeTags(tags) {
  const arr = toArray(tags).map((t) => String(t).trim().replace(/^#+/, '')).filter(Boolean);
  const out = [];
  for (const t of arr) {
    const v = t.slice(0, 32);
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

/** 安全文件名（用于 Content-Disposition 与磁盘） */
export function safeFileName(name, fallback = 'untitled') {
  const base = String(name ?? '').split(/[\\/]/).pop() || fallback;
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || fallback;
}

export function splitExt(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf('.');
  if (i <= 0) return { base: s, ext: '' };
  return { base: s.slice(0, i), ext: s.slice(i + 1).toLowerCase() };
}
