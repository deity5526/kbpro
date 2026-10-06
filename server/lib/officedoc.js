/**
 * officedoc.js — convert Office Open XML documents (.docx / .xlsx / .pptx) into
 * safe HTML and plain text.
 *
 * Zero dependencies: this module only uses ./zip.js plus a small, tolerant XML
 * scanner written here. It never evaluates document content, never resolves
 * external entities, and HTML-escapes every piece of text that comes out of a
 * document, so arbitrary document content cannot inject markup.
 *
 * Design notes:
 *   - Every public function resolves; nothing rejects. On any failure the
 *     caller gets `{ ok: false, warning, html: '', text: '' }` (plus the
 *     relevant `sheets` / `slides` array for the spreadsheets/presentations).
 *   - Namespaces are treated as opaque prefixes (`w:p`, `a:blip`, `r:embed`).
 *     Lookups match the qualified name first, then the local name, which keeps
 *     the scanner tolerant of producer quirks.
 *   - Only image parts listed in IMAGE_MIME are embedded, and total embedded
 *     image bytes per document are capped (IMAGE_BUDGET).
 *
 * `xlsxToHtml`: top-level `html` contains every sheet. A single sheet is just
 * its table; multiple sheets are concatenated with an `<h3 class="sheet-title">`
 * heading before each table. `text` is the sheets joined by a blank line.
 *
 * `pptxToHtml`: `html` is one `<section class="slide">` per slide; `text` is the
 * slides joined by a blank line.
 */

import { readZipEntriesDetailed } from './zip.js';

const IMAGE_BUDGET = 15 * 1024 * 1024; // 15 MB of embedded image bytes per document
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

const XLSX_HTML_MAX_ROWS = 2000;
const XLSX_HTML_MAX_COLS = 200;
const XLSX_TEXT_MAX_ROWS = 20000;
const XLSX_TEXT_MAX_COLS = 1000;

const HL_COLORS = {
  black: '000000',
  blue: '0000ff',
  cyan: '00ffff',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGray: '808080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  green: '00ff00',
  lightGray: 'c0c0c0',
  magenta: 'ff00ff',
  red: 'ff0000',
  white: 'ffffff',
  yellow: 'ffff00',
};

/* ================================================================== */
/* XML scanner                                                        */
/* ================================================================== */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(value) {
  if (value.indexOf('&') < 0) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

function findTagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseTagBody(body) {
  const attrs = Object.create(null);
  const length = body.length;
  let i = 0;
  while (i < length && !/\s/.test(body[i])) i += 1;
  const name = body.slice(0, i);

  while (i < length) {
    while (i < length && /\s/.test(body[i])) i += 1;
    if (i >= length) break;
    const keyStart = i;
    while (i < length && !/[\s=]/.test(body[i])) i += 1;
    const key = body.slice(keyStart, i);
    while (i < length && /\s/.test(body[i])) i += 1;
    let value = '';
    if (body[i] === '=') {
      i += 1;
      while (i < length && /\s/.test(body[i])) i += 1;
      const quote = body[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const end = body.indexOf(quote, i);
        if (end < 0) {
          value = body.slice(i);
          i = length;
        } else {
          value = body.slice(i, end);
          i = end + 1;
        }
      } else {
        const start = i;
        while (i < length && !/\s/.test(body[i])) i += 1;
        value = body.slice(start, i);
      }
    }
    if (key) attrs[key] = decodeEntities(value);
  }

  return { name, attrs };
}

/**
 * Tolerant, non-validating XML scanner. Returns a tree of
 * `{ name, attrs, children }` nodes where children may mix nodes and strings.
 * Never throws on malformed input; it recovers and returns what it read.
 */
function parseXml(source) {
  const text = typeof source === 'string' ? source : String(source == null ? '' : source);
  const root = { name: '#document', attrs: Object.create(null), children: [] };
  const stack = [root];
  const length = text.length;
  let i = 0;

  const addText = (chunk) => {
    if (!chunk) return;
    stack[stack.length - 1].children.push(decodeEntities(chunk));
  };

  while (i < length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(text.slice(i));
      break;
    }
    if (lt > i) addText(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const chunk = text.slice(lt + 9, end < 0 ? length : end);
      if (chunk) stack[stack.length - 1].children.push(chunk);
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      let depth = 0;
      let j = lt + 2;
      for (; j < length; j += 1) {
        const ch = text[j];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j < length ? j + 1 : length;
      continue;
    }

    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) {
      addText(text.slice(lt));
      break;
    }
    const raw = text.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const { name, attrs } = parseTagBody(selfClosing ? raw.slice(0, -1) : raw);
    if (!name) continue;
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function localName(name) {
  const idx = name.lastIndexOf(':');
  return idx < 0 ? name : name.slice(idx + 1);
}

function nameMatches(name, wanted) {
  return name === wanted || localName(name) === localName(wanted);
}

function isElement(node) {
  return Boolean(node) && typeof node !== 'string';
}

function attr(node, name) {
  if (!isElement(node) || !node.attrs) return undefined;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  const local = localName(name);
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === local) return node.attrs[key];
  }
  return undefined;
}

function childElements(node) {
  if (!isElement(node)) return [];
  return node.children.filter(isElement);
}

function childrenNamed(node, name) {
  return childElements(node).filter((child) => nameMatches(child.name, name));
}

function firstNamed(node, name) {
  return childrenNamed(node, name)[0] || null;
}

function descendants(node, name, out = []) {
  if (!isElement(node)) return out;
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (nameMatches(child.name, name)) out.push(child);
    descendants(child, name, out);
  }
  return out;
}

function firstDescendant(node, name) {
  return descendants(node, name)[0] || null;
}

/** Visible text of a node. Whitespace-only text between elements is ignored. */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (!isElement(node)) return '';
  const hasElements = node.children.some(isElement);
  let out = '';
  for (const child of node.children) {
    if (typeof child === 'string') {
      if (!hasElements || child.trim() !== '') out += child;
    } else {
      out += textOf(child);
    }
  }
  return out;
}

function textOfNode(node) {
  return node ? textOf(node).trim() : '';
}

/* ================================================================== */
/* HTML helpers                                                       */
/* ================================================================== */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function cleanText(value) {
  return String(value == null ? '' : value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
}

function escapeHtml(value) {
  return cleanText(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function safeHref(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    if (!['http', 'https', 'mailto', 'tel', 'ftp', 'ftps'].includes(protocol)) return null;
  }
  return raw;
}

function altAttr(value) {
  return ` alt="${escapeHtml(value)}"`;
}

/* ================================================================== */
/* zip / part helpers                                                 */
/* ================================================================== */

function loadZip(buffer) {
  if (buffer === undefined || buffer === null) throw new Error('no document data was supplied');
  const entries = readZipEntriesDetailed(buffer);
  if (!entries || entries.size === 0) throw new Error('archive contains no entries');
  return entries;
}

function normalizePartPath(path) {
  const parts = [];
  for (const segment of String(path).replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function getPart(zip, path) {
  const wanted = normalizePartPath(path);
  if (!wanted) return null;
  const direct = zip.get(wanted);
  if (direct) return direct.data;
  const lower = wanted.toLowerCase();
  for (const [name, entry] of zip) {
    if (normalizePartPath(name).toLowerCase() === lower) return entry.data;
  }
  return null;
}

function resolvePart(baseDir, target) {
  const raw = String(target == null ? '' : target).replace(/\\/g, '/');
  if (!raw) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null; // external URL / scheme
  if (raw.startsWith('/')) return normalizePartPath(raw.slice(1));
  return normalizePartPath(baseDir ? `${baseDir}/${raw}` : raw);
}

function relsPathFor(partPath) {
  const idx = partPath.lastIndexOf('/');
  if (idx < 0) return `_rels/${partPath}.rels`;
  return `${partPath.slice(0, idx)}/_rels/${partPath.slice(idx + 1)}.rels`;
}

function parseRels(zip, partPath) {
  const map = new Map();
  const data = getPart(zip, relsPathFor(partPath));
  if (!data) return map;
  const doc = parseXml(data.toString('utf8'));
  for (const rel of descendants(doc, 'Relationship')) {
    const id = attr(rel, 'Id');
    if (!id) continue;
    map.set(id, {
      target: attr(rel, 'Target') || '',
      mode: attr(rel, 'TargetMode') || '',
      type: attr(rel, 'Type') || '',
    });
  }
  return map;
}

function emptyMeta() {
  return { title: '', author: '', subject: '', created: '', modified: '', wordCount: 0 };
}

function readCoreProps(zip) {
  const meta = emptyMeta();
  const data = getPart(zip, 'docProps/core.xml');
  if (!data) return meta;
  const doc = parseXml(data.toString('utf8'));
  meta.title = textOfNode(firstDescendant(doc, 'dc:title'));
  meta.author = textOfNode(firstDescendant(doc, 'dc:creator'));
  meta.subject = textOfNode(firstDescendant(doc, 'dc:subject'));
  meta.created = textOfNode(firstDescendant(doc, 'dcterms:created'));
  meta.modified = textOfNode(firstDescendant(doc, 'dcterms:modified'));
  return meta;
}

function countWords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function failureFor(warning, meta = emptyMeta()) {
  return { ok: false, html: '', text: '', meta, warning: String(warning || 'conversion failed') };
}

function errorMessage(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/* ================================================================== */
/* docx                                                               */
/* ================================================================== */

function toggleOn(node) {
  if (!node) return false;
  const value = attr(node, 'w:val');
  if (value === undefined || value === null || value === '') return true;
  const text = String(value).toLowerCase();
  return !(text === '0' || text === 'false' || text === 'off' || text === 'none');
}

function runStyle(runProps) {
  if (!runProps) return '';
  const parts = [];

  const color = attr(firstNamed(runProps, 'w:color'), 'w:val');
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) parts.push(`color:#${color.toLowerCase()}`);

  const highlight = attr(firstNamed(runProps, 'w:highlight'), 'w:val');
  if (highlight && HL_COLORS[highlight]) parts.push(`background-color:#${HL_COLORS[highlight]}`);

  const size = Number.parseInt(attr(firstNamed(runProps, 'w:sz'), 'w:val'), 10);
  if (Number.isFinite(size) && size > 0) parts.push(`font-size:${size / 2}pt`);

  return parts.join(';');
}

function imageMime(path) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(String(path || ''));
  if (!match) return null;
  return IMAGE_MIME[match[1].toLowerCase()] || null;
}

function docxImage(node, ctx) {
  const blip = firstDescendant(node, 'a:blip') || firstDescendant(node, 'v:imagedata');
  if (!blip) return '';
  const relId = attr(blip, 'r:embed') || attr(blip, 'r:id') || attr(blip, 'r:link');
  if (!relId) return '';
  const rel = ctx.rels.get(relId);
  if (!rel || rel.mode.toLowerCase() === 'external') return '';
  const partPath = resolvePart('word', rel.target);
  if (!partPath) return '';
  const mime = imageMime(partPath);
  if (!mime) return '';
  const data = getPart(ctx.zip, partPath);
  if (!data || data.length === 0) return '';
  if (data.length > ctx.imageBudget.remaining) return '';
  ctx.imageBudget.remaining -= data.length;
  return `<img src="data:${mime};base64,${data.toString('base64')}"${altAttr(partPath)}>`;
}

function renderDocxRun(run, ctx) {
  const runProps = firstNamed(run, 'w:rPr');
  const inner = renderDocxInline(run, ctx, true);
  if (!inner) return '';

  const bold = toggleOn(firstNamed(runProps, 'w:b')) || toggleOn(firstNamed(runProps, 'w:bCs'));
  const italic = toggleOn(firstNamed(runProps, 'w:i')) || toggleOn(firstNamed(runProps, 'w:iCs'));
  const underline = toggleOn(firstNamed(runProps, 'w:u'));
  const strike = toggleOn(firstNamed(runProps, 'w:strike')) || toggleOn(firstNamed(runProps, 'w:dstrike'));
  const vertAlign = String(attr(firstNamed(runProps, 'w:vertAlign'), 'w:val') || '').toLowerCase();

  let html = inner;
  if (bold) html = `<strong>${html}</strong>`;
  if (italic) html = `<em>${html}</em>`;
  if (underline) html = `<u>${html}</u>`;
  if (strike) html = `<s>${html}</s>`;
  if (vertAlign === 'superscript') html = `<sup>${html}</sup>`;
  else if (vertAlign === 'subscript') html = `<sub>${html}</sub>`;

  const style = runStyle(runProps);
  if (style) html = `<span style="${style}">${html}</span>`;
  return html;
}

function renderDocxInline(container, ctx, insideRun = false) {
  if (!isElement(container)) return '';
  // Whitespace-only text between elements is XML pretty-printing, not content.
  const hasElements = container.children.some(isElement);
  let html = '';

  for (const child of container.children) {
    if (typeof child === 'string') {
      if (child.trim() === '' && hasElements) continue;
      html += escapeHtml(child);
      continue;
    }
    const name = localName(child.name);
    switch (name) {
      case 'r':
        html += renderDocxRun(child, ctx);
        break;
      case 't':
        // A bare w:t (outside a run) still carries text.
        html += escapeHtml(textOf(child));
        break;
      case 'br':
      case 'cr':
        html += '<br>';
        break;
      case 'tab':
        html += '\t';
        break;
      case 'noBreakHyphen':
        html += '-';
        break;
      case 'softHyphen':
        html += '\u00ad';
        break;
      case 'sym': {
        const char = attr(child, 'w:char');
        const code = char ? Number.parseInt(char, 16) : NaN;
        if (Number.isFinite(code) && code > 0) {
          try {
            html += escapeHtml(String.fromCodePoint(code));
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case 'drawing':
      case 'pict':
      case 'object':
        html += docxImage(child, ctx);
        break;
      case 'hyperlink': {
        const inner = renderDocxInline(child, ctx, insideRun);
        if (!inner) break;
        const relId = attr(child, 'r:id');
        const rel = relId ? ctx.rels.get(relId) : null;
        let href = null;
        if (rel && rel.mode.toLowerCase() === 'external') href = rel.target;
        if (!href) {
          const anchor = attr(child, 'w:anchor');
          if (anchor) href = `#${anchor}`;
        }
        const safe = href ? safeHref(href) : null;
        if (safe) {
          html += `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        } else {
          html += inner;
        }
        break;
      }
      case 'del':
      case 'delText':
      case 'instrText':
        break; // revision markup: emit nothing
      case 'fldSimple':
      case 'sdt':
      case 'sdtContent':
      case 'smartTag':
      case 'ins':
      case 'bdo':
      case 'dir':
        html += renderDocxInline(child, ctx, insideRun);
        break;
      case 'bookmarkStart':
      case 'bookmarkEnd':
      case 'proofErr':
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'rPr':
      case 'pPr':
      case 'lastRenderedPageBreak':
      case 'footnoteReference':
      case 'endnoteReference':
      case 'commentReference':
        break;
      default:
        if (child.children.some(isElement)) html += renderDocxInline(child, ctx, insideRun);
        break;
    }
  }

  return html;
}

function classifyParagraphStyle(styleId, isList) {
  const compact = String(styleId || '').replace(/[\s_-]+/g, '').toLowerCase();
  const heading = /^heading([1-6])$/.exec(compact);
  if (heading) return { tag: `h${heading[1]}`, className: '', list: false };
  if (compact === 'title') return { tag: 'h1', className: 'doc-title', list: false };
  if (compact === 'subtitle') return { tag: 'h2', className: 'doc-subtitle', list: false };
  if (isList) return { tag: 'p', className: '', list: true };
  return { tag: 'p', className: '', list: false };
}

/**
 * Style ids that carry a `w:numPr` in styles.xml. Word puts list numbering on
 * the paragraph itself, but python-docx (and several other producers) attach it
 * to the "List Bullet" / "List Number" style definition instead.
 */
function parseListStyleIds(zip) {
  const ids = new Set();
  const data = getPart(zip, 'word/styles.xml');
  if (!data) return ids;
  const doc = parseXml(data.toString('utf8'));
  for (const style of descendants(doc, 'w:style')) {
    const pPr = firstNamed(style, 'w:pPr');
    if (!pPr || !firstNamed(pPr, 'w:numPr')) continue;
    const styleId = attr(style, 'w:styleId');
    if (styleId) ids.add(String(styleId));
  }
  // Common built-in names as a fallback even when styles.xml is missing.
  for (const name of ['ListBullet', 'ListNumber', 'ListParagraph', 'ListBullet2', 'ListBullet3']) {
    ids.add(name);
  }
  return ids;
}

function docxParagraph(paragraph, ctx) {
  const props = firstNamed(paragraph, 'w:pPr');
  const styleId = attr(firstNamed(props, 'w:pStyle'), 'w:val') || '';
  const isList =
    Boolean(firstNamed(props, 'w:numPr')) ||
    ctx.listStyles.has(styleId) ||
    /^list(bullet|number|paragraph|continued)/i.test(styleId.replace(/[\s_-]+/g, ''));
  const style = classifyParagraphStyle(styleId, isList);
  return {
    kind: 'p',
    html: renderDocxInline(paragraph, ctx),
    text: textOf(paragraph).replace(/\s+$/g, ''),
    tag: style.tag,
    className: style.className,
    list: style.list,
  };
}

function docxCell(tc, ctx) {
  const props = firstNamed(tc, 'w:tcPr');
  const rawSpan = Number.parseInt(attr(firstNamed(props, 'w:gridSpan'), 'w:val'), 10);
  const colspan = Number.isFinite(rawSpan) && rawSpan > 1 ? Math.min(rawSpan, 63) : 1;

  const paragraphs = childElements(tc).filter((child) => nameMatches(child.name, 'w:p'));
  const html = paragraphs.map((p) => renderDocxInline(p, ctx)).join('<br>');
  const text = paragraphs.map((p) => textOf(p).trim()).filter(Boolean).join(' ');
  return { html, text, colspan };
}

function docxTable(table, ctx) {
  const rows = [];
  for (const tr of childrenNamed(table, 'w:tr')) {
    const cells = [];
    for (const tc of childrenNamed(tr, 'w:tc')) cells.push(docxCell(tc, ctx));
    if (cells.length) rows.push(cells);
  }
  return { kind: 'tbl', rows };
}

function collectDocxBlocks(node, ctx, out = []) {
  for (const child of childElements(node)) {
    const name = localName(child.name);
    if (name === 'p') {
      out.push(docxParagraph(child, ctx));
    } else if (name === 'tbl') {
      out.push(docxTable(child, ctx));
    } else if (name === 'sectPr' || name === 'tblPr' || name === 'tblGrid') {
      // skip
    } else if (name === 'tc' || name === 'txbxContent' || name === 'sdt' || name === 'sdtContent' || name === 'body' || name === 'hdr' || name === 'ftr') {
      collectDocxBlocks(child, ctx, out);
    } else if (child.children.some(isElement)) {
      collectDocxBlocks(child, ctx, out);
    }
  }
  return out;
}

function renderDocxBlocks(blocks) {
  const out = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (const block of blocks) {
    if (block.kind === 'tbl') {
      closeList();
      const rows = block.rows
        .map((cells) => {
          const tds = cells
            .map((cell) => {
              const span = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
              return `<td${span}>${cell.html}</td>`;
            })
            .join('');
          return `<tr>${tds}</tr>`;
        })
        .join('');
      out.push(`<table class="doc-table">${rows}</table>`);
      continue;
    }

    if (block.list) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${block.html}</li>`);
      continue;
    }

    closeList();
    const classAttr = block.className ? ` class="${block.className}"` : '';
    out.push(`<${block.tag}${classAttr}>${block.html}</${block.tag}>`);
  }

  closeList();
  return out.join('');
}

function blocksToText(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (block.kind === 'p') {
      lines.push(block.text);
      continue;
    }
    for (const row of block.rows) lines.push(row.map((cell) => cell.text).join('\t'));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Convert a .docx buffer to safe HTML + plain text.
 * @returns {Promise<{ok:boolean, html:string, text:string, meta:object, warning:string}>}
 */
export async function docxToHtml(buffer) {
  const meta = emptyMeta();
  try {
    const zip = loadZip(buffer);
    const documentPart = getPart(zip, 'word/document.xml');
    if (!documentPart) {
      return failureFor('word/document.xml is missing (not a Word document?)', meta);
    }

    const context = {
      zip,
      rels: parseRels(zip, 'word/document.xml'),
      listStyles: parseListStyleIds(zip),
      imageBudget: { remaining: IMAGE_BUDGET },
    };

    const parsed = parseXml(documentPart.toString('utf8'));
    const body = firstDescendant(parsed, 'w:body') || parsed;
    const blocks = collectDocxBlocks(body, context);
    const html = renderDocxBlocks(blocks);
    const text = blocksToText(blocks);

    const core = readCoreProps(zip);
    Object.assign(meta, core);
    meta.wordCount = countWords(text);

    return {
      ok: true,
      html,
      text,
      meta,
      warning: '',
    };
  } catch (err) {
    return failureFor(`docx conversion failed: ${errorMessage(err)}`, meta);
  }
}

/** Extract plain text from a .docx buffer. Returns '' on failure. */
export async function docxToText(buffer) {
  const result = await docxToHtml(buffer);
  return result.ok ? result.text : '';
}

/* ================================================================== */
/* xlsx                                                               */
/* ================================================================== */

function sharedStringText(si) {
  // Concatenate runs, but never phonetic hints (<rPh>).
  let out = '';
  for (const child of childElements(si)) {
    const name = localName(child.name);
    if (name === 't') out += textOf(child);
    else if (name === 'r') {
      for (const t of childrenNamed(child, 't')) out += textOf(t);
    }
  }
  return out;
}

function parseSharedStrings(zip) {
  const strings = [];
  const data = getPart(zip, 'xl/sharedStrings.xml');
  if (!data) return strings;
  const doc = parseXml(data.toString('utf8'));
  const sst = firstDescendant(doc, 'sst') || doc;
  for (const si of childrenNamed(sst, 'si')) strings.push(sharedStringText(si));
  return strings;
}

function parseStyles(zip) {
  const styles = { cellXfs: [], numFmts: new Map() };
  const data = getPart(zip, 'xl/styles.xml');
  if (!data) return styles;
  const doc = parseXml(data.toString('utf8'));
  const root = firstDescendant(doc, 'styleSheet') || doc;

  const numFmtsEl = firstNamed(root, 'numFmts');
  if (numFmtsEl) {
    for (const numFmt of childrenNamed(numFmtsEl, 'numFmt')) {
      const id = Number.parseInt(attr(numFmt, 'numFmtId'), 10);
      if (!Number.isFinite(id)) continue;
      styles.numFmts.set(id, String(attr(numFmt, 'formatCode') || ''));
    }
  }

  const cellXfsEl = firstNamed(root, 'cellXfs');
  if (cellXfsEl) {
    for (const xf of childrenNamed(cellXfsEl, 'xf')) {
      const id = Number.parseInt(attr(xf, 'numFmtId'), 10);
      styles.cellXfs.push(Number.isFinite(id) ? id : 0);
    }
  }

  return styles;
}

const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const TIME_FMT_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
const PERCENT_FMT_IDS = new Set([9, 10]);
const CURRENCY_FMT_IDS = new Set([4, 37, 38, 39, 40]);

function isDateLikeFormat(numFmtId, formatCode) {
  if (DATE_FMT_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  const stripped = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[ymd]/i.test(stripped) && !/^[^ymd]*$/.test(stripped);
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatExcelDate(serial, numFmtId, formatCode) {
  const totalMs = Math.round(serial * 86400000);
  const date = new Date(EXCEL_EPOCH_MS + totalMs);
  if (Number.isNaN(date.getTime())) return String(serial);

  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const s = pad2(date.getUTCSeconds());

  const timeOnly = TIME_FMT_IDS.has(numFmtId) || (formatCode && !/[ymd]/i.test(formatCode));
  if (timeOnly) {
    if (numFmtId === 20 || numFmtId === 45 || (formatCode && !/s/i.test(formatCode))) return `${h}:${mi}`;
    return `${h}:${mi}:${s}`;
  }
  if (numFmtId === 22 || (formatCode && /h/i.test(formatCode))) return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  return `${y}-${mo}-${d}`;
}

function groupThousands(text) {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatCellValue(raw, numFmtId, numFmts) {
  if (raw === '' || raw === null || raw === undefined) return '';
  const formatCode = numFmts.get(numFmtId) || '';
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;

  if (isDateLikeFormat(numFmtId, formatCode)) {
    return formatExcelDate(numeric, numFmtId, formatCode);
  }
  if (PERCENT_FMT_IDS.has(numFmtId) || /%/.test(formatCode)) {
    const decimals = numFmtId === 10 || /\.0{2}/.test(formatCode) ? 2 : 0;
    return `${(numeric * 100).toFixed(decimals)}%`;
  }
  if (CURRENCY_FMT_IDS.has(numFmtId) || /[$€£¥]/.test(formatCode)) {
    const negative = numeric < 0;
    const body = groupThousands(Math.abs(numeric).toFixed(2));
    return `${negative ? '-' : ''}${body}`;
  }
  return raw;
}

function columnIndexFromRef(ref) {
  const match = /^([A-Za-z]+)/.exec(String(ref || ''));
  if (!match) return -1;
  let index = 0;
  const letters = match[1].toUpperCase();
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

function rowIndexFromRef(ref) {
  const match = /(\d+)$/.exec(String(ref || ''));
  if (!match) return -1;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value - 1 : -1;
}

function parseSheetCells(sheetData, ctx) {
  const map = new Map(); // rowIndex -> Map(colIndex -> { text, raw })
  let autoRow = 0;

  for (const rowEl of childrenNamed(sheetData, 'row')) {
    let rowIndex = rowIndexFromRef(attr(rowEl, 'r'));
    if (rowIndex < 0) rowIndex = autoRow;
    autoRow = rowIndex + 1;

    const rowMap = map.get(rowIndex) || new Map();
    map.set(rowIndex, rowMap);
    let autoCol = 0;

    for (const cellEl of childrenNamed(rowEl, 'c')) {
      let colIndex = columnIndexFromRef(attr(cellEl, 'r'));
      if (colIndex < 0) colIndex = autoCol;
      autoCol = colIndex + 1;

      const type = String(attr(cellEl, 't') || 'n');
      const styleIndex = Number.parseInt(attr(cellEl, 's'), 10);
      const numFmtId =
        Number.isFinite(styleIndex) && styleIndex >= 0 && styleIndex < ctx.styles.cellXfs.length
          ? ctx.styles.cellXfs[styleIndex]
          : 0;

      const valueEl = firstNamed(cellEl, 'v');
      const rawValue = valueEl ? textOf(valueEl) : '';
      let text = '';

      if (type === 's') {
        const index = Number.parseInt(rawValue, 10);
        text = Number.isFinite(index) && index >= 0 && index < ctx.sharedStrings.length
          ? ctx.sharedStrings[index]
          : '';
      } else if (type === 'inlineStr') {
        const is = firstNamed(cellEl, 'is');
        text = is ? sharedStringText(is) : '';
      } else if (type === 'str') {
        text = rawValue;
      } else if (type === 'b') {
        text = rawValue === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        text = rawValue;
      } else if (type === 'd') {
        text = rawValue.replace(/T/, ' ').replace(/Z$/, '');
      } else {
        text = formatCellValue(rawValue, numFmtId, ctx.styles.numFmts);
      }

      rowMap.set(colIndex, { text: String(text == null ? '' : text) });
    }

    if (rowMap.size === 0) map.delete(rowIndex);
  }

  return map;
}

function buildGrid(map, maxRows, maxCols) {
  const rowIndices = [...map.keys()].filter((r) => r < maxRows).sort((a, b) => a - b);
  if (rowIndices.length === 0) return { rows: [] };

  let minCol = Infinity;
  let maxCol = -1;
  for (const r of rowIndices) {
    for (const c of map.get(r).keys()) {
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
  }
  if (!Number.isFinite(minCol) || maxCol < minCol) return { rows: [] };

  const colEnd = Math.min(maxCol, minCol + maxCols - 1);
  const minRow = rowIndices[0];
  const maxRow = rowIndices[rowIndices.length - 1];
  const colCount = colEnd - minCol + 1;

  // Prefer a dense row range so that row gaps line up with the real sheet, but
  // only when that stays cheap; otherwise fall back to just the present rows.
  const denseRowCount = maxRow - minRow + 1;
  const fillGaps = denseRowCount <= maxRows && denseRowCount * colCount <= 2_000_000;
  const rowList = fillGaps ? Array.from({ length: denseRowCount }, (_, i) => minRow + i) : rowIndices;

  const rows = [];
  for (const r of rowList) {
    const source = map.get(r);
    const cells = [];
    for (let c = minCol; c <= colEnd; c += 1) {
      const cell = source ? source.get(c) : undefined;
      cells.push(cell ? cell.text : '');
    }
    rows.push({ index: r, cells });
  }

  // Trim leading all-empty rows.
  while (rows.length && rows[0].cells.every((value) => value === '')) rows.shift();

  // Trim leading all-empty columns.
  let firstUsed = 0;
  const width = rows.length ? rows[0].cells.length : 0;
  while (firstUsed < width && rows.every((row) => row.cells[firstUsed] === '')) firstUsed += 1;
  if (firstUsed > 0) {
    for (const row of rows) row.cells = row.cells.slice(firstUsed);
  }

  return { rows, colStart: minCol + firstUsed };
}

function gridToHtml(grid) {
  if (!grid.rows.length) return '<table class="sheet-table"></table>';
  const [head, ...rest] = grid.rows;
  const headHtml = `<thead><tr>${head.cells.map((v) => `<th>${escapeHtml(v)}</th>`).join('')}</tr></thead>`;
  const bodyHtml = rest.length
    ? `<tbody>${rest
        .map((row) => `<tr>${row.cells.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
    : '';
  return `<table class="sheet-table">${headHtml}${bodyHtml}</table>`;
}

function gridToText(grid) {
  return grid.rows.map((row) => row.cells.join('\t').replace(/[\t ]+$/g, '')).join('\n').trim();
}

/**
 * Convert a .xlsx buffer to safe HTML + plain text (all sheets).
 * @returns {Promise<{ok:boolean, html:string, text:string, sheets:Array, meta:object, warning:string}>}
 */
export async function xlsxToHtml(buffer) {
  const meta = emptyMeta();
  try {
    const zip = loadZip(buffer);
    const workbookPart = getPart(zip, 'xl/workbook.xml');
    if (!workbookPart) {
      return { ...failureFor('xl/workbook.xml is missing (not an Excel workbook?)', meta), sheets: [] };
    }

    const sharedStrings = parseSharedStrings(zip);
    const styles = parseStyles(zip);
    const context = { sharedStrings, styles };

    const workbook = parseXml(workbookPart.toString('utf8'));
    const rels = parseRels(zip, 'xl/workbook.xml');
    const sheetDefs = [];

    for (const sheetEl of descendants(workbook, 'sheet')) {
      const name = attr(sheetEl, 'name') || `Sheet${sheetDefs.length + 1}`;
      const relId = attr(sheetEl, 'r:id');
      const rel = relId ? rels.get(relId) : null;
      let path = rel ? resolvePart('xl', rel.target) : null;
      if (!path) path = `xl/worksheets/sheet${sheetDefs.length + 1}.xml`;
      sheetDefs.push({ name, path });
    }

    if (sheetDefs.length === 0) {
      // Fall back to whatever worksheet parts exist, in filename order.
      const found = [...zip.keys()]
        .map((entryName) => normalizePartPath(entryName))
        .filter((entryName) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entryName))
        .sort();
      found.forEach((path, index) => sheetDefs.push({ name: `Sheet${index + 1}`, path }));
    }

    const sheets = [];
    for (const def of sheetDefs) {
      const part = getPart(zip, def.path);
      if (!part) {
        sheets.push({ name: def.name, html: '<table class="sheet-table"></table>', text: '' });
        continue;
      }
      const doc = parseXml(part.toString('utf8'));
      const sheetData = firstDescendant(doc, 'sheetData') || doc;
      const cellMap = parseSheetCells(sheetData, context);

      const htmlGrid = buildGrid(cellMap, XLSX_HTML_MAX_ROWS, XLSX_HTML_MAX_COLS);
      const textGrid = buildGrid(cellMap, XLSX_TEXT_MAX_ROWS, XLSX_TEXT_MAX_COLS);
      sheets.push({
        name: def.name,
        html: gridToHtml(htmlGrid),
        text: gridToText(textGrid),
      });
    }

    const html =
      sheets.length === 0
        ? ''
        : sheets.length === 1
          ? sheets[0].html
          : sheets
              .map((sheet) => `<h3 class="sheet-title">${escapeHtml(sheet.name)}</h3>${sheet.html}`)
              .join('');

    const text = sheets
      .map((sheet) => sheet.text)
      .filter(Boolean)
      .join('\n\n');

    const core = readCoreProps(zip);
    Object.assign(meta, core);
    meta.wordCount = countWords(text);

    return { ok: true, html, text, sheets, meta, warning: '' };
  } catch (err) {
    return { ...failureFor(`xlsx conversion failed: ${errorMessage(err)}`, meta), sheets: [] };
  }
}

/** Extract plain text from a .xlsx buffer. Returns '' on failure. */
export async function xlsxToText(buffer) {
  const result = await xlsxToHtml(buffer);
  return result.ok ? result.text : '';
}

/* ================================================================== */
/* pptx                                                               */
/* ================================================================== */

function slidePlaceholderType(shape) {
  const nvSpPr = firstNamed(shape, 'p:nvSpPr') || firstNamed(shape, 'p:nvGraphicFramePr');
  const nvPr = nvSpPr ? firstNamed(nvSpPr, 'p:nvPr') : null;
  const ph = nvPr ? firstNamed(nvPr, 'p:ph') : null;
  if (!ph) return null;
  return String(attr(ph, 'type') || 'body').toLowerCase();
}

function pptxParagraphHtml(paragraph) {
  const props = firstNamed(paragraph, 'a:pPr');
  const level = Number.parseInt(attr(props, 'lvl'), 10);
  let inner = '';
  for (const child of childElements(paragraph)) {
    const name = localName(child.name);
    if (name === 'r' || name === 'fld') {
      for (const t of childrenNamed(child, 'a:t')) inner += escapeHtml(textOf(t));
      if (name === 'r') {
        for (const br of childrenNamed(child, 'a:br')) {
          if (br) inner += '<br>';
        }
      }
    } else if (name === 'br') {
      inner += '<br>';
    } else if (name === 't') {
      inner += escapeHtml(textOf(child));
    }
  }
  const classAttr = Number.isFinite(level) && level > 0 ? ` class="lvl-${Math.min(level, 8)}"` : '';
  return `<p${classAttr}>${inner}</p>`;
}

function pptxTableHtml(table) {
  const rows = childrenNamed(table, 'a:tr')
    .map((tr) => {
      const cells = childrenNamed(tr, 'a:tc')
        .map((tc) => {
          const text = childrenNamed(tc, 'a:txBody')
            .map((body) => childrenNamed(body, 'a:p').map((p) => textOf(p).trim()).filter(Boolean).join(' '))
            .filter(Boolean)
            .join(' ');
          return `<td>${escapeHtml(text)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table class="slide-table">${rows}</table>`;
}

function collectPptxShapes(node, out = []) {
  for (const child of childElements(node)) {
    const name = localName(child.name);
    if (name === 'sp' || name === 'graphicFrame' || name === 'pic' || name === 'grpSp') out.push(child);
    else if (name === 'spTree' || name === 'cSld') collectPptxShapes(child, out);
  }
  return out;
}

function renderPptxShape(shape, state) {
  const name = localName(shape.name);
  if (name === 'grpSp') {
    return collectPptxShapes(shape)
      .map((child) => renderPptxShape(child, state))
      .join('');
  }
  if (name === 'graphicFrame') {
    const table = firstDescendant(shape, 'a:tbl');
    return table ? pptxTableHtml(table) : '';
  }

  const placeholder = slidePlaceholderType(shape);
  const body = firstNamed(shape, 'p:txBody');
  if (!body) return '';
  const paragraphs = childrenNamed(body, 'a:p');
  if (paragraphs.length === 0) return '';

  const isTitle = placeholder === 'title' || placeholder === 'ctrtitle';
  if (isTitle) {
    const [first, ...rest] = paragraphs;
    const titleText = textOf(first).trim();
    let html = titleText ? `<h2>${escapeHtml(titleText)}</h2>` : '';
    for (const paragraph of rest) html += pptxParagraphHtml(paragraph);
    return html;
  }
  return paragraphs.map((paragraph) => pptxParagraphHtml(paragraph)).join('');
}

function renderPptxSlide(part, index) {
  const doc = parseXml(part.toString('utf8'));
  const tree = firstDescendant(doc, 'p:spTree');
  const shapes = tree ? collectPptxShapes(tree) : [];
  const body = shapes.map((shape) => renderPptxShape(shape, {})).join('');
  return {
    index,
    html: `<section class="slide"><div class="slide-body">${body}</div></section>`,
    text: slideTextFromShapes(shapes),
  };
}

function slideTextFromShapes(shapes) {
  const lines = [];
  for (const shape of shapes) {
    const name = localName(shape.name);
    if (name === 'grpSp') {
      const nested = slideTextFromShapes(collectPptxShapes(shape));
      if (nested) lines.push(nested);
      continue;
    }
    const body = firstNamed(shape, 'p:txBody');
    if (!body) continue;
    for (const paragraph of childrenNamed(body, 'a:p')) {
      lines.push(textOf(paragraph).trim());
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Convert a .pptx buffer to safe HTML + plain text (one section per slide).
 * @returns {Promise<{ok:boolean, html:string, text:string, slides:Array, meta:object, warning:string}>}
 */
export async function pptxToHtml(buffer) {
  const meta = emptyMeta();
  try {
    const zip = loadZip(buffer);
    const presentationPart = getPart(zip, 'ppt/presentation.xml');
    if (!presentationPart) {
      return { ...failureFor('ppt/presentation.xml is missing (not a PowerPoint file?)', meta), slides: [] };
    }

    const rels = parseRels(zip, 'ppt/presentation.xml');
    const presentation = parseXml(presentationPart.toString('utf8'));
    const order = [];

    for (const sldId of descendants(presentation, 'sldId')) {
      const relId = attr(sldId, 'r:id');
      const rel = relId ? rels.get(relId) : null;
      if (!rel) continue;
      const path = resolvePart('ppt', rel.target);
      if (path && !order.includes(path)) order.push(path);
    }

    if (order.length === 0) {
      const found = [...zip.keys()]
        .map((entryName) => normalizePartPath(entryName))
        .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/i.test(entryName))
        .sort((a, b) => {
          const na = Number.parseInt(/(\d+)\.xml$/i.exec(a)?.[1] || '0', 10);
          const nb = Number.parseInt(/(\d+)\.xml$/i.exec(b)?.[1] || '0', 10);
          return na - nb;
        });
      order.push(...found);
    }

    const slides = [];
    order.forEach((path, index) => {
      const part = getPart(zip, path);
      if (!part) return;
      slides.push(renderPptxSlide(part, index + 1));
    });

    const html = slides.map((slide) => slide.html).join('');
    const text = slides
      .map((slide) => slide.text)
      .filter(Boolean)
      .join('\n\n');

    const core = readCoreProps(zip);
    Object.assign(meta, core);
    meta.wordCount = countWords(text);

    return { ok: true, html, text, slides, meta, warning: '' };
  } catch (err) {
    return { ...failureFor(`pptx conversion failed: ${errorMessage(err)}`, meta), slides: [] };
  }
}

/** Extract plain text from a .pptx buffer. Returns '' on failure. */
export async function pptxToText(buffer) {
  const result = await pptxToHtml(buffer);
  return result.ok ? result.text : '';
}
