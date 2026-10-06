/**
 * kbpro/server/lib/pdf.js
 * ---------------------------------------------------------------------------
 * Dependency-free PDF text extractor (Node >= 22, ESM, zero npm deps).
 *
 * Design notes
 *  - The brute-force `N G obj` scanner is the primary object source: real-world
 *    PDFs frequently have broken/missing xref tables.  xref tables and xref
 *    streams are parsed only to recover the trailer (/Root, /Info, /Encrypt, /ID).
 *  - Everything is bounds-checked and wrapped; the exported functions always
 *    resolve, never throw, and honour a hard wall-clock budget.
 *  - All parsing is done on a `latin1` view of the buffer so that string offsets
 *    and byte offsets are identical (PDF delimiters are all ASCII).
 * ---------------------------------------------------------------------------
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';

/* ---- 0. Tiny value model + primitives ---- */
const ENTRY = Symbol('pdf.entry'); // hidden back-pointer: dict -> {num,gen,stream}

class PName { constructor(n) { this.n = n; } }
class PStr { constructor(s) { this.s = s; } } // `s` is a latin1 (byte-per-char) string
class PRef { constructor(num, gen) { this.num = num; this.gen = gen; } }
const newDict = () => Object.create(null);
const isDict = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null;
const isWS = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
  c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isTokEnd = (c) => c === undefined || isWS(c) || isDelim(c);

/** Skip whitespace and `%` comments. */
function skipWS(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isWS(c)) { i++; continue; }
    if (c === 0x25) { // '%'
      while (i < n && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++;
      continue;
    }
    break;
  }
  return i;
}

/* ---- 1. Object syntax parser ---- */

/** `/Name` with #xx escapes -> [PName|null, pos] */
function parseName(s, i) {
  if (s.charCodeAt(i) !== 0x2f) return [null, i];
  i++;
  const start = i;
  while (i < s.length && !isTokEnd(s.charCodeAt(i))) i++;
  let raw = s.slice(start, i);
  if (raw.indexOf('#') >= 0) {
    raw = raw.replace(/#([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return [new PName(raw), i];
}

/** `(literal)` with all PDF escapes -> [PStr, pos] */
function parseLiteralString(s, i) {
  i++;
  let out = '';
  let depth = 1;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) { // backslash
      i++;
      const e = s.charCodeAt(i);
      if (e === undefined || Number.isNaN(e)) break;
      if (e === 0x6e) { out += '\n'; i++; }
      else if (e === 0x72) { out += '\r'; i++; }
      else if (e === 0x74) { out += '\t'; i++; }
      else if (e === 0x62) { out += '\b'; i++; }
      else if (e === 0x66) { out += '\f'; i++; }
      else if (e === 0x28 || e === 0x29 || e === 0x5c) { out += s[i]; i++; }
      else if (e === 0x0d) { i++; if (s.charCodeAt(i) === 0x0a) i++; }
      else if (e === 0x0a) { i++; }
      else if (e >= 0x30 && e <= 0x37) { // 1..3 octal digits
        let v = 0, k = 0;
        while (k < 3) {
          const d = s.charCodeAt(i);
          if (!(d >= 0x30 && d <= 0x37)) break;
          v = v * 8 + (d - 0x30); i++; k++;
        }
        out += String.fromCharCode(v & 0xff);
      } else { out += s[i]; i++; }
      continue;
    }
    if (c === 0x28) { depth++; out += '('; i++; continue; }
    if (c === 0x29) { depth--; i++; if (depth === 0) break; out += ')'; continue; }
    out += s[i]; i++;
  }
  return [new PStr(out), i];
}

/** `<hex>` -> [PStr, pos] */
function parseHexString(s, i) {
  i++;
  let hex = '';
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x3e) { i++; break; }
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) hex += s[i];
    i++;
  }
  if (hex.length & 1) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
  return [new PStr(out), i];
}

/** Read a bare token (keyword / number text). */
function readToken(s, i) {
  const start = i;
  while (i < s.length && !isTokEnd(s.charCodeAt(i))) i++;
  return [s.slice(start, i), i];
}

function parseNumberOrKeyword(s, i, depth, refs) {
  const start = i;
  while (i < s.length && !isTokEnd(s.charCodeAt(i))) i++;
  if (i === start) return [null, i + 1];
  const tok = s.slice(start, i);
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
    const n = Number(tok);
    if (!Number.isFinite(n)) return [null, i];
    if (refs && Number.isInteger(n) && n >= 0) {
      const j = skipWS(s, i);
      let k = j;
      while (k < s.length && s.charCodeAt(k) >= 0x30 && s.charCodeAt(k) <= 0x39) k++;
      if (k > j && k - j <= 5) {
        const gen = parseInt(s.slice(j, k), 10);
        const l = skipWS(s, k);
        if (s.charCodeAt(l) === 0x52 && isTokEnd(s.charCodeAt(l + 1))) return [new PRef(n, gen), l + 1];
      }
    }
    return [n, i];
  }
  if (tok === 'true') return [true, i];
  if (tok === 'false') return [false, i];
  if (tok === 'null') return [null, i];
  return [null, i];
}

function parseArray(s, i, depth, refs) {
  i++;
  const arr = [];
  let guard = 0;
  while (i < s.length && guard++ < 500000) {
    i = skipWS(s, i);
    if (i >= s.length) break;
    if (s.charCodeAt(i) === 0x5d) { i++; break; }
    const [v, ni] = parseValue(s, i, depth + 1, refs);
    arr.push(v);
    i = ni > i ? ni : i + 1;
  }
  return [arr, i];
}

function parseDict(s, i, depth, refs) {
  i += 2;
  const d = newDict();
  let guard = 0;
  while (i < s.length && guard++ < 500000) {
    i = skipWS(s, i);
    if (i >= s.length) break;
    if (s.charCodeAt(i) === 0x3e && s.charCodeAt(i + 1) === 0x3e) { i += 2; break; }
    if (s.charCodeAt(i) !== 0x2f) {
      const [, ni] = parseValue(s, i, depth + 1, refs);
      i = ni > i ? ni : i + 1;
      continue;
    }
    const [nm, ni] = parseName(s, i);
    if (!nm) { i = ni > i ? ni : i + 1; continue; }
    const [v, ni2] = parseValue(s, ni, depth + 1, refs);
    d[nm.n] = v;
    i = ni2 > ni ? ni2 : ni;
  }
  return [d, i];
}

/** Parse one PDF object at `i`; returns [value, nextPos]. Never throws. */
function parseValue(s, i, depth, refs) {
  if (depth > 96) return [null, i + 1];
  i = skipWS(s, i);
  if (i >= s.length) return [null, i];
  const c = s.charCodeAt(i);
  if (c === 0x3c) {
    if (s.charCodeAt(i + 1) === 0x3c) return parseDict(s, i, depth, refs);
    return parseHexString(s, i);
  }
  if (c === 0x28) return parseLiteralString(s, i);
  if (c === 0x5b) return parseArray(s, i, depth, refs);
  if (c === 0x2f) return parseName(s, i);
  if (c === 0x5d || c === 0x3e || c === 0x29) return [null, i + 1];
  return parseNumberOrKeyword(s, i, depth, refs);
}

/** Peek the next bare keyword without consuming (returns '' when none). */
function peekWord(s, i) {
  const j = skipWS(s, i);
  const [tok] = readToken(s, j);
  return tok;
}

/* ---- 2. Stream filters ---- */

function flateDecode(data, cap) {
  const opt = { maxOutputLength: cap };
  const tries = [
    () => zlib.inflateSync(data, opt),
    () => zlib.inflateRawSync(data, { maxOutputLength: cap }),
    () => zlib.inflateSync(data, { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(data, { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  ];
  for (const t of tries) {
    try { return t(); } catch { /* next */ }
  }
  // leading junk before the zlib header
  for (let skip = 1; skip <= 3 && skip < data.length; skip++) {
    try { return zlib.inflateSync(data.subarray(skip), opt); } catch { /* next */ }
  }
  return Buffer.alloc(0);
}

/** LZW (TIFF/PDF variant) with EarlyChange. */
function lzwDecode(data, cap, early = 1) {
  let out = Buffer.alloc(Math.min(cap, Math.max(64, data.length * 4)));
  let outLen = 0;
  let bitPos = 0;
  let codeLen = 9;
  let nextCode = 258;
  let prev = null;
  let dict = null;
  const reset = () => { dict = new Array(4096); for (let i = 0; i < 256; i++) dict[i] = [i]; nextCode = 258; codeLen = 9; prev = null; };
  const readCode = (len) => {
    let v = 0;
    for (let k = 0; k < len; k++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return -1;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  const push = (arr) => {
    for (let k = 0; k < arr.length; k++) {
      if (outLen >= cap) return false;
      if (outLen >= out.length) {
        const grown = Buffer.alloc(Math.min(cap, Math.max(out.length * 2, outLen + 1024)));
        out.copy(grown, 0, 0, outLen);
        out = grown;
      }
      out[outLen++] = arr[k];
    }
    return true;
  };

  reset();
  let guard = 0;
  const maxCodes = Math.min(data.length * 8, 1 << 26);
  while (guard++ < maxCodes) {
    const code = readCode(codeLen);
    if (code < 0) break;
    if (code === 256) { reset(); continue; }
    if (code === 257) break;
    let entry;
    if (code < nextCode && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;
    if (!push(entry)) break;
    if (prev && nextCode < 4096) dict[nextCode++] = prev.concat([entry[0]]);
    prev = entry;
    if (nextCode + early >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return out.subarray(0, outLen);
}

function asciiHexDecode(data) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // '>'
    let v = -1;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 70) v = c - 55;
    else if (c >= 97 && c <= 102) v = c - 87;
    else continue;
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);
  return Buffer.from(out);
}

function ascii85Decode(data) {
  const out = [];
  let i = 0;
  const n = data.length;
  // optional <~ leader
  while (i < n && isWS(data[i])) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2;
  const group = [];
  while (i < n) {
    const c = data[i++];
    if (isWS(c)) continue;
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      v = v >>> 0;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group.length = 0;
      if (out.length > (1 << 27)) break;
    }
  }
  if (group.length > 1) {
    const k = group.length;
    for (let j = k; j < 5; j++) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    v = v >>> 0;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let j = 0; j < k - 1; j++) out.push(bytes[j]);
  }
  return Buffer.from(out);
}

function runLengthDecode(data, cap) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l < 128) {
      const cnt = l + 1;
      for (let k = 0; k < cnt && i < data.length; k++) out.push(data[i++]);
    } else {
      const cnt = 257 - l;
      const b = data[i++];
      if (b === undefined) break;
      for (let k = 0; k < cnt; k++) out.push(b);
    }
    if (out.length > cap) break;
  }
  return Buffer.from(out.slice(0, Math.min(out.length, cap)));
}

/** PNG/TIFF predictors. */
function applyPredictor(data, parms, doc) {
  if (!isDict(parms)) return data;
  const pred = doc.int(parms.Predictor, 1);
  if (pred <= 1) return data;
  const colors = Math.max(1, doc.int(parms.Colors, 1));
  const bpc = doc.int(parms.BitsPerComponent, 8);
  const columns = Math.max(1, doc.int(parms.Columns, 1));
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (rowLen <= 0) return data;
  if (pred === 2) { // TIFF horizontal differencing
    const out = Buffer.from(data);
    if (bpc !== 8) return out;
    for (let r = 0; r + rowLen <= out.length; r += rowLen) {
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    }
    return out;
  }
  if (pred < 10) return data;
  let stride = rowLen + 1;
  if (data.length % stride !== 0) {
    if (data.length % rowLen === 0) stride = rowLen; // missing filter bytes
    else return data;
  }
  const rows = Math.floor(data.length / stride);
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const base = r * stride;
    const ft = stride === rowLen ? 0 : data[base];
    const src = base + (stride === rowLen ? 0 : 1);
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    data.copy(row, 0, src, Math.min(src + rowLen, data.length));
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (ft) {
        case 1: row[i] = (row[i] + a) & 255; break;
        case 2: row[i] = (row[i] + b) & 255; break;
        case 3: row[i] = (row[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: break;
      }
    }
    prev = row;
  }
  return out;
}

/* ---- 3. Encryption (standard security handler) ---- */
const PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = Buffer.alloc(data.length);
  let a = 0, b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + S[a]) & 255;
    const t = S[a]; S[a] = S[b]; S[b] = t;
    out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}
const md5 = (b) => crypto.createHash('md5').update(b).digest();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function padPassword(pw) {
  const raw = Buffer.from(pw || '', 'latin1');
  const out = Buffer.alloc(32);
  const n = Math.min(32, raw.length);
  raw.copy(out, 0, 0, n);
  PAD.copy(out, n, 0, 32 - n);
  return out;
}

function aesCbcDecrypt(key, iv, data, stripPad) {
  if (!data.length) return Buffer.alloc(0);
  const d = crypto.createDecipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  let out;
  out = Buffer.concat([d.update(data), d.final()]);
  if (stripPad && out.length) {
    const p = out[out.length - 1];
    if (p >= 1 && p <= 16 && p <= out.length) out = out.subarray(0, out.length - p);
  }
  return out;
}

function aesCbcEncryptNoPad(key, iv, data) {
  const c = crypto.createCipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

/** ISO 32000-2 Algorithm 2.B (R6 hardened hash). Returns 32 bytes. */
function hash2B(password, salt, udata, r) {
  let K = sha256(Buffer.concat([password, salt, udata]));
  if (r === 5) return K;
  for (let round = 0; round < 64 || round < 200; round++) {
    const K1 = Buffer.alloc((password.length + K.length + udata.length) * 64);
    let off = 0;
    for (let i = 0; i < 64; i++) {
      password.copy(K1, off); off += password.length;
      K.copy(K1, off); off += K.length;
      udata.copy(K1, off); off += udata.length;
    }
    const E = aesCbcEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod = (mod * 256 + E[i]) % 3;
    if (mod === 0) K = crypto.createHash('sha256').update(E).digest();
    else if (mod === 1) K = crypto.createHash('sha384').update(E).digest();
    else K = crypto.createHash('sha512').update(E).digest();
    if (round >= 63 && E[E.length - 1] <= round - 31) break;
  }
  return K.subarray(0, 32);
}

/* ---- 4. Encodings ---- */

/* Adobe Glyph List subset -------------------------------------------------- */
const ASCII_NAMES = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question',
  'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore',
  'grave', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde',
];

// 0xA0 .. 0xFF (index 0 => code 0xA0)
const LATIN1_NAMES = [
  'space', 'exclamdown', 'cent', 'sterling', 'currency', 'yen', 'brokenbar', 'section', 'dieresis', 'copyright', 'ordfeminine', 'guillemotleft', 'logicalnot', 'hyphen', 'registered', 'macron',
  'degree', 'plusminus', 'twosuperior', 'threesuperior', 'acute', 'mu', 'paragraph', 'periodcentered', 'cedilla', 'onesuperior', 'ordmasculine', 'guillemotright', 'onequarter', 'onehalf', 'threequarters', 'questiondown',
  'Agrave', 'Aacute', 'Acircumflex', 'Atilde', 'Adieresis', 'Aring', 'AE', 'Ccedilla', 'Egrave', 'Eacute', 'Ecircumflex', 'Edieresis', 'Igrave', 'Iacute', 'Icircumflex', 'Idieresis',
  'Eth', 'Ntilde', 'Ograve', 'Oacute', 'Ocircumflex', 'Otilde', 'Odieresis', 'multiply', 'Oslash', 'Ugrave', 'Uacute', 'Ucircumflex', 'Udieresis', 'Yacute', 'Thorn', 'germandbls',
  'agrave', 'aacute', 'acircumflex', 'atilde', 'adieresis', 'aring', 'ae', 'ccedilla', 'egrave', 'eacute', 'ecircumflex', 'edieresis', 'igrave', 'iacute', 'icircumflex', 'idieresis',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocircumflex', 'otilde', 'odieresis', 'divide', 'oslash', 'ugrave', 'uacute', 'ucircumflex', 'udieresis', 'yacute', 'thorn', 'ydieresis',
];

// MacRomanEncoding 0x80 .. 0xFF (from PDF 32000-1 Annex D.2)
const MACROMAN_NAMES = [
  'Adieresis', 'Aring', 'Ccedilla', 'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute', 'agrave', 'acircumflex', 'adieresis', 'atilde', 'aring', 'ccedilla', 'eacute', 'egrave',
  'ecircumflex', 'edieresis', 'iacute', 'igrave', 'icircumflex', 'idieresis', 'ntilde', 'oacute', 'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave', 'ucircumflex', 'udieresis',
  'dagger', 'degree', 'cent', 'sterling', 'section', 'bullet', 'paragraph', 'germandbls', 'registered', 'copyright', 'trademark', 'acute', 'dieresis', 'notequal', 'AE', 'Oslash',
  'infinity', 'plusminus', 'lessequal', 'greaterequal', 'yen', 'mu', 'partialdiff', 'summation', 'product', 'pi', 'integral', 'ordfeminine', 'ordmasculine', 'Omega', 'ae', 'oslash',
  'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal', 'Delta', 'guillemotleft', 'guillemotright', 'ellipsis', 'space', 'Agrave', 'Atilde', 'Otilde', 'OE', 'oe',
  'endash', 'emdash', 'quotedblleft', 'quotedblright', 'quoteleft', 'quoteright', 'divide', 'lozenge', 'ydieresis', 'Ydieresis', 'fraction', 'Euro', 'guilsinglleft', 'guilsinglright', 'fi', 'fl',
  'daggerdbl', 'periodcentered', 'quotesinglbase', 'quotedblbase', 'perthousand', 'Acircumflex', 'Ecircumflex', 'Aacute', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Igrave', 'Oacute', 'Ocircumflex',
  'apple', 'Ograve', 'Uacute', 'Ucircumflex', 'Ugrave', 'dotlessi', 'circumflex', 'tilde', 'macron', 'breve', 'dotaccent', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron',
];

// Extra glyph names (specials used by the standard encodings + common extras)
const EXTRA_GLYPHS = `
minus=2212,lozenge=25CA,fraction=2044,infinity=221E,notequal=2260,lessequal=2264,greaterequal=2265,
partialdiff=2202,summation=2211,product=220F,pi=3C0,integral=222B,Omega=3A9,Delta=2206,radical=221A,
approxequal=2248,logicalnot=AC,dotlessi=131,Lslash=141,lslash=142,apple=F8FF,sfthyphen=AD,softhyphen=AD,
nbspace=A0,nonbreakingspace=A0,exclamsmall=203C,dollaroldstyle=24,questiondown=BF,
Aringacute=1FA,CE=152,ce=153,Ncommaaccent=145,ncommaaccent=146,Rcommaaccent=156,rcommaaccent=157,
Scaron=160,scaron=161,Zcaron=17D,zcaron=17E,Ydieresis=178,circumflex=2C6,tilde=2DC,
Grave=60,Acute=B4,quotesinglbase=201A,quotedblbase=201E,quotedblleft=201C,quotedblright=201D,
quoteleft=2018,quoteright=2019,guilsinglleft=2039,guilsinglright=203A,guillemotleft=AB,guillemotright=BB,
endash=2013,emdash=2014,ellipsis=2026,perthousand=2030,dagger=2020,daggerdbl=2021,bullet=2022,
periodcentered=B7,paragraph=B6,section=A7,currency=A4,sterling=A3,yen=A5,cent=A2,florin=192,
degree=B0,plusminus=B1,multiply=D7,divide=F7,brokenbar=A6,ordfeminine=AA,ordmasculine=BA,
onesuperior=B9,twosuperior=B2,threesuperior=B3,onequarter=BC,onehalf=BD,threequarters=BE,
germandbls=DF,AE=C6,OE=152,ae=E6,oe=153,oslash=F8,Oslash=D8,thorn=FE,Thorn=DE,eth=F0,Eth=D0,
mu=B5,registered=AE,copyright=A9,trademark=2122,Euro=20AC,
space=20,zero=30,one=31,two=32,three=33,four=34,five=35,six=36,seven=37,eight=38,nine=39,
zerooldstyle=30,oneoldstyle=31,twooldstyle=32,threeoldstyle=33,fouroldstyle=34,fiveoldstyle=35,
sixoldstyle=36,sevenoldstyle=37,eightoldstyle=38,nineoldstyle=39,
`;
const AGL = (() => {
  const m = new Map();
  for (let i = 0; i < ASCII_NAMES.length; i++) {
    const name = ASCII_NAMES[i];
    if (name.length === 1) m.set(name, name);
    else m.set(name, String.fromCharCode(0x20 + i));
  }
  for (let i = 0; i < LATIN1_NAMES.length; i++) {
    const name = LATIN1_NAMES[i];
    if (name === 'space') m.set(name, ' ');
    else if (name === 'hyphen') m.set(name, '-');
    else m.set(name, String.fromCharCode(0xa0 + i));
  }
  for (const row of EXTRA_GLYPHS.split(/[\n,]/)) {
    const t = row.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    m.set(t.slice(0, eq), String.fromCharCode(parseInt(t.slice(eq + 1), 16)));
  }
  return m;
})();

/** glyph name -> unicode string (handles uniXXXX / uXXXX conventions). */
function glyphToUnicode(name) {
  if (!name) return '';
  if (name.length === 1) return name;
  const direct = AGL.get(name);
  if (direct !== undefined) return direct;
  if (name.startsWith('uni') && name.length >= 7 && /^[0-9A-Fa-f]+$/.test(name.slice(3))) {
    const hex = name.slice(3);
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1 && i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    }
    return out;
  }
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) {
    const cp = parseInt(name.slice(1), 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  if (name.endsWith('.notdef')) return '';
  // `foo.sc` style suffixes are ignored; try the stem
  const dot = name.indexOf('.');
  if (dot > 0) {
    const stem = AGL.get(name.slice(0, dot));
    if (stem !== undefined) return stem;
  }
  return '';
}

/* Base encodings ----------------------------------------------------------- */

// WinAnsi = CP1252
const WINANSI_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function buildBaseEncoding(kind) {
  const arr = new Array(256).fill(null);
  for (let c = 0x20; c <= 0x7e; c++) arr[c] = String.fromCharCode(c);
  if (kind === 'winansi') {
    for (const [k, v] of Object.entries(WINANSI_HIGH)) arr[+k] = String.fromCharCode(v);
    for (let c = 0xa0; c <= 0xff; c++) arr[c] = String.fromCharCode(c);
  } else if (kind === 'macroman') {
    for (let i = 0; i < 128; i++) arr[0x80 + i] = glyphToUnicode(MACROMAN_NAMES[i]) || null;
  } else if (kind === 'standard') {
    arr[0x27] = glyphToUnicode('quoteright');
    arr[0x60] = glyphToUnicode('quoteleft');
    const std = {
      0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin',
      0xa7: 'section', 0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft',
      0xac: 'guilsinglleft', 0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl',
      0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl', 0xb4: 'periodcentered', 0xb6: 'paragraph',
      0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase', 0xba: 'quotedblright',
      0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand', 0xbf: 'questiondown',
      0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron', 0xc6: 'breve',
      0xc7: 'dotaccent', 0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut',
      0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash',
      0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine',
      0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash', 0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls',
    };
    for (const [k, n] of Object.entries(std)) arr[+k] = glyphToUnicode(n) || null;
  } else if (kind === 'pdfdoc') {
    const pd = {
      0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
      0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192,
      0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c,
      0x8e: 0x201d, 0x8f: 0x2018, 0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02,
      0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160, 0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142,
      0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
    };
    for (let c = 0xa1; c <= 0xff; c++) arr[c] = String.fromCharCode(c);
    arr[0xad] = null;
    for (const [k, v] of Object.entries(pd)) arr[+k] = String.fromCharCode(v);
  }
  return arr;
}
const BASE_ENCODINGS = {
  winansi: buildBaseEncoding('winansi'),
  macroman: buildBaseEncoding('macroman'),
  standard: buildBaseEncoding('standard'),
  pdfdoc: buildBaseEncoding('pdfdoc'),
};

function baseEncodingFor(name) {
  switch (name) {
    case 'WinAnsiEncoding': return BASE_ENCODINGS.winansi;
    case 'MacRomanEncoding': return BASE_ENCODINGS.macroman;
    case 'StandardEncoding': return BASE_ENCODINGS.standard;
    case 'PDFDocEncoding': return BASE_ENCODINGS.pdfdoc;
    default: return null;
  }
}

/** Decode a metadata string: UTF-16BE/LE when BOM-marked, else PDFDoc. */
function decodeTextString(pstr) {
  if (!pstr) return '';
  const b = Buffer.from(pstr.s, 'latin1');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return out;
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    let out = '';
    for (let i = 2; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i + 1] << 8) | b[i]);
    return out;
  }
  const map = BASE_ENCODINGS.pdfdoc;
  let out = '';
  for (let i = 0; i < b.length; i++) out += map[b[i]] !== null ? map[b[i]] : String.fromCharCode(b[i]);
  return out;
}

/* ---- 5. Document ---- */
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 20000;

class PDFDocument {
  constructor(buffer, options = {}) {
    this.buf = Buffer.isBuffer(buffer) ? buffer
      : (buffer instanceof Uint8Array ? Buffer.from(buffer)
        : Buffer.from(String(buffer ?? ''), 'latin1'));
    this.s = this.buf.toString('latin1');
    this.opts = options || {};
    this.maxPages = Number.isFinite(this.opts.maxPages) && this.opts.maxPages > 0
      ? Math.floor(this.opts.maxPages) : DEFAULT_MAX_PAGES;
    this.maxBytes = Number.isFinite(this.opts.maxBytes) && this.opts.maxBytes > 0
      ? Math.floor(this.opts.maxBytes) : DEFAULT_MAX_BYTES;
    const budget = Number.isFinite(this.opts.timeBudgetMs) && this.opts.timeBudgetMs > 0
      ? this.opts.timeBudgetMs : DEFAULT_BUDGET_MS;
    this.deadline = Date.now() + budget;
    this.password = typeof this.opts.password === 'string' ? this.opts.password : '';
    this.objects = new Map();
    this.trailer = null;
    this.isPdf = false;
    this.version = '';
    this.isEncrypted = false;
    this.locked = false;
    this.lockReason = '';
    this.encKey = null;
    this.encInfo = null;
    this.encRefKey = '';
    this.hasToUnicode = false;
    this.timedOut = false;
    this.warnings = [];
    this.fontCache = new Map();
    this.defaultFont = null;
    this._pages = null;
    this.ticks = 0;
    this.pagesFound = 0;
  }

  warn(msg) {
    if (!msg) return;
    if (this.warnings.length < 12 && this.warnings.indexOf(msg) < 0) this.warnings.push(msg);
  }

  warningText() { return this.warnings.join('; '); }

  /** Wall-clock guard; sets `timedOut` once the budget is blown. */
  check() {
    if (this.timedOut) return true;
    this.ticks++;
    if (Date.now() > this.deadline) {
      this.timedOut = true;
      this.warn('time budget exceeded; result is partial');
    }
    return this.timedOut;
  }

  /* ---- references ------------------------------------------------------- */

  deref(v) {
    if (v instanceof PRef) {
      const e = this.objects.get(v.num);
      return e ? e.value : null;
    }
    return v;
  }

  derefEntry(v) {
    if (v instanceof PRef) return this.objects.get(v.num) || null;
    if (v && typeof v === 'object' && v[ENTRY]) return v[ENTRY];
    return null;
  }

  num(v, d = 0) { const r = this.deref(v); return typeof r === 'number' && Number.isFinite(r) ? r : d; }
  int(v, d = 0) { return Math.trunc(this.num(v, d)); }
  nm(v) { const r = this.deref(v); return r instanceof PName ? r.n : ''; }
  arr(v) { const r = this.deref(v); return Array.isArray(r) ? r : null; }
  dict(v) { const r = this.deref(v); return isDict(r) ? r : null; }

  /* ---- parse ------------------------------------------------------------ */

  parse() {
    const s = this.s;
    if (this.buf.length < 8) {
      this.warn('input is too small to be a PDF');
      return this;
    }
    const hm = /^%PDF-(\d\.\d)/.exec(s.slice(0, 1024));
    if (hm) {
      this.isPdf = true;
      this.version = hm[1];
    } else {
      this.warn('missing %PDF header');
    }
    // Embedded binary data can contain "N G obj"; skip detected stream bodies.
    this.scanObjects();
    this.findTrailer();
    this.setupEncryption();
    this.decryptAll();
    this.loadObjectStreams();
    const cat = this.catalog();
    if (cat) {
      const v = this.nm(cat.Version);
      if (/^\d\.\d$/.test(v)) this.version = v;
    }
    return this;
  }

  scanObjects() {
    const s = this.s;
    const re = /(\d{1,10})[\x00\t\r\n\f ]+(\d{1,5})[\x00\t\r\n\f ]+obj(?![\w])/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (this.check()) break;
      const num = parseInt(m[1], 10);
      if (!Number.isFinite(num) || num > 8388607) continue;
      const gen = parseInt(m[2], 10);
      let i = m.index + m[0].length;
      let value = null;
      let after = i;
      try {
        const r = parseValue(s, i, 0, true);
        value = r[0]; after = r[1];
      } catch { value = null; after = i; }
      let stream = null;
      const kwPos = skipWS(s, after);
      const kw = peekWord(s, after);
      if (kw === 'stream' && isDict(value)) {
        let p = kwPos + 6;
        if (s.charCodeAt(p) === 13) p++;
        if (s.charCodeAt(p) === 10) p++;
        const r = this.extractStreamBytes(p, value);
        stream = r.data;
        re.lastIndex = r.end;
      } else if (kw === 'endobj') {
        re.lastIndex = after;
      }
      const entry = { num, gen, value, stream, compressed: false };
      if (isDict(value)) value[ENTRY] = entry;
      const prev = this.objects.get(num);
      if (!prev || prev.compressed) this.objects.set(num, entry);
    }
  }

  extractStreamBytes(start, dict) {
    const s = this.s;
    let len = -1;
    const L = dict.Length;
    if (typeof L === 'number' && Number.isFinite(L)) len = Math.trunc(L);
    else if (L instanceof PRef) {
      const e = this.objects.get(L.num);
      if (e && typeof e.value === 'number') len = Math.trunc(e.value);
    }
    let end = -1;
    if (len >= 0 && start + len <= s.length) {
      let q = start + len;
      while (q < s.length && isWS(s.charCodeAt(q))) q++;
      if (s.startsWith('endstream', q)) end = start + len;
    }
    if (end < 0) {
      let e = s.indexOf('endstream', start);
      if (e < 0) e = s.length;
      end = e;
      while (end > start && (s.charCodeAt(end - 1) === 10 || s.charCodeAt(end - 1) === 13)) end--;
    }
    return { data: this.buf.subarray(start, Math.max(start, Math.min(end, this.buf.length))), end: end + 9 };
  }

  /* ---- xref / trailer --------------------------------------------------- */

  findTrailer() {
    const s = this.s;
    const trailers = [];
    const idx = s.lastIndexOf('startxref');
    if (idx >= 0) {
      const m = /startxref[\x00\t\r\n\f ]+(\d+)/.exec(s.slice(idx, Math.min(s.length, idx + 80)));
      if (m) {
        let off = parseInt(m[1], 10);
        const seen = new Set();
        let depth = 0;
        while (off >= 0 && off < s.length && depth++ < 32 && !seen.has(off)) {
          if (this.check()) break;
          seen.add(off);
          const t = this.parseXrefSection(off);
          if (!t) break;
          trailers.push(t);
          const prev = t.Prev;
          const pv = typeof prev === 'number' ? prev : (this.deref(prev));
          off = typeof pv === 'number' && pv >= 0 ? pv : -1;
        }
      }
    }
    // Fallbacks: literal `trailer` dicts and /Type /XRef objects.
    if (!trailers.length) {
      const re = /trailer\b/g;
      let mm;
      while ((mm = re.exec(s)) !== null) {
        if (this.check()) break;
        const j = skipWS(s, mm.index + 7);
        if (s.charCodeAt(j) === 0x3c && s.charCodeAt(j + 1) === 0x3c) {
          const [d] = parseValue(s, j, 0, true);
          if (isDict(d)) trailers.push({ dict: d, xref: null });
        }
      }
      for (const e of this.objects.values()) {
        if (isDict(e.value) && this.nm(e.value.Type) === 'XRef') trailers.push({ dict: e.value, xref: null });
      }
    }
    // Merge newest-first.
    const merged = newDict();
    for (const key of ['Root', 'Info', 'Encrypt', 'ID', 'Size', 'Prev', 'EncryptMetadata']) {
      for (const t of trailers) {
        if (t.dict && t.dict[key] !== undefined) { merged[key] = t.dict[key]; break; }
      }
    }
    this.trailer = merged;
    if (!merged.Root) {
      // last resort: find a /Type /Catalog object
      for (const e of this.objects.values()) {
        if (isDict(e.value) && this.nm(e.value.Type) === 'Catalog') { merged.Root = new PRef(e.num, e.gen); break; }
      }
    }
  }

  /** Parse a classic xref table or an xref stream at `off`. Returns a trailer-ish dict. */
  parseXrefSection(off) {
    const s = this.s;
    try {
      const i = skipWS(s, off);
      if (s.startsWith('xref', i)) {
        const p = i + 4;
        const ti = s.indexOf('trailer', p);
        if (ti < 0) return null;
        // Entries are only a fallback (the brute-force scan normally wins).
        try {
          const region = s.slice(p, ti);
          let rp = 0;
          const hdrRe = /(\d+)[\x00\t\r\n\f ]+(\d+)/g;
          const entRe = /[\x00\t\r\n\f ]*(\d{1,10})[\x00\t\r\n\f ]+(\d{1,5})[\x00\t\r\n\f ]+([nf])/y;
          let guard = 0;
          while (rp < region.length && guard++ < 100000) {
            hdrRe.lastIndex = rp;
            const hm = hdrRe.exec(region);
            if (!hm) break;
            const first = parseInt(hm[1], 10);
            const count = parseInt(hm[2], 10);
            if (!Number.isFinite(first) || !Number.isFinite(count) || count < 0 || count > 2000000) break;
            let q = hm.index + hm[0].length;
            entRe.lastIndex = q;
            for (let k = 0; k < count; k++) {
              if (this.check()) break;
              const em = entRe.exec(region);
              if (!em) { q = region.length; break; }
              q = entRe.lastIndex;
              if (em[3] === 'n') this.xrefEntry(first + k, parseInt(em[1], 10), parseInt(em[2], 10));
            }
            if (q <= rp) break;
            rp = q;
          }
        } catch { /* table entries are optional */ }
        const j = skipWS(s, ti + 7);
        if (s.charCodeAt(j) !== 0x3c) return null;
        const [d] = parseValue(s, j, 0, true);
        if (!isDict(d)) return null;
        if (d.XRefStm !== undefined) {
          const xs = this.deref(d.XRefStm);
          if (typeof xs === 'number') {
            const t2 = this.parseXrefSection(xs);
            if (t2 && t2.dict) for (const k of Object.keys(t2.dict)) if (d[k] === undefined) d[k] = t2.dict[k];
          }
        }
        return { dict: d, xref: true };
      }
      // xref stream
      const num = this.objectNumberAt(i);
      const em = num >= 0 ? this.objects.get(num) : null;
      if (em && isDict(em.value) && this.nm(em.value.Type) === 'XRef') {
        const data = this.decodeStream(em);
        this.readXrefStream(em.value, data);
        return { dict: em.value, xref: true };
      }
      return null;
    } catch { return null; }
  }

  objectNumberAt(off) {
    const m = /(\d{1,10})[\x00\t\r\n\f ]+(\d{1,5})[\x00\t\r\n\f ]+obj/.exec(this.s.substr(off, 64));
    return m ? parseInt(m[1], 10) : -1;
  }

  xrefEntry(num, off, gen) {
    if (this.objects.has(num)) return;
    if (off <= 0 || off >= this.s.length) return;
    try {
      const [v, after] = parseValue(this.s, skipWS(this.s, off), 0, true);
      const e = { num, gen, value: v, stream: null, compressed: false };
      const kwPos = skipWS(this.s, after);
      const kw = peekWord(this.s, after);
      if (kw === 'stream' && isDict(v)) {
        let p = kwPos + 6;
        if (this.s.charCodeAt(p) === 13) p++;
        if (this.s.charCodeAt(p) === 10) p++;
        e.stream = this.extractStreamBytes(p, v).data;
      }
      if (isDict(v)) v[ENTRY] = e;
      this.objects.set(num, e);
    } catch { /* ignore */ }
  }

  readXrefStream(dict, data) {
    try {
      const W = this.arr(dict.W);
      if (!W || !data.length) return;
      const w = W.map((x) => this.int(x, 0));
      const rowLen = w.reduce((a, b) => a + b, 0);
      if (rowLen <= 0) return;
      const index = this.arr(dict.Index) || [0, this.int(dict.Size, 0)];
      let pos = 0;
      for (let k = 0; k + 1 < index.length; k += 2) {
        const first = this.int(index[k], 0);
        const count = this.int(index[k + 1], 0);
        for (let j = 0; j < count && pos + rowLen <= data.length; j++) {
          const f = [];
          for (let c = 0; c < w.length; c++) {
            let v = 0;
            for (let b = 0; b < w[c]; b++) v = v * 256 + data[pos++];
            f.push(v);
          }
          const type = w[0] === 0 ? 1 : f[0];
          const f2 = w[0] === 0 ? f[0] : f[1];
          const f3 = w[0] === 0 ? f[1] : f[2];
          if (type === 1) this.xrefEntry(first + j, f2, f3);
        }
      }
    } catch { /* ignore */ }
  }

  /* ---- object streams --------------------------------------------------- */

  loadObjectStreams() {
    for (const e of [...this.objects.values()]) {
      if (this.check()) break;
      if (!isDict(e.value) || this.nm(e.value.Type) !== 'ObjStm' || !e.stream) continue;
      try {
        const data = this.decodeStream(e);
        if (!data.length) continue;
        const n = this.int(e.value.N, 0);
        const first = this.int(e.value.First, 0);
        if (n <= 0 || n > 100000 || first < 0 || first > data.length) continue;
        const head = data.subarray(0, Math.min(first, data.length)).toString('latin1');
        const nums = [];
        const offs = [];
        const re = /(\d+)[\x00\t\r\n\f ]+(\d+)/g;
        let m;
        while ((m = re.exec(head)) && nums.length < n) {
          nums.push(parseInt(m[1], 10));
          offs.push(parseInt(m[2], 10));
        }
        const body = data.toString('latin1');
        for (let i = 0; i < nums.length; i++) {
          if (this.objects.has(nums[i])) continue;
          const at = first + offs[i];
          if (at < 0 || at >= body.length) continue;
          const [v] = parseValue(body, at, 0, true);
          const sub = { num: nums[i], gen: 0, value: v, stream: null, compressed: true };
          if (isDict(v)) v[ENTRY] = sub;
          this.objects.set(nums[i], sub);
        }
      } catch { /* ignore malformed object stream */ }
    }
  }

  /* ---- stream decoding -------------------------------------------------- */

  decodeStream(entry) {
    if (!entry || !entry.stream) return Buffer.alloc(0);
    let data = entry.stream;
    const dict = entry.value;
    if (!isDict(dict)) return data;
    let filters = this.deref(dict.Filter);
    let parms = this.deref(dict.DecodeParms);
    if (!filters) return data;
    if (!Array.isArray(filters)) filters = [filters];
    if (!Array.isArray(parms)) parms = [parms];
    let out = data;
    for (let i = 0; i < filters.length; i++) {
      if (this.check()) break;
      const f = this.deref(filters[i]);
      const p = this.deref(parms[i]);
      const name = f instanceof PName ? f.n : '';
      try {
        if (name === 'FlateDecode' || name === 'Fl') out = flateDecode(out, this.maxBytes);
        else if (name === 'LZWDecode' || name === 'LZW') {
          out = lzwDecode(out, this.maxBytes, isDict(p) ? this.int(p.EarlyChange, 1) : 1);
        } else if (name === 'ASCIIHexDecode' || name === 'AHx') out = asciiHexDecode(out);
        else if (name === 'ASCII85Decode' || name === 'A85') out = ascii85Decode(out);
        else if (name === 'RunLengthDecode' || name === 'RL') out = runLengthDecode(out, this.maxBytes);
        else return Buffer.alloc(0); // DCTDecode / JPXDecode / CCITTFaxDecode: no text
      } catch {
        this.warn(`failed to decode ${name || 'stream'} filter`);
        return Buffer.alloc(0);
      }
      if (isDict(p)) {
        try { out = applyPredictor(out, p, this); } catch { /* ignore */ }
      }
      if (out.length > this.maxBytes) {
        this.warn('decompressed stream exceeded maxBytes and was truncated');
        out = out.subarray(0, this.maxBytes);
      }
    }
    return out;
  }

  /* ---- encryption ------------------------------------------------------- */

  setupEncryption() {
    const t = this.trailer;
    if (!t || t.Encrypt === undefined) return;
    this.isEncrypted = true;
    const encEntry = this.derefEntry(t.Encrypt);
    if (!encEntry || !isDict(encEntry.value)) {
      this.locked = true;
      this.lockReason = 'the /Encrypt dictionary could not be read';
      return;
    }
    const d = encEntry.value;
    this.encRefKey = `${encEntry.num} ${encEntry.gen}`;
    const filter = this.nm(d.Filter) || 'Standard';
    if (filter !== 'Standard') {
      this.locked = true;
      this.lockReason = `unsupported security handler /${filter}`;
      return;
    }
    try {
      const V = this.int(d.V, 0);
      const R = this.int(d.R, 2);
      const P = this.int(d.P, 0);
      const idArr = this.arr(t.ID);
      let id0 = Buffer.alloc(0);
      if (idArr && idArr.length && idArr[0] instanceof PStr) id0 = Buffer.from(idArr[0].s, 'latin1');
      const O = d.O instanceof PStr ? Buffer.from(d.O.s, 'latin1') : Buffer.alloc(0);
      const U = d.U instanceof PStr ? Buffer.from(d.U.s, 'latin1') : Buffer.alloc(0);
      const encryptMetadata = this.deref(t.EncryptMetadata) !== false;
      const pw = this.password;
      if (V >= 5) {
        this.setupV5(d, V, R, O, U, pw, id0);
      } else {
        this.setupLegacy(d, V, R, P, O, U, pw, id0, encryptMetadata);
      }
    } catch (e) {
      this.locked = true;
      this.lockReason = 'security handler error';
      this.encKey = null;
      void e;
    }
  }

  setupLegacy(d, V, R, P, O, U, pw, id0, encryptMetadata) {
    const keyLenBits = V === 1 ? 40 : Math.max(40, Math.min(128, this.int(d.Length, 40)));
    const keyLen = Math.floor(keyLenBits / 8);
    const pbuf = Buffer.alloc(4);
    pbuf.writeInt32LE(P | 0, 0);
    const tail = [O.subarray(0, Math.min(32, O.length)), pbuf, id0];
    if (R >= 4 && !encryptMetadata) tail.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));

    /** Algorithm 3.2: file key from the (already padded) user password. */
    const derive = (paddedUser) => {
      let k = md5(Buffer.concat([paddedUser, ...tail]));
      if (R >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, keyLen));
      return k.subarray(0, keyLen);
    };
    /** Algorithm 3.4/3.5: does /U validate for this key? */
    const validates = (k) => {
      if (R === 2) return U.length >= 16 && rc4(k, PAD).subarray(0, 16).equals(U.subarray(0, 16));
      let u = rc4(k, md5(Buffer.concat([PAD, id0])));
      for (let i = 1; i <= 19; i++) {
        const k2 = Buffer.alloc(k.length);
        for (let j = 0; j < k.length; j++) k2[j] = k[j] ^ i;
        u = rc4(k2, u);
      }
      return U.length >= 16 && u.subarray(0, 16).equals(U.subarray(0, 16));
    };

    let key = derive(padPassword(pw));
    let ok = validates(key);
    if (!ok && pw !== '') {
      // Algorithm 3.3 in reverse: recover the padded user password from /O.
      let dg = md5(padPassword(pw));
      if (R >= 3) for (let i = 0; i < 50; i++) dg = md5(dg.subarray(0, keyLen));
      const okey = dg.subarray(0, keyLen);
      let recovered = O;
      if (R === 2) recovered = rc4(okey, O);
      else {
        for (let i = 19; i >= 0; i--) {
          const k2 = Buffer.alloc(keyLen);
          for (let j = 0; j < keyLen; j++) k2[j] = okey[j] ^ i;
          recovered = rc4(k2, recovered);
        }
        recovered = rc4(okey, recovered);
      }
      if (recovered.length >= 32) {
        const k2 = derive(recovered.subarray(0, 32));
        if (validates(k2)) { key = k2; ok = true; }
      }
    }
    if (!ok && pw === '') {
      this.locked = true;
      this.lockReason = 'the document requires a user password (empty password rejected)';
      return;
    }
    if (!ok) {
      this.locked = true;
      this.lockReason = 'the supplied password was rejected (user or owner password)';
      return;
    }
    this.encKey = key;
    this.encInfo = { V, R, aesStr: false, aesStm: false, legacy: true };
    if (V >= 4) {
      this.encInfo.strMethod = this.cryptMethod(d, 'StrF', V);
      this.encInfo.stmMethod = this.cryptMethod(d, 'StmF', V);
    } else {
      this.encInfo.strMethod = 'rc4';
      this.encInfo.stmMethod = 'rc4';
    }
  }

  setupV5(d, V, R, O, U, pw, id0) {
    void V; void id0;
    const UE = d.UE instanceof PStr ? Buffer.from(d.UE.s, 'latin1') : Buffer.alloc(0);
    const OE = d.OE instanceof PStr ? Buffer.from(d.OE.s, 'latin1') : Buffer.alloc(0);
    const pwBytes = Buffer.from(pw, 'latin1').subarray(0, 127);
    let fileKey = null;
    if (U.length >= 48) {
      const vsalt = U.subarray(32, 40);
      const ksalt = U.subarray(40, 48);
      const check = hash2B(pwBytes, vsalt, Buffer.alloc(0), R);
      if (check.equals(U.subarray(0, 32)) && UE.length >= 32) {
        const ikey = hash2B(pwBytes, ksalt, Buffer.alloc(0), R);
        fileKey = aesCbcDecrypt(ikey, Buffer.alloc(16), UE.subarray(0, 32), false);
      }
    }
    if (!fileKey && O.length >= 48) {
      const vsalt = O.subarray(32, 40);
      const ksalt = O.subarray(40, 48);
      const check = hash2B(pwBytes, vsalt, U.subarray(0, 48), R);
      if (check.equals(O.subarray(0, 32)) && OE.length >= 32) {
        const ikey = hash2B(pwBytes, ksalt, U.subarray(0, 48), R);
        fileKey = aesCbcDecrypt(ikey, Buffer.alloc(16), OE.subarray(0, 32), false);
      }
    }
    if (!fileKey || fileKey.length < 32) {
      this.locked = true;
      this.lockReason = pw === ''
        ? 'the document requires a password (empty password rejected)'
        : 'the supplied password was rejected';
      return;
    }
    this.encKey = fileKey.subarray(0, 32);
    this.encInfo = { V: 5, R, strMethod: 'aes256', stmMethod: 'aes256', legacy: false };
  }

  cryptMethod(d, which, V) {
    const cfName = this.nm(d[which]) || 'Identity';
    if (cfName === 'Identity') return 'none';
    const cf = isDict(d.CF) ? this.dict(d.CF[cfName]) : null;
    let cfm = cf ? this.nm(cf.CFM) : '';
    if (!cfm) cfm = V >= 5 ? 'AESV3' : 'AESV2';
    if (cfm === 'Identity') return 'none';
    if (cfm === 'V2') return 'rc4';
    if (cfm === 'AESV2') return 'aes';
    if (cfm === 'AESV3') return 'aes256';
    return V >= 5 ? 'aes256' : 'aes';
  }

  objectKey(num, gen, aes) {
    const extra = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
    const salt = aes ? Buffer.from([0x73, 0x41, 0x6c, 0x54]) : Buffer.alloc(0); // "sAlT"
    const h = md5(Buffer.concat([this.encKey, extra, salt]));
    const n = Math.min(this.encKey.length + 5, 16);
    const out = Buffer.alloc(aes ? 16 : n);
    h.copy(out, 0, 0, Math.min(n, out.length));
    return out;
  }

  decryptBytes(data, num, gen, method) {
    if (!this.encKey || method === 'none') return data;
    try {
      if (method === 'aes256') {
        if (data.length < 32) return Buffer.alloc(0);
        return aesCbcDecrypt(this.encKey, data.subarray(0, 16), data.subarray(16), true);
      }
      if (method === 'aes') {
        if (data.length < 16) return Buffer.alloc(0);
        return aesCbcDecrypt(this.objectKey(num, gen, true), data.subarray(0, 16), data.subarray(16), true);
      }
      return rc4(this.objectKey(num, gen, false), data);
    } catch {
      this.warn('failed to decrypt an object');
      return Buffer.alloc(0);
    }
  }

  decryptAll() {
    if (!this.encKey || !this.encInfo) return;
    for (const e of this.objects.values()) {
      if (`${e.num} ${e.gen}` === this.encRefKey) continue;
      try {
        e.value = this.decryptValue(e.value, e.num, e.gen);
        // Cross-reference streams are never encrypted (7.5.8.2).
        const isXRef = isDict(e.value) && this.nm(e.value.Type) === 'XRef';
        if (e.stream && e.stream.length && !isXRef) {
          e.stream = this.decryptBytes(e.stream, e.num, e.gen, this.encInfo.stmMethod || 'rc4');
        }
      } catch { /* keep going */ }
    }
  }

  decryptValue(v, num, gen, depth = 0) {
    if (depth > 32) return v;
    if (v instanceof PStr) {
      const b = this.decryptBytes(Buffer.from(v.s, 'latin1'), num, gen, this.encInfo.strMethod || 'rc4');
      return new PStr(b.toString('latin1'));
    }
    if (Array.isArray(v)) return v.map((x) => this.decryptValue(x, num, gen, depth + 1));
    if (isDict(v)) {
      const out = newDict();
      if (v[ENTRY]) out[ENTRY] = v[ENTRY];
      for (const k of Object.keys(v)) out[k] = this.decryptValue(v[k], num, gen, depth + 1);
      return out;
    }
    return v;
  }

  /* ---- navigation ------------------------------------------------------- */

  getDefaultFont() {
    if (!this.defaultFont) {
      this.defaultFont = {
        composite: false, bpc: 1, map: BASE_ENCODINGS.winansi, toUni: null,
        widths: null, defW: 500, baseFont: 'Helvetica',
      };
    }
    return this.defaultFont;
  }

  catalog() {
    if (!this.trailer) return null;
    const c = this.dict(this.trailer.Root);
    if (c) return c;
    for (const e of this.objects.values()) {
      if (isDict(e.value) && this.nm(e.value.Type) === 'Catalog') return e.value;
    }
    return null;
  }

  /** Collect pages in tree order, falling back to a /Type /Page object scan. */
  getPages() {
    if (this._pages) return this._pages;
    const out = [];
    const seen = new Set();
    let truncated = false;
    const walk = (ref, inherited, depth) => {
      if (this.check()) return;
      if (out.length >= this.maxPages) {
        if (!truncated) {
          truncated = true;
          this.warn(`page limit (maxPages=${this.maxPages}) reached; extraction stopped early`);
        }
        return;
      }
      if (depth > 64) return;
      const key = ref instanceof PRef ? `${ref.num} ${ref.gen}` : null;
      if (key) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const node = this.dict(ref);
      if (!node) return;
      const inh = {
        MediaBox: node.MediaBox !== undefined ? node.MediaBox : inherited.MediaBox,
        CropBox: node.CropBox !== undefined ? node.CropBox : inherited.CropBox,
        Rotate: node.Rotate !== undefined ? node.Rotate : inherited.Rotate,
        Resources: node.Resources !== undefined ? node.Resources : inherited.Resources,
      };
      const type = this.nm(node.Type);
      const kids = this.arr(node.Kids);
      if (type === 'Pages' || (!type && kids)) {
        if (kids) for (const k of kids) walk(k, inh, depth + 1);
        return;
      }
      if (type === 'Page' || node.Contents !== undefined || node.MediaBox !== undefined) {
        const e = this.derefEntry(ref);
        out.push({ dict: node, inh, entry: e });
        this.pagesFound++;
      }
    };
    const cat = this.catalog();
    if (cat && cat.Pages !== undefined) walk(cat.Pages, {}, 0);
    if (!out.length) {
      const all = [];
      for (const e of this.objects.values()) {
        if (isDict(e.value) && this.nm(e.value.Type) === 'Page') all.push(e);
      }
      all.sort((a, b) => a.num - b.num);
      for (const e of all) {
        if (out.length >= this.maxPages) {
          this.warn(`page limit (maxPages=${this.maxPages}) reached; extraction stopped early`);
          break;
        }
        out.push({ dict: e.value, inh: {}, entry: e });
      }
      if (all.length) this.warn('page tree was unusable; pages recovered by object scan');
    }
    this._pages = out;
    return out;
  }

  mediaBox(page) {
    let box = this.arr(page.dict.MediaBox) || this.arr(page.inh.MediaBox);
    if (!box && page.dict.CropBox === undefined) box = this.arr(page.inh.CropBox);
    if (!box) return [0, 0, 612, 792];
    const n = box.map((x) => this.num(x, 0));
    if (n.length < 4) return [0, 0, 612, 792];
    const x0 = Math.min(n[0], n[2]), y0 = Math.min(n[1], n[3]);
    const x1 = Math.max(n[0], n[2]), y1 = Math.max(n[1], n[3]);
    if (!Number.isFinite(x0) || !Number.isFinite(y1) || x1 - x0 <= 0 || y1 - y0 <= 0) return [0, 0, 612, 792];
    return [x0, y0, x1, y1];
  }

  /* ---- metadata --------------------------------------------------------- */

  meta() {
    const out = {
      title: '', author: '', subject: '', creator: '', producer: '', creationDate: '', modDate: '',
    };
    try {
      const info = this.trailer ? this.dict(this.trailer.Info) : null;
      if (info) {
        const map = {
          title: 'Title', author: 'Author', subject: 'Subject', creator: 'Creator',
          producer: 'Producer', creationDate: 'CreationDate', modDate: 'ModDate',
        };
        for (const [k, pdfKey] of Object.entries(map)) {
          const v = this.deref(info[pdfKey]);
          if (v instanceof PStr) out[k] = decodeTextString(v).replace(/\0/g, '').trim();
        }
      }
      if (!out.title || !out.author) {
        const xmp = this.xmpInfo();
        for (const k of Object.keys(out)) if (!out[k] && xmp[k]) out[k] = xmp[k];
      }
    } catch { /* metadata is best-effort */ }
    return out;
  }

  xmpInfo() {
    const out = {};
    try {
      const cat = this.catalog();
      const e = cat ? this.derefEntry(cat.Metadata) : null;
      if (!e) return out;
      const xml = this.decodeStream(e).toString('utf8');
      const grab = (re) => { const m = re.exec(xml); return m ? m[1].replace(/<[^>]*>/g, '').trim() : ''; };
      out.title = grab(/<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
      out.author = grab(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
      out.subject = grab(/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
      out.creator = grab(/<xmp:CreatorTool>([\s\S]*?)<\/xmp:CreatorTool>/);
      out.producer = grab(/<pdf:Producer>([\s\S]*?)<\/pdf:Producer>/);
      out.creationDate = grab(/<xmp:CreateDate>([\s\S]*?)<\/xmp:CreateDate>/);
      out.modDate = grab(/<xmp:ModifyDate>([\s\S]*?)<\/xmp:ModifyDate>/);
    } catch { /* ignore */ }
    return out;
  }
}

/* ---- 6. Fonts ---- */

/** Decode a CMap destination/hex string as UTF-16BE code units. */
function hexToUtf16(hex) {
  if (!hex) return '';
  let h = hex;
  const rem = h.length & 3;
  if (rem) h = h.padStart(h.length + (4 - rem), '0');
  let out = '';
  for (let i = 0; i + 3 < h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  return out;
}

/** Parse a /ToUnicode CMap stream into {map, bytes}. */
function parseToUnicodeCMap(doc, entry) {
  const map = new Map();
  let bytes = 2;
  const data = doc.decodeStream(entry);
  if (!data.length) return { map, bytes };
  const s = data.toString('latin1');
  try {
    const csRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
    let m;
    while ((m = csRe.exec(s))) {
      const h = /<([0-9A-Fa-f]+)>/.exec(m[1]);
      if (h) {
        const len = h[1].length >> 1;
        if (len >= 1 && len <= 4) bytes = len;
      }
    }
    const bcRe = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = bcRe.exec(s))) {
      const re = /<([0-9A-Fa-f]+)>[\x00\t\r\n\f ]*<([0-9A-Fa-f]*)>/g;
      let e;
      while ((e = re.exec(m[1]))) {
        const len = e[1].length >> 1;
        if (len > bytes && len <= 4) bytes = len;
        const code = parseInt(e[1], 16);
        if (Number.isFinite(code)) map.set(code, hexToUtf16(e[2]));
      }
    }
    const brRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = brRe.exec(s))) {
      const re = /<([0-9A-Fa-f]+)>[\x00\t\r\n\f ]*<([0-9A-Fa-f]+)>[\x00\t\r\n\f ]*(\[[\s\S]*?\]|<[0-9A-Fa-f]*>)/g;
      let e;
      while ((e = re.exec(m[1]))) {
        const lo = parseInt(e[1], 16);
        const hi = parseInt(e[2], 16);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
        if (e[3][0] === '[') {
          const items = e[3].match(/<[0-9A-Fa-f]*>/g) || [];
          for (let k = 0; k < items.length && lo + k <= hi; k++) {
            let hx = items[k].slice(1, -1);
            if (hx.length & 1) hx += '0';
            map.set(lo + k, hexToUtf16(hx));
          }
        } else {
          let dstHex = e[3].slice(1, -1);
          const rem = dstHex.length & 3;
          if (rem) dstHex = dstHex.padStart(dstHex.length + (4 - rem), '0');
          const units = [];
          for (let k = 0; k + 3 < dstHex.length; k += 4) units.push(parseInt(dstHex.substr(k, 4), 16));
          if (!units.length) continue;
          for (let c = lo; c <= hi; c++) {
            const u = units.slice();
            const delta = c - lo;
            let carry = delta;
            for (let k = u.length - 1; k >= 0 && carry > 0; k--) {
              const v = u[k] + carry;
              u[k] = v & 0xffff;
              carry = v >> 16;
            }
            let str = '';
            for (const x of u) str += String.fromCharCode(x);
            map.set(c, str);
          }
        }
      }
    }
  } catch { /* partial cmap is still useful */ }
  return { map, bytes };
}

function parseWArray(doc, w) {
  const widths = new Map();
  if (!Array.isArray(w)) return widths;
  let i = 0;
  while (i < w.length) {
    const first = doc.num(w[i], NaN);
    if (!Number.isFinite(first)) { i++; continue; }
    const second = w[i + 1];
    if (Array.isArray(second)) {
      for (let k = 0; k < second.length; k++) {
        const v = doc.num(second[k], NaN);
        if (Number.isFinite(v)) widths.set(first + k, v);
      }
      i += 2;
    } else {
      const last = doc.num(second, NaN);
      const val = doc.num(w[i + 2], NaN);
      if (Number.isFinite(last) && Number.isFinite(val) && last >= first && last - first < 65536) {
        for (let c = first; c <= last; c++) widths.set(c, val);
      }
      i += 3;
    }
  }
  return widths;
}

function buildSimpleEncoding(doc, fontDict) {
  const arr = new Array(256).fill(null);
  let base = null;
  const enc = doc.deref(fontDict.Encoding);
  let differences = null;
  if (enc instanceof PName) base = baseEncodingFor(enc.n);
  else if (isDict(enc)) {
    const be = doc.nm(enc.BaseEncoding);
    base = baseEncodingFor(be);
    differences = doc.arr(enc.Differences);
  }
  const src = base || BASE_ENCODINGS.standard;
  for (let c = 0; c < 256; c++) arr[c] = src[c];
  if (Array.isArray(differences)) {
    let code = 0;
    for (const item of differences) {
      const r = doc.deref(item);
      if (typeof r === 'number') code = Math.trunc(r);
      else if (r instanceof PName) {
        if (code >= 0 && code < 256) arr[code] = glyphToUnicode(r.n) || null;
        code++;
      }
      if (code > 255) break;
    }
  }
  return arr;
}

function buildFont(doc, fontDict) {
  if (!isDict(fontDict)) return null;
  const cached = doc.fontCache.get(fontDict);
  if (cached) return cached;
  const f = {
    composite: false, bpc: 1, map: null, toUni: null, widths: null, defW: 500,
    baseFont: doc.nm(fontDict.BaseFont) || '',
  };
  doc.fontCache.set(fontDict, f);
  try {
    const toUniEntry = doc.derefEntry(fontDict.ToUnicode);
    if (toUniEntry) {
      const cm = parseToUnicodeCMap(doc, toUniEntry);
      if (cm.map.size) {
        f.toUni = cm;
        f.bpc = cm.bytes;
        doc.hasToUnicode = true;
      } else {
        doc.warn('an empty /ToUnicode CMap was ignored');
      }
    }
    const subtype = doc.nm(fontDict.Subtype);
    if (subtype === 'Type0') {
      f.composite = true;
      if (!f.toUni) f.bpc = 2;
      const desc = doc.arr(fontDict.DescendantFonts);
      const df = desc && desc.length ? doc.dict(desc[0]) : null;
      if (df) {
        f.defW = doc.int(df.DW, 1000);
        f.widths = parseWArray(doc, doc.deref(df.W));
        const fd = doc.dict(df.FontDescriptor);
        if (fd && doc.num(fd.MissingWidth, 0)) f.defW = doc.num(fd.MissingWidth, f.defW);
      } else {
        f.defW = 1000;
      }
    } else {
      f.map = buildSimpleEncoding(doc, fontDict);
      const first = doc.int(fontDict.FirstChar, 0);
      const widths = doc.arr(fontDict.Widths);
      if (widths) {
        f.widths = new Map();
        for (let i = 0; i < widths.length; i++) {
          const v = doc.num(widths[i], NaN);
          if (Number.isFinite(v)) f.widths.set(first + i, v);
        }
      }
      const fd = doc.dict(fontDict.FontDescriptor);
      if (fd) {
        const mw = doc.num(fd.MissingWidth, NaN);
        if (Number.isFinite(mw) && mw > 0) f.defW = mw;
      }
      const baseFont = f.baseFont;
      if (!fontDict.Encoding && /Symbol|ZapfDingbats/i.test(baseFont)) {
        doc.warn(`font /${baseFont} uses a built-in symbolic encoding; glyphs may be inaccurate`);
      }
    }
  } catch { /* keep the partial font */ }
  return f;
}

/** Decode one show-text byte string. Returns {text, wsum} (wsum in 1/1000 em). */
function decodeShowString(doc, font, bytes) {
  let text = '';
  let wsum = 0;
  if (!font) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes.charCodeAt(i);
      if (b >= 32 && b !== 127) text += String.fromCharCode(b);
      wsum += 500;
    }
    return { text, wsum };
  }
  const widthOf = (code) => (font.widths && font.widths.get(code) !== undefined
    ? font.widths.get(code) : font.defW);
  if (font.composite) {
    const step = Math.max(1, Math.min(4, font.bpc || 2));
    for (let i = 0; i + step <= bytes.length; i += step) {
      let code = 0;
      for (let k = 0; k < step; k++) code = code * 256 + bytes.charCodeAt(i + k);
      let u = '';
      if (font.toUni) u = font.toUni.map.get(code) || '';
      if (!u && !font.toUni) u = code >= 32 ? String.fromCharCode(code) : '';
      text += u;
      wsum += widthOf(code);
    }
    return { text, wsum };
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.charCodeAt(i);
    let u = '';
    if (font.toUni) u = font.toUni.map.get(b) || '';
    if (!u && font.map) u = font.map[b] || '';
    if (!u && b >= 32 && b !== 127) u = String.fromCharCode(b);
    text += u;
    wsum += widthOf(b);
  }
  return { text, wsum };
}

/* ---- 7. Content stream interpretation ---- */

/** TJ kerning below this (in 1/1000 em, negative) is treated as a word gap.
 *  The spec suggests "roughly -120"; -180 avoids turning the uniform
 *  letter-spacing kerns (≈-120) emitted by several CJK producers into spaces. */
const TJ_SPACE_THRESHOLD = -180;

/** Multiply two PDF matrices (row-vector convention: result applies m2 first). */
function mmul(m1, m2) {  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** Concatenate every /Contents stream of a page, in order. */
function concatPageContents(doc, page) {
  const parts = [];
  const collect = (ref, depth) => {
    if (depth > 8) return;
    const arr = doc.deref(ref);
    if (Array.isArray(arr)) { for (const x of arr) collect(x, depth + 1); return; }
    const e = doc.derefEntry(ref);
    if (e && e.stream) {
      const data = doc.decodeStream(e);
      if (data.length) parts.push(data.toString('latin1'));
    }
  };
  collect(page.dict.Contents, 0);
  if (!parts.length) return '';
  return parts.join('');
}

/** Skip an inline image: returns the index just past `EI`. */
function skipInlineImage(content, i) {
  const m = /\bID[\x00\t\r\n\f]/.exec(content.substr(i, Math.min(8192, content.length - i)));
  if (!m) return content.length;
  let p = i + m.index + m[0].length;
  for (let guard = 0; guard < 1000; guard++) {
    const e = content.indexOf('EI', p);
    if (e < 0) return content.length;
    const before = content.charCodeAt(e - 1);
    const after = content.charCodeAt(e + 2);
    if (isWS(before) && (isTokEnd(after))) return e + 2;
    p = e + 2;
  }
  return content.length;
}

function runContent(doc, content, resourcesRef, ctm0, out, depth) {
  if (!content || depth > 6) return;
  const resources = doc.dict(resourcesRef) || (resourcesRef && isDict(resourcesRef) ? resourcesRef : null);
  const fontRes = resources ? doc.dict(resources.Font) : null;
  const xobjRes = resources ? doc.dict(resources.XObject) : null;
  const stack = [];
  const st = {
    ctm: ctm0.slice(), tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0],
    font: doc.getDefaultFont(), size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, fontKey: null,
  };
  const saved = [];
  let i = 0;
  const n = content.length;
  const getNum = (k, d = 0) => {
    const v = stack[stack.length - 1 - k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const codeStep = () => (st.font && st.font.composite && (st.font.bpc || 2) > 1 ? (st.font.bpc || 2) : 1);
  const countSpaces = (bytes, step) => {
    if (step !== 1) return 0;
    let k = 0;
    for (let j = 0; j < bytes.length; j++) if (bytes.charCodeAt(j) === 32) k++;
    return k;
  };

  /** Draw one hex/literal string operand. */
  const showOne = (pstr) => {
    if (!(pstr instanceof PStr) || !st.font || st.size === 0) return;
    const bytes = pstr.s;
    const trm = mmul(st.tm, st.ctm);
    const scale = Math.hypot(trm[0], trm[1]);
    const r = decodeShowString(doc, st.font, bytes);
    const step = codeStep();
    const nchars = Math.ceil(bytes.length / step);
    // tx = ((w/1000)*Tfs + Tc + Tw) * Th
    const tx = ((r.wsum / 1000) * st.size + st.tc * nchars + st.tw * countSpaces(bytes, step)) * st.th;
    if (r.text) {
      out.push({
        text: r.text, x: trm[2] * st.ts + trm[4], y: trm[3] * st.ts + trm[5],
        size: Math.max(0.5, st.size * scale), w: Math.abs(tx) * scale, font: st.font,
      });
    }
    if (tx !== 0) st.tm = mmul([1, 0, 0, 1, tx, 0], st.tm);
  };

  /** Draw a `TJ` array (strings + kerning numbers). */
  const showArray = (arr) => {
    if (!Array.isArray(arr) || !st.font || st.size === 0) return;
    const trm0 = mmul(st.tm, st.ctm);
    const scale = Math.hypot(trm0[0], trm0[1]);
    const step = codeStep();
    let text = '';
    let totalTx = 0;
    let chars = 0;
    let spaces = 0;
    for (const el of arr) {
      if (typeof el === 'number' && Number.isFinite(el)) {
        // A negative TJ value moves the pen forward. Values around -120/1000 em
        // are routinely emitted as plain letter-spacing by CJK producers, so the
        // effective "this is a space" threshold sits at -180/1000 em.
        if (el < TJ_SPACE_THRESHOLD && text && !/\s$/.test(text)) text += ' ';
        totalTx += (-el / 1000) * st.size * st.th;
        continue;
      }
      if (!(el instanceof PStr)) continue;
      const r = decodeShowString(doc, st.font, el.s);
      text += r.text;
      totalTx += (r.wsum / 1000) * st.size * st.th;
      chars += Math.ceil(el.s.length / step);
      spaces += countSpaces(el.s, step);
    }
    totalTx += (st.tc * chars + st.tw * spaces) * st.th;
    if (totalTx !== 0) st.tm = mmul([1, 0, 0, 1, totalTx, 0], st.tm);
    if (text) {
      out.push({
        text, x: trm0[2] * st.ts + trm0[4], y: trm0[3] * st.ts + trm0[5],
        size: Math.max(0.5, st.size * scale), w: Math.abs(totalTx) * scale, font: st.font,
      });
    }
  };

  while (i < n) {
    if (doc.check()) return;
    i = skipWS(content, i);
    if (i >= n) break;
    const c = content[i];
    if (c === '/') { const [v, ni] = parseName(content, i); stack.push(v); i = ni; continue; }
    if (c === '(') { const [v, ni] = parseLiteralString(content, i); stack.push(v); i = ni; continue; }
    if (c === '[') {
      const [v, ni] = parseValue(content, i, 0, false);
      stack.push(v); i = ni > i ? ni : i + 1; continue;
    }
    if (c === '<') {
      if (content[i + 1] === '<') {
        const [v, ni] = parseValue(content, i, 0, false);
        stack.push(v); i = ni > i ? ni : i + 1; continue;
      }
      const [v, ni] = parseHexString(content, i);
      stack.push(v); i = ni > i ? ni : i + 1; continue;
    }
    if (c === ']' || c === ')' || c === '>') { i++; continue; }
    const cc = content.charCodeAt(i);
    if ((cc >= 48 && cc <= 57) || c === '-' || c === '+' || c === '.') {
      const [v, ni] = parseValue(content, i, 0, false);
      stack.push(v);
      i = ni > i ? ni : i + 1;
      continue;
    }
    const [op, ni] = readToken(content, i);
    i = ni > i ? ni : i + 1;
    if (!op) continue;

    switch (op) {
      case 'q':
        saved.push({
          ctm: st.ctm.slice(), tm: st.tm.slice(), tlm: st.tlm.slice(), font: st.font,
          size: st.size, tc: st.tc, tw: st.tw, th: st.th, tl: st.tl, ts: st.ts,
        });
        break;
      case 'Q': {
        const s0 = saved.pop();
        if (s0) Object.assign(st, s0);
        break;
      }
      case 'cm': {
        if (stack.length >= 6) {
          const m = [getNum(5), getNum(4), getNum(3), getNum(2), getNum(1), getNum(0)];
          if (m.every((x) => Number.isFinite(x))) st.ctm = mmul(m, st.ctm);
        }
        break;
      }
      case 'BT':
        st.tm = [1, 0, 0, 1, 0, 0];
        st.tlm = [1, 0, 0, 1, 0, 0];
        break;
      case 'ET':
        break;
      case 'Tf': {
        const size = stack.length ? stack[stack.length - 1] : 0;
        const nameVal = stack.length > 1 ? stack[stack.length - 2] : null;
        st.size = typeof size === 'number' && Number.isFinite(size) ? size : 0;
        if (nameVal instanceof PName) {
          st.fontKey = nameVal.n;
          let fd = fontRes ? doc.dict(fontRes[nameVal.n]) : null;
          if (!fd) {
            const res = doc.dict(resourcesRef);
            const alt = res ? doc.dict(res.Font) : null;
            if (alt) fd = doc.dict(alt[nameVal.n]);
          }
          if (fd) st.font = buildFont(doc, fd);
          else st.font = doc.getDefaultFont();
        }
        break;
      }
      case 'Td': {
        const ty = getNum(0), tx = getNum(1);
        st.tlm = mmul([1, 0, 0, 1, tx, ty], st.tlm);
        st.tm = st.tlm.slice();
        break;
      }
      case 'TD': {
        const ty = getNum(0), tx = getNum(1);
        st.tl = -ty;
        st.tlm = mmul([1, 0, 0, 1, tx, ty], st.tlm);
        st.tm = st.tlm.slice();
        break;
      }
      case 'Tm': {
        if (stack.length >= 6) {
          const m = [getNum(5), getNum(4), getNum(3), getNum(2), getNum(1), getNum(0)];
          st.tm = m.slice();
          st.tlm = m.slice();
        }
        break;
      }
      case 'T*':
        st.tlm = mmul([1, 0, 0, 1, 0, -st.tl], st.tlm);
        st.tm = st.tlm.slice();
        break;
      case 'TL': st.tl = getNum(0); break;
      case 'Tc': st.tc = getNum(0); break;
      case 'Tw': st.tw = getNum(0); break;
      case 'Tz': st.th = getNum(100) / 100 || 1; break;
      case 'Ts': st.ts = getNum(0); break;
      case 'Tj':
        showOne(stack[stack.length - 1]);
        break;
      case 'TJ':
        showArray(stack[stack.length - 1]);
        break;
      case "'":
        st.tlm = mmul([1, 0, 0, 1, 0, -st.tl], st.tlm);
        st.tm = st.tlm.slice();
        showOne(stack[stack.length - 1]);
        break;
      case '"': {
        st.tw = getNum(2);
        st.tc = getNum(1);
        st.tlm = mmul([1, 0, 0, 1, 0, -st.tl], st.tlm);
        st.tm = st.tlm.slice();
        showOne(stack[stack.length - 1]);
        break;
      }
      case 'Do': {
        const nm = stack[stack.length - 1];
        if (nm instanceof PName && xobjRes) {
          const xo = doc.dict(xobjRes[nm.n]);
          if (xo && doc.nm(xo.Subtype) === 'Form') {
            const e = doc.derefEntry(xobjRes[nm.n]);
            if (e && e.stream && depth < 5) {
              const mtx = doc.arr(xo.Matrix);
              const m = mtx && mtx.length >= 6 ? mtx.map((x) => doc.num(x, 0)) : [1, 0, 0, 1, 0, 0];
              const savedState = { ctm: st.ctm.slice(), tm: st.tm.slice(), tlm: st.tlm.slice(), font: st.font, size: st.size };
              st.ctm = mmul(m, st.ctm);
              st.tm = [1, 0, 0, 1, 0, 0];
              st.tlm = [1, 0, 0, 1, 0, 0];
              const inner = doc.decodeStream(e).toString('latin1');
              runContent(doc, inner, xo.Resources || resourcesRef, st.ctm, out, depth + 1);
              Object.assign(st, savedState);
            }
          }
        }
        break;
      }
      case 'BI':
        i = skipInlineImage(content, i);
        stack.length = 0;
        break;
      default:
        break;
    }
    // Operands never survive their operator; this also bounds memory.
    stack.length = 0;
  }
}

/* ---- 8. Reading order ---- */

function runsToText(runs) {
  if (!runs.length) return '';
  const items = runs.filter((r) => r && r.text);
  if (!items.length) return '';
  // Reading order: Y descending, then X ascending.  Adjacent Y values that are
  // within ~half a font size belong to the same visual line.
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  let line = null;
  for (const it of items) {
    if (line) {
      const tol = Math.max(1.5, Math.min(line.size || 10, it.size || 10) * 0.5);
      if (Math.abs(line.y - it.y) <= tol) { line.items.push(it); continue; }
    }
    line = { y: it.y, size: it.size, items: [it] };
    lines.push(line);
  }
  const outLines = [];
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let str = '';
    let cursor = null;
    let cursorSize = 10;
    for (const it of ln.items) {
      const size = it.size || cursorSize;
      if (cursor !== null) {
        // Only a genuinely wide horizontal gap becomes a space; a negative gap is
        // almost always glyph-advance estimation error, so it never adds one.
        const gap = it.x - cursor;
        const threshold = Math.max(0.8, 0.28 * Math.max(size, cursorSize));
        if (gap > threshold && str && !/\s$/.test(str) && !/^\s/.test(it.text)) str += ' ';
      }
      str += it.text;
      cursor = it.x + (it.w || 0);
      cursorSize = size;
    }
    str = str.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, '');
    if (str.trim()) outLines.push(str);
  }
  return outLines.join('\n').replace(/\u0000/g, '');
}

/* ---- 9. Public API ---- */

function emptyResult() {
  return {
    ok: false,
    text: '',
    pages: [],
    pageCount: 0,
    meta: {
      title: '', author: '', subject: '', creator: '', producer: '', creationDate: '', modDate: '',
    },
    isEncrypted: false,
    isImageOnly: false,
    hasToUnicode: false,
    warning: '',
  };
}

export async function extractPdfText(buffer, options = {}) {
  const res = emptyResult();
  let doc = null;
  try {
    doc = new PDFDocument(buffer, options);
    doc.parse();
    res.isEncrypted = doc.isEncrypted;
    res.pageCount = doc.getPages().length;
    res.meta = doc.meta();
    if (doc.locked) {
      res.ok = false;
      res.warning = `PDF is encrypted and could not be decrypted: ${doc.lockReason}`;
      return res;
    }
    if (!doc.isPdf && doc.objects.size === 0) {
      res.ok = false;
      res.warning = doc.warningText() || 'not a PDF document';
      return res;
    }
    const pages = doc.getPages();
    if (!pages.length) doc.warn('no page objects were found');
    const outPages = [];
    let anyText = false;
    let hasContent = false;
    for (let idx = 0; idx < pages.length; idx++) {
      if (doc.check()) break;
      const page = pages[idx];
      let text = '';
      try {
        if (page.dict.Contents !== undefined) hasContent = true;
        const box = doc.mediaBox(page);
        const width = box[2] - box[0];
        const height = box[3] - box[1];
        const content = concatPageContents(doc, page);
        const runs = [];
        if (content) {
          runContent(doc, content, page.inh.Resources || page.dict.Resources, [1, 0, 0, 1, 0, 0], runs, 0);
        }
        let rotate = ((doc.int(page.dict.Rotate, doc.int(page.inh.Rotate, 0)) % 360) + 360) % 360;
        if (rotate % 90 !== 0) rotate = 0;
        for (const r of runs) {
          const x = r.x - box[0];
          const y = r.y - box[1];
          if (rotate === 90) { r.x = y; r.y = width - x; }
          else if (rotate === 180) { r.x = width - x; r.y = height - y; }
          else if (rotate === 270) { r.x = height - y; r.y = x; }
          else { r.x = x; r.y = y; }
        }
        text = runsToText(runs);
        if (text.trim()) anyText = true;
        const swapped = rotate === 90 || rotate === 270;
        outPages.push({
          index: idx,
          text,
          width: swapped ? height : width,
          height: swapped ? width : height,
        });
      } catch {
        doc.warn(`page ${idx + 1} could not be decoded`);
        outPages.push({ index: idx, text: '', width: 612, height: 792 });
      }
    }
    res.pages = outPages;
    res.pageCount = pages.length;
    res.text = outPages.map((p) => p.text).join('\n\n');
    res.hasToUnicode = doc.hasToUnicode;
    res.isImageOnly = !anyText && hasContent;
    res.ok = anyText || res.isImageOnly;
    const w = doc.warningText();
    if (w) res.warning = w;
    if (!res.ok && !res.warning) res.warning = 'no extractable text was found in this PDF';
    return res;
  } catch (e) {
    res.ok = false;
    res.warning = `PDF extraction failed: ${e && e.message ? e.message : String(e)}`;
    if (doc) {
      res.isEncrypted = doc.isEncrypted;
      try { res.meta = doc.meta(); } catch { /* ignore */ }
      try { res.pageCount = doc.getPages().length; } catch { /* ignore */ }
    }
    return res;
  }
}

export async function getPdfInfo(buffer, options = {}) {
  const out = {
    ok: false, pageCount: 0, meta: emptyResult().meta, isEncrypted: false, warning: '', version: '',
  };
  let doc = null;
  try {
    doc = new PDFDocument(buffer, options);
    doc.parse();
    out.version = doc.version;
    out.isEncrypted = doc.isEncrypted;
    out.meta = doc.meta();
    out.pageCount = doc.getPages().length;
    out.ok = doc.isPdf || doc.objects.size > 0;
    if (doc.locked) {
      out.ok = false;
      out.warning = `PDF is encrypted and could not be decrypted: ${doc.lockReason}`;
      return out;
    }
    out.warning = doc.warningText();
    if (!out.ok && !out.warning) out.warning = 'not a PDF document';
    return out;
  } catch (e) {
    out.ok = false;
    out.warning = `PDF info extraction failed: ${e && e.message ? e.message : String(e)}`;
    return out;
  }
}

export default { extractPdfText, getPdfInfo };
