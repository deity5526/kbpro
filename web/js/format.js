/**
 * KBPRO — 格式化与展示辅助
 */

/* ------------------------------------------------------------------ 字节 */

export function formatBytes(n, digits = 1) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(digits)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

export function formatNumber(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

/* ------------------------------------------------------------------ 时间 */

const MIN = 60000, HOUR = 3600000, DAY = 86400000;

export function timeAgo(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < DAY * 2) return '昨天';
  if (diff < DAY * 30) return `${Math.floor(diff / DAY)} 天前`;
  if (diff < DAY * 365) return `${Math.floor(diff / (DAY * 30))} 个月前`;
  return `${Math.floor(diff / (DAY * 365))} 年前`;
}

export function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

export function formatDateTime(iso) {
  return formatDate(iso, true);
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function weekdayCN(iso) {
  const d = new Date(iso);
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
}

export function formatDuration(ms) {
  const v = Number(ms) || 0;
  if (v < 1000) return `${v} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.floor(v / 60000)} 分 ${Math.round((v % 60000) / 1000)} 秒`;
}

/* ------------------------------------------------------------------ 文件类型 */

const KIND_MAP = {
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet', numbers: 'sheet',
  ppt: 'slide', pptx: 'slide', key: 'slide', odp: 'slide',
  md: 'md', markdown: 'md', mdx: 'md',
  txt: 'txt', log: 'txt', ini: 'txt', conf: 'txt', cfg: 'txt', env: 'txt', properties: 'txt',
  json: 'code', xml: 'code', yml: 'code', yaml: 'code', toml: 'code', sql: 'code',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code',
  java: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code', cs: 'code', go: 'code',
  rs: 'code', rb: 'code', php: 'code', swift: 'code', kt: 'code', sh: 'code', ps1: 'code',
  html: 'code', htm: 'code', css: 'code', scss: 'code', less: 'code', vue: 'code', svelte: 'code',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  mp3: 'media', wav: 'media', m4a: 'media', flac: 'media', ogg: 'media', aac: 'media',
  mp4: 'media', webm: 'media', mov: 'media', avi: 'media', mkv: 'media',
  zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip'
};

export function fileKind(ext) {
  return KIND_MAP[String(ext || '').toLowerCase()] || 'other';
}

export function fileKindLabel(ext) {
  const k = fileKind(ext);
  return { pdf: 'PDF', doc: 'DOC', sheet: 'XLS', slide: 'PPT', md: 'MD', txt: 'TXT', code: 'CODE', image: 'IMG', media: 'MEDIA', zip: 'ZIP', other: 'FILE' }[k] || 'FILE';
}

export function extBadge(ext) {
  const e = String(ext || '').toUpperCase();
  return e.slice(0, 4) || 'FILE';
}

export function isPreviewable(kind) {
  return ['pdf', 'doc', 'sheet', 'slide', 'md', 'txt', 'code', 'image'].includes(kind);
}

/* ------------------------------------------------------------------ 文本 */

export function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (/[\u4e00-\u9fff]/.test(s)) return s.slice(-2);
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

export function truncate(s, n = 80) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

export function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html || '');
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

/** 无 DOM 依赖的纯文本化（用于列表摘要） */
export function plainText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 从纯文本中取摘要 */
export function excerpt(text, n = 110) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/* ------------------------------------------------------------------ 颜色 */

const PALETTE = ['#1F2937', '#374151', '#4B5563', '#0E9F6E', '#2563EB', '#7C3AED', '#C2410C', '#BE185D', '#0369A1', '#B45309'];

export function colorFor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ------------------------------------------------------------------ 其它 */

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

export function throttle(fn, wait = 120) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) { last = now; fn(...args); }
    else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, wait - (now - last));
    }
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function roleLabel(role) {
  return { owner: '所有者', admin: '管理员', editor: '编辑者', commenter: '评论者', viewer: '只读', member: '成员', guest: '访客' }[role] || role || '成员';
}

export function permissionLabel(p) {
  return { manage: '可管理', edit: '可编辑', comment: '可评论', view: '只读', none: '无权限', inherit: '继承' }[p] || p;
}

export function statusLabel(s) {
  return { ok: '已解析', processing: '解析中', pending: '待解析', failed: '解析失败', empty: '无文本' }[s] || s;
}
