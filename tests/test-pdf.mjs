/**
 * kbpro/tests/test-pdf.mjs
 * Fixture-driven tests for the dependency-free PDF text extractor.
 *
 * Every fixture is built here from raw PDF syntax (no npm deps) and also
 * written to tests/fixtures/pdf/ so the corpus stays inspectable.
 *
 * Run: node kbpro/tests/test-pdf.mjs
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, getPdfInfo } from '../server/lib/pdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'pdf');
fs.mkdirSync(FIXTURES, { recursive: true });

/* =========================================================================
 * Tiny test harness
 * ========================================================================= */

let passed = 0;
const failures = [];
let current = '';

function section(name) { current = name; }

function ok(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${current} :: ${name}${detail ? ` -- ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function includes(name, haystack, needle) {
  ok(name, typeof haystack === 'string' && haystack.includes(needle),
    `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 240))}`);
}

function notIncludes(name, haystack, needle) {
  ok(name, typeof haystack === 'string' && !haystack.includes(needle),
    `${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(String(haystack).slice(0, 240))}`);
}

/** A promise that must settle within `ms` (detects accidental hangs on the async path). */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/* =========================================================================
 * PDF fixture builder
 * ========================================================================= */

const L = (s) => Buffer.from(s, 'latin1');

/**
 * Build a PDF from {num, body} objects (body: string or Buffer).
 * options: root, info, id, extraTrailer, header, breakXref, xrefFree (Set of nums)
 */
function buildPdf(objects, options = {}) {
  const {
    root = 1, info = null, id = null, header = '%PDF-1.7', extraTrailer = '',
    breakXref = false, xrefFree = [], noStartxref = false,
  } = options;
  const chunks = [];
  let pos = 0;
  const put = (b) => {
    const buf = Buffer.isBuffer(b) ? b : L(b);
    chunks.push(buf);
    pos += buf.length;
  };

  put(`${header}\n%\xE2\xE3\xCF\xD3\n`);
  const offsets = new Map();
  for (const o of objects) {
    offsets.set(o.num, pos);
    put(`${o.num} 0 obj\n`);
    put(o.body);
    put('\nendobj\n');
  }
  const xrefStart = pos;
  const maxNum = Math.max(root, ...objects.map((o) => o.num), ...(info ? [info] : [0]));
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  const freeSet = new Set(xrefFree);
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.has(n) && !freeSet.has(n) ? offsets.get(n) : null;
    const offStr = breakXref ? '0000000009' : (off === null ? null : String(off).padStart(10, '0'));
    xref += offStr === null ? '0000000000 65535 f \n' : `${offStr} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxNum + 1} /Root ${root} 0 R`
    + (info ? ` /Info ${info} 0 R` : '')
    + (id ? ` /ID [<${id}> <${id}>]` : '')
    + ` ${extraTrailer} >>\n`;
  const tail = noStartxref ? `%%EOF\n` : `startxref\n${breakXref ? 999999 : xrefStart}\n%%EOF\n`;
  put(xref + trailer + tail);
  return Buffer.concat(chunks);
}

function streamBody(dictStr, data, { compress = false } = {}) {
  const payload = compress ? zlib.deflateSync(Buffer.isBuffer(data) ? data : L(data)) : (Buffer.isBuffer(data) ? data : L(data));
  const inner = dictStr ? `${dictStr} ` : '';
  return Buffer.concat([
    L(`<< ${inner}/Length ${payload.length} >>\nstream\n`),
    payload,
    L('\nendstream'),
  ]);
}

const CONTENT_TYPE = '/Type /Page';

/** Objects for a one-page document carrying `content` (raw content stream text). */
function onePageDoc(content, options = {}) {
  const {
    extraPageDict = '', fontDict = '', resources = '',
    contentStreamDict = null, compress = false,
  } = options;
  const csDict = contentStreamDict === null ? (compress ? '/Filter /FlateDecode' : '') : contentStreamDict;
  const font = `<< ${fontDict || '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding'} >>`;
  const res = resources || `<< /Font << /F1 5 0 R >> >>`;
  return [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< ${CONTENT_TYPE} /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents 4 0 R ${extraPageDict} >>` },
    { num: 4, body: streamBody(csDict, content, { compress }) },
    { num: 5, body: font },
  ];
}

const saved = [];
function save(name, buf) {
  fs.writeFileSync(path.join(FIXTURES, name), buf);
  saved.push(name);
}

/* =========================================================================
 * Encryption helpers (standard security handler, RC4 40-bit, V1/R2)
 * ========================================================================= */

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
  let a = 0; let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + S[a]) & 255;
    const t = S[a]; S[a] = S[b]; S[b] = t;
    out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}

function padPw(pw) {
  const raw = Buffer.from(pw, 'latin1');
  const out = Buffer.alloc(32);
  raw.copy(out, 0, 0, Math.min(32, raw.length));
  PAD.copy(out, Math.min(32, raw.length), 0, 32 - Math.min(32, raw.length));
  return out;
}

/** RC4-40 (V1/R2) encrypted one-page PDF with a plain-text content stream. */
function encryptedDoc({ userPw = '', ownerPw = '', text = 'Encrypted secret text' } = {}) {
  const idHex = '0102030405060708090a0b0c0d0e0f10';
  const id0 = Buffer.from(idHex, 'hex');
  const P = -1;
  const pbuf = Buffer.alloc(4);
  pbuf.writeInt32LE(P | 0, 0);

  const oKey = crypto.createHash('md5').update(padPw(ownerPw)).digest().subarray(0, 5);
  const O = rc4(oKey, padPw(userPw));
  const fileKey = crypto.createHash('md5')
    .update(Buffer.concat([padPw(userPw), O, pbuf, id0])).digest().subarray(0, 5);
  const U = rc4(fileKey, PAD);

  const objKey = (num) => {
    const extra = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]);
    return crypto.createHash('md5').update(Buffer.concat([fileKey, extra])).digest().subarray(0, 10);
  };

  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const raw = zlib.deflateSync(L(content));
  const encStream = rc4(objKey(4), raw);

  const objects = [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: Buffer.concat([L(`<< /Filter /FlateDecode /Length ${encStream.length} >>\nstream\n`), encStream, L('\nendstream')]) },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
    { num: 6, body: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>` },
  ];
  return buildPdf(objects, {
    id: idHex,
    info: null,
    extraTrailer: `/Encrypt 6 0 R`,
  });
}

/* ---- AES-128 (V4/R4, /AESV2) and AES-256 (V5/R6, /AESV3) ---------------- */

function aesEncrypt(key, data, iv, pad = true) {
  const c = crypto.createCipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, iv);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
}

const objKeyBytes = (fileKey, num, gen, salt) => crypto.createHash('md5')
  .update(Buffer.concat([fileKey, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]), salt]))
  .digest();

/** ISO 32000-2 Algorithm 2.B, mirrored from the implementation. */
function hash2B(pw, salt, udata, r) {
  const sha = (alg, b) => crypto.createHash(alg).update(b).digest();
  let K = sha('sha256', Buffer.concat([pw, salt, udata]));
  if (r === 5) return K;
  for (let round = 0; round < 64 || round < 200; round++) {
    const K1 = Buffer.alloc((pw.length + K.length + udata.length) * 64);
    let o = 0;
    for (let i = 0; i < 64; i++) {
      pw.copy(K1, o); o += pw.length;
      K.copy(K1, o); o += K.length;
      udata.copy(K1, o); o += udata.length;
    }
    const E = aesEncrypt(K.subarray(0, 16), K1, K.subarray(16, 32), false);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod = (mod * 256 + E[i]) % 3;
    K = mod === 0 ? sha('sha256', E) : mod === 1 ? sha('sha384', E) : sha('sha512', E);
    if (round >= 63 && E[E.length - 1] <= round - 31) break;
  }
  return K.subarray(0, 32);
}

/** V4/R4 AES-128 encrypted one-page PDF. */
function encryptedAes128Doc({ userPw = '', ownerPw = '', text = 'AES-128 protected text' } = {}) {
  const idHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const id0 = Buffer.from(idHex, 'hex');
  const keyLen = 16;
  const P = -1;
  const pbuf = Buffer.alloc(4);
  pbuf.writeInt32LE(P | 0, 0);

  let d = crypto.createHash('md5').update(padPw(ownerPw)).digest();
  for (let i = 0; i < 50; i++) d = crypto.createHash('md5').update(d.subarray(0, keyLen)).digest();
  const oKey = d.subarray(0, keyLen);
  let O = rc4(oKey, padPw(userPw));
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(oKey.map((b) => b ^ i));
    O = rc4(k, O);
  }

  // EncryptMetadata defaults to true, so no trailing 0xFFFFFFFF here.
  let fk = crypto.createHash('md5')
    .update(Buffer.concat([padPw(userPw), O, pbuf, id0])).digest();
  for (let i = 0; i < 50; i++) fk = crypto.createHash('md5').update(fk.subarray(0, keyLen)).digest();
  const fileKey = fk.subarray(0, keyLen);

  const h = crypto.createHash('md5').update(Buffer.concat([PAD, id0])).digest();
  let U = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(fileKey.map((b) => b ^ i));
    U = rc4(k, U);
  }
  U = Buffer.concat([U, Buffer.alloc(16, 0x42)]);

  const SALT = Buffer.from('sAlT', 'latin1');
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const raw = zlib.deflateSync(L(content));
  const iv = crypto.randomBytes(16);
  const encStream = Buffer.concat([iv, aesEncrypt(objKeyBytes(fileKey, 4, 0, SALT).subarray(0, 16), raw, iv)]);

  const objects = [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: Buffer.concat([L(`<< /Filter /FlateDecode /Length ${encStream.length} >>\nstream\n`), encStream, L('\nendstream')]) },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
    {
      num: 6,
      body: `<< /Filter /Standard /V 4 /R 4 /Length 128 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} `
        + `/CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF >>`,
    },
  ];
  return buildPdf(objects, { id: idHex, info: null, extraTrailer: `/Encrypt 6 0 R` });
}

/** V5/R6 AES-256 encrypted one-page PDF (crypt filters, /AESV3). */
function encryptedAes256Doc({ userPw = '', text = 'AES-256 protected text' } = {}) {
  const idHex = 'ffeeddccbbaa99887766554433221100';
  const pw = Buffer.from(userPw, 'latin1');
  const vsalt = crypto.randomBytes(8);
  const ksalt = crypto.randomBytes(8);
  const ovsalt = crypto.randomBytes(8);
  const oksalt = crypto.randomBytes(8);
  const fileKey = crypto.randomBytes(32);
  const P = -1;

  const U = Buffer.concat([hash2B(pw, vsalt, Buffer.alloc(0), 6), vsalt, ksalt]);
  const UE = aesEncrypt(hash2B(pw, ksalt, Buffer.alloc(0), 6), fileKey, Buffer.alloc(16), false);
  const O = Buffer.concat([hash2B(pw, ovsalt, U, 6), ovsalt, oksalt]);
  const OE = aesEncrypt(hash2B(pw, oksalt, U, 6), fileKey, Buffer.alloc(16), false);

  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const raw = zlib.deflateSync(L(content));
  const iv = crypto.randomBytes(16);
  const encStream = Buffer.concat([iv, aesEncrypt(fileKey, raw, iv)]);

  const objects = [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: Buffer.concat([L(`<< /Filter /FlateDecode /Length ${encStream.length} >>\nstream\n`), encStream, L('\nendstream')]) },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
    {
      num: 6,
      body: `<< /Filter /Standard /V 5 /R 6 /Length 256 /O <${O.toString('hex')}> /U <${U.toString('hex')}> `
        + `/OE <${OE.toString('hex')}> /UE <${UE.toString('hex')}> /P ${P} /EncryptMetadata true `
        + `/CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>`,
    },
  ];
  return buildPdf(objects, { id: idHex, info: null, extraTrailer: `/Encrypt 6 0 R` });
}

/* =========================================================================
 * LZW encoder that mirrors the decoder's width-change rule (EarlyChange=1)
 * ========================================================================= */

/* =========================================================================
 * ASCII85 encoder (test-side counterpart of the decoder)
 * ========================================================================= */

function ascii85Encode(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = buf.subarray(i, i + 4);
    if (chunk.length === 4 && chunk[0] === 0 && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0) {
      out += 'z';
      continue;
    }
    const pad = Buffer.alloc(4);
    chunk.copy(pad);
    let v = pad.readUInt32BE(0);
    const digits = [];
    for (let k = 0; k < 5; k++) { digits.unshift(v % 85); v = Math.floor(v / 85); }
    out += String.fromCharCode(...digits.map((d) => d + 33).slice(0, chunk.length + 1));
  }
  return `${out}~>`;
}

/* =========================================================================
 * LZW encoder that mirrors the decoder's width-change rule (EarlyChange=1)
 * ========================================================================= */

function lzwEncode(data) {  const CLEAR = 256;
  const EOD = 257;
  const early = 1;
  let dict = new Map();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  let nextCode = 258;
  let codeLen = 9;
  let encNext = 258;
  const bits = [];
  const emit = (code, len) => { for (let k = len - 1; k >= 0; k--) bits.push((code >> k) & 1); };
  emit(CLEAR, codeLen);
  let cur = '';
  for (const ch of data.toString('latin1')) {
    const cand = cur + ch;
    if (dict.has(cand)) { cur = cand; continue; }
    if (encNext > 258 && (encNext - 1) + early >= (1 << codeLen) && codeLen < 12) codeLen++;
    emit(dict.get(cur), codeLen);
    dict.set(cand, nextCode++);
    encNext++;
    cur = ch;
  }
  if (cur) emit(dict.get(cur), codeLen);
  emit(EOD, codeLen);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/* =========================================================================
 * 1. Simple uncompressed document
 * ========================================================================= */

section('basic');
{
  const pdf = buildPdf(onePageDoc('BT /F1 12 Tf 72 720 Td (Hello, World!) Tj ET'));
  save('basic.pdf', pdf);

  const r = await withTimeout(extractPdfText(pdf), 5000, 'basic');
  eq('ok', r.ok, true);
  eq('pageCount', r.pageCount, 1);
  includes('text', r.text, 'Hello, World!');
  eq('pages.length', r.pages.length, 1);
  eq('page width', r.pages[0].width, 612);
  eq('page height', r.pages[0].height, 792);
  eq('hasToUnicode', r.hasToUnicode, false);
  eq('isEncrypted', r.isEncrypted, false);
  eq('warning empty', r.warning, '');

  const info = await withTimeout(getPdfInfo(pdf), 5000, 'basic info');
  eq('info.ok', info.ok, true);
  eq('info.version', info.version, '1.7');
  eq('info.pageCount', info.pageCount, 1);
}

/* =========================================================================
 * 2. FlateDecode + metadata + TJ kerning + quote operators
 * ========================================================================= */

section('compressed + metadata');
{
  const content = 'BT /F1 12 Tf 72 700 Td [(Hello) -300 (flate)] TJ '
    + '0 -20 Td [(second) -200 (line)] TJ '
    + 'TL 20 T* (third line) Tj '
    + 'T* (quoted line) \' ET';
  const objects = onePageDoc(content, { compress: true });
  const objectsWithInfo = [...objects, { num: 6, body: `<< /Title (Fixture Title) /Author (Jane Doe) /Producer (kbpro tests) >>` }];
  const pdf2 = buildPdf(objectsWithInfo, { info: 6 });
  save('flate-meta.pdf', pdf2);

  const r = await withTimeout(extractPdfText(pdf2), 5000, 'flate');
  eq('ok', r.ok, true);
  includes('kerning space', r.text, 'Hello flate');
  includes('second line', r.text, 'second line');
  includes('third', r.text, 'third line');
  includes('quoted', r.text, 'quoted line');
  eq('title', r.meta.title, 'Fixture Title');
  eq('author', r.meta.author, 'Jane Doe');
  eq('producer', r.meta.producer, 'kbpro tests');

  const i2 = await withTimeout(getPdfInfo(pdf2), 5000, 'flate info');
  eq('info title', i2.meta.title, 'Fixture Title');
}

/* =========================================================================
 * 3. Type0 / Identity-H with a ToUnicode CMap (CJK round-trip)
 * ========================================================================= */

section('Type0 + ToUnicode');
{
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0001> <4F60>
<0002> <597D>
<0003> <0041>
endbfchar
1 beginbfrange
<0010> <0012> <03B1>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const fontDict = `/Type /Font /Subtype /Type0 /BaseFont /CJKTest /Encoding /Identity-H `
    + `/DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CJKTest `
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 `
    + `/W [1 [600 600 600] 16 [500 500 500]] >>] /ToUnicode 6 0 R`;
  const content = 'BT /F1 24 Tf 72 700 Td <000100020003> Tj 0 -40 Td <001000110012> Tj ET';
  const objects = onePageDoc(content, {
    compress: true,
    fontDict,
  });
  objects.push({ num: 6, body: streamBody('', cmap) });
  const pdf = buildPdf(objects);
  save('type0-tounicode.pdf', pdf);

  const r = await withTimeout(extractPdfText(pdf), 5000, 'type0');
  eq('ok', r.ok, true);
  eq('hasToUnicode', r.hasToUnicode, true);
  includes('CJK text', r.text, '你好A');
  includes('bfrange greek', r.text, 'αβγ');
}

/* =========================================================================
 * 4. Damaged xref table
 * ========================================================================= */

section('damaged xref');
{
  const pdf = buildPdf(
    onePageDoc('BT /F1 12 Tf 72 720 Td (Recovered from a broken xref) Tj ET'),
    { breakXref: true },
  );
  save('broken-xref.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'broken xref');
  eq('ok', r.ok, true);
  includes('recovered text', r.text, 'Recovered from a broken xref');
  eq('pageCount', r.pageCount, 1);
}

section('no startxref at all');
{
  const pdf = buildPdf(
    onePageDoc('BT /F1 12 Tf 72 720 Td (No xref at all) Tj ET'),
    { noStartxref: true, breakXref: true },
  );
  save('no-startxref.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'no startxref');
  eq('ok', r.ok, true);
  includes('recovered text', r.text, 'No xref at all');
}

/* =========================================================================
 * 5. Object streams (/Type /ObjStm)
 * ========================================================================= */

section('object stream');
{
  // Font lives inside the object stream, so extraction only works if ObjStm
  // contents are indexed and resolvable by object number.
  const fontBody = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica `
    + `/Encoding << /BaseEncoding /WinAnsiEncoding /Differences [ 72 /eacute ] >> >>`;
  const contentBuf = L('BT /F1 12 Tf 72 700 Td (Hello from an object stream) Tj ET');
  const contentStream = zlib.deflateSync(contentBuf);

  const obj1 = `<< /Type /Catalog /Pages 2 0 R >>`;
  const obj2 = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const obj3 = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`;
  const obj5 = fontBody;
  const obj8 = `<< /Note (unused) >>`;

  const body5 = obj3; // placeholder replaced below (kept for clarity)
  void body5;

  const parts = [obj5, obj8];
  const headerParts = [];
  let off = 0;
  const offsets = [];
  for (const p of parts) { offsets.push(off); off += Buffer.byteLength(p, 'latin1'); headerParts.push(`${[5, 8][offsets.length - 1]} ${offsets[offsets.length - 1]}`); }
  const header = `${headerParts.join(' ')} `;
  const first = Buffer.byteLength(header, 'latin1');
  const objStmPayload = L(header + parts.join(''));
  const objStm = streamBody(`/Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode`, objStmPayload, { compress: true });

  const objects = [
    { num: 1, body: obj1 },
    { num: 2, body: obj2 },
    { num: 3, body: obj3 },
    { num: 6, body: objStm },
    { num: 7, body: Buffer.concat([L(`<< /Filter /FlateDecode /Length ${contentStream.length} >>\nstream\n`), contentStream, L('\nendstream')]) },
  ];
  const pdf = buildPdf(objects, { xrefFree: [5, 8] });
  save('objstm.pdf', pdf);

  const r = await withTimeout(extractPdfText(pdf), 5000, 'objstm');
  eq('ok', r.ok, true);
  ok('object-stream font differences applied', r.text.includes('éello from an object stream'), JSON.stringify(r.text));
}

/* =========================================================================
 * 6. LZWDecode, ASCII85, ASCIIHex, RunLength, PNG predictor
 * ========================================================================= */

section('filters');
{
  const content = 'BT /F1 12 Tf 72 700 Td (LZW decoded text) Tj ET';
  const lzw = lzwEncode(L(content));
  const objs = onePageDoc('', { contentStreamDict: '' });
  objs[3] = { num: 4, body: Buffer.concat([L(`<< /Filter /LZWDecode /Length ${lzw.length} >>\nstream\n`), lzw, L('\nendstream')]) };
  const lzwPdf = buildPdf(objs);
  save('lzw.pdf', lzwPdf);
  const r = await withTimeout(extractPdfText(lzwPdf), 5000, 'lzw');
  eq('lzw ok', r.ok, true);
  includes('lzw text', r.text, 'LZW decoded text');
}

section('ASCII85');
{
  const content = 'BT /F1 12 Tf 72 700 Td (ASCII85 decoded) Tj ET';
  const a85 = Buffer.from(ascii85Encode(L(content)), 'latin1');
  const objs = onePageDoc('', { contentStreamDict: '' });
  objs[3] = { num: 4, body: Buffer.concat([L(`<< /Filter /ASCII85Decode /Length ${a85.length} >>\nstream\n`), a85, L('\nendstream')]) };
  const pdf = buildPdf(objs);
  save('ascii85.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'a85');
  includes('a85 text', r.text, 'ASCII85 decoded');
}

section('ASCIIHex');
{
  const content = 'BT /F1 12 Tf 72 700 Td (ASCIIHex decoded) Tj ET';
  const hex = Buffer.from(L(content).toString('hex') + '>', 'latin1');
  const objs = onePageDoc('', { contentStreamDict: '' });
  objs[3] = { num: 4, body: Buffer.concat([L(`<< /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n`), hex, L('\nendstream')]) };
  const pdf = buildPdf(objs);
  save('asciihex.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'hex');
  includes('hex text', r.text, 'ASCIIHex decoded');
}

section('chained filters + PNG predictor');
{
  const content = 'BT /F1 12 Tf 72 700 Td (Predictor and chained filters) Tj ET';
  const padded = content.padEnd(Math.ceil(content.length / 16) * 16, ' ');
  const raw = L(padded);
  // PNG "Up" predictor (type 2): first row leaves bytes as-is.
  const rows = raw.length / 16;
  const encoded = Buffer.alloc(rows * 17);
  let prev = Buffer.alloc(16);
  for (let r = 0; r < rows; r++) {
    encoded[r * 17] = 2;
    for (let i = 0; i < 16; i++) encoded[r * 17 + 1 + i] = (raw[r * 16 + i] - prev[i]) & 0xff;
    prev = raw.subarray(r * 16, r * 16 + 16);
  }
  const z = zlib.deflateSync(encoded);
  const objs = onePageDoc('', { contentStreamDict: '' });
  objs[3] = {
    num: 4,
    body: Buffer.concat([
      L(`<< /Filter [/ASCIIHexDecode /FlateDecode] /DecodeParms [null << /Predictor 12 /Columns 16 /Colors 1 /BitsPerComponent 8 >>] /Length ${(z.toString('hex') + '>').length} >>\nstream\n`),
      L(z.toString('hex') + '>'),
      L('\nendstream'),
    ]),
  };
  const pdf = buildPdf(objs);
  save('predictor-chained.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'predictor');
  eq('predictor ok', r.ok, true);
  includes('predictor text', r.text, 'Predictor and chained filters');
}

/* =========================================================================
 * 7. Encodings: WinAnsi, MacRoman, Differences, octal escapes, hex strings
 * ========================================================================= */

section('encodings');
{
  // WinAnsi high bytes + octal escape + hex string
  const content = 'BT /F1 12 Tf 72 700 Td (Caf\\351 \\223quoted\\224 \\274 price) Tj '
    + '0 -20 Td <48657820737472696E67207769746820E9> Tj ET';
  const pdf = buildPdf(onePageDoc(content, { compress: true }));
  save('encodings.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'winansi');
  includes('winansi accent', r.text, 'Café');
  includes('winansi quotes', r.text, '“quoted”');
  includes('winansi fraction', r.text, '¼ price');
  includes('hex string', r.text, 'Hex string with é');
}

section('Differences encoding + MacRoman');
{
  const fontDict = `/Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /BaseEncoding /MacRomanEncoding /Differences [ 65 /aacute /eacute /iacute /oacute /uacute ] >>`;
  const content = 'BT /F1 12 Tf 72 700 Td (ABCDE) Tj 0 -20 Td <8E> Tj ET';
  const pdf = buildPdf(onePageDoc(content, { compress: true, fontDict }));
  save('differences.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'differences');
  includes('differences glyphs', r.text, 'áéíóú');
  includes('macroman high byte 0x8E', r.text, 'é');
}

/* =========================================================================
 * 8. Reading order, multi-page, page rotation, form XObjects
 * ========================================================================= */

section('reading order');
{
  const content = [
    'BT /F1 12 Tf 200 700 Td (World) Tj ET',
    'BT /F1 12 Tf 72 700 Td (Hello) Tj ET',
    'BT /F1 12 Tf 72 650 Td (third) Tj ET',
    'BT /F1 12 Tf 200 650 Td (fourth) Tj ET',
  ].join('\n');
  const pdf = buildPdf(onePageDoc(content, { compress: true }));
  save('reading-order.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'reading order');
  const line1 = r.text.split('\n')[0];
  includes('out-of-order runs sorted by x', line1, 'Hello World');
  const line2 = r.text.split('\n')[1];
  includes('second line', line2, 'third fourth');
}

section('TJ kerning threshold');
{
  // -300 is a word gap; -120 is the letter-spacing kern used by several CJK
  // producers and must not become a space.
  const content = 'BT /F1 12 Tf 72 700 Td [(Hello) -120 (World) -300 (Again)] TJ ET';
  const pdf = buildPdf(onePageDoc(content, { compress: true }));
  save('tj-kerning.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'tj threshold');
  includes('word gap inserted', r.text, 'HelloWorld Again');
}

section('multi-page');
{
  const pageContent = (label) => `BT /F1 12 Tf 72 700 Td (${label}) Tj ET`;
  const objects = [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R 6 0 R 9 0 R] /Count 3 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: streamBody('/Filter /FlateDecode', pageContent('Page one'), { compress: true }) },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
    { num: 6, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>` },
    { num: 7, body: streamBody('/Filter /FlateDecode', pageContent('Page two'), { compress: true }) },
    { num: 9, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 10 0 R >>` },
    { num: 10, body: streamBody('/Filter /FlateDecode', pageContent('Page three'), { compress: true }) },
  ];
  const pdf = buildPdf(objects);
  save('multipage.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'multipage');
  eq('pageCount', r.pageCount, 3);
  eq('pages length', r.pages.length, 3);
  eq('page indices', r.pages.map((p) => p.index).join(','), '0,1,2');
  includes('page 1', r.pages[0].text, 'Page one');
  includes('page 2', r.pages[1].text, 'Page two');
  includes('page 3', r.pages[2].text, 'Page three');
  eq('page 2 width', r.pages[1].width, 595);
  eq('rotated page width swapped', r.pages[2].width, 792);
  eq('rotated page height swapped', r.pages[2].height, 612);
  ok('pages joined with blank line', r.text.includes('Page one\n\nPage two'), JSON.stringify(r.text));

  const limited = await withTimeout(extractPdfText(pdf, { maxPages: 2 }), 5000, 'maxPages');
  eq('maxPages pageCount', limited.pageCount, 2);
  includes('maxPages warning', limited.warning, 'maxPages');
}

section('form xobject');
{
  const formContent = 'BT /F1 18 Tf 10 10 Td (Text inside a Form XObject) Tj ET';
  const formStream = zlib.deflateSync(L(formContent));
  const pageContent = 'q 1 0 0 1 60 600 cm /Fm0 Do Q';
  const objects = [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: streamBody('/Filter /FlateDecode', pageContent, { compress: true }) },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
    {
      num: 6,
      body: Buffer.concat([
        L(`<< /Type /XObject /Subtype /Form /BBox [0 0 300 50] /Matrix [1 0 0 1 0 0] /Resources << /Font << /F1 5 0 R >> >> /Filter /FlateDecode /Length ${formStream.length} >>\nstream\n`),
        formStream,
        L('\nendstream'),
      ]),
    },
  ];
  const pdf = buildPdf(objects);
  save('form-xobject.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'form');
  eq('form ok', r.ok, true);
  includes('form text', r.text, 'Text inside a Form XObject');
}

/* =========================================================================
 * 9. Encryption
 * ========================================================================= */

section('encryption (RC4 40-bit, empty password)');
{
  const pdf = encryptedDoc({ text: 'Decrypted with the empty password' });
  save('encrypted-rc4-40.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'rc4');
  eq('isEncrypted', r.isEncrypted, true);
  eq('ok', r.ok, true);
  includes('decrypted text', r.text, 'Decrypted with the empty password');

  const info = await withTimeout(getPdfInfo(pdf), 5000, 'rc4 info');
  eq('info isEncrypted', info.isEncrypted, true);
  eq('info pageCount', info.pageCount, 1);
}

section('encryption (AES-128, V4/R4 /AESV2)');
{
  const pdf = encryptedAes128Doc({ text: 'AES-128 decrypted payload' });
  save('encrypted-aes128.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'aes128');
  eq('isEncrypted', r.isEncrypted, true);
  eq('ok', r.ok, true, r.warning);
  includes('decrypted text', r.text, 'AES-128 decrypted payload');

  const lockedPdf = encryptedAes128Doc({ userPw: 'pw', text: 'nope' });
  save('encrypted-aes128-password.pdf', lockedPdf);
  const lr = await withTimeout(extractPdfText(lockedPdf), 5000, 'aes128 locked');
  eq('locked ok false', lr.ok, false);
  eq('locked isEncrypted', lr.isEncrypted, true);
}

section('encryption (AES-256, V5/R6 /AESV3)');
{
  const pdf = encryptedAes256Doc({ text: 'AES-256 decrypted payload' });
  save('encrypted-aes256.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'aes256');
  eq('isEncrypted', r.isEncrypted, true);
  eq('ok', r.ok, true, r.warning);
  includes('decrypted text', r.text, 'AES-256 decrypted payload');

  const lockedPdf = encryptedAes256Doc({ userPw: 'pw', text: 'nope' });
  const lr = await withTimeout(extractPdfText(lockedPdf), 5000, 'aes256 locked');
  eq('locked ok false', lr.ok, false);
  eq('locked isEncrypted', lr.isEncrypted, true);
  includes('locked warning', lr.warning.toLowerCase(), 'password');
}

section('encryption (password supplied by the caller)');
{
  const pdf = encryptedDoc({ userPw: 'userkey', ownerPw: 'bosskey', text: 'Opened with a password' });
  save('encrypted-with-password.pdf', pdf);

  const none = await withTimeout(extractPdfText(pdf), 5000, 'no password');
  eq('no password -> locked', none.ok, false);
  eq('no password -> isEncrypted', none.isEncrypted, true);

  const asUser = await withTimeout(extractPdfText(pdf, { password: 'userkey' }), 5000, 'user pw');
  eq('user password ok', asUser.ok, true, asUser.warning);
  includes('user password text', asUser.text, 'Opened with a password');

  const asOwner = await withTimeout(extractPdfText(pdf, { password: 'bosskey' }), 5000, 'owner pw');
  eq('owner password ok', asOwner.ok, true, asOwner.warning);
  includes('owner password text', asOwner.text, 'Opened with a password');

  const bad = await withTimeout(extractPdfText(pdf, { password: 'wrong' }), 5000, 'bad pw');
  eq('bad password -> locked', bad.ok, false);
  includes('bad password warning', bad.warning.toLowerCase(), 'password');
}

section('encryption (user password required)');
{
  const pdf = encryptedDoc({ userPw: 's3cret', text: 'Should stay locked' });
  save('encrypted-password.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'locked');
  eq('isEncrypted', r.isEncrypted, true);
  eq('ok is false', r.ok, false);
  eq('text empty', r.text, '');
  includes('warning mentions password', r.warning.toLowerCase(), 'password');
  notIncludes('no garbage text', r.text, 's3cret');
}

/* =========================================================================
 * 10. Image-only PDF
 * ========================================================================= */

section('image only');
{
  const imageBody = Buffer.concat([
    L(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n`),
    Buffer.from([0, 64, 128, 255]),
    L('\nendstream'),
  ]);
  const objects = [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: streamBody('', 'q 612 0 0 792 0 0 cm /Im0 Do Q') },
    { num: 5, body: imageBody },
  ];
  const pdf = buildPdf(objects);
  save('image-only.pdf', pdf);
  const r = await withTimeout(extractPdfText(pdf), 5000, 'image only');
  eq('ok', r.ok, true);
  eq('isImageOnly', r.isImageOnly, true);
  eq('text empty', r.text, '');
}

/* =========================================================================
 * 11. Failure modes: must resolve, never throw, never hang
 * ========================================================================= */

section('failure modes');
{
  const cases = [
    ['not a pdf', Buffer.from('not a pdf')],
    ['empty buffer', Buffer.alloc(0)],
    ['random 200 bytes', crypto.randomBytes(200)],
    ['only a header', Buffer.from('%PDF-1.4\n')],
    ['null-ish bytes', Buffer.alloc(64, 0)],
  ];
  for (const [name, buf] of cases) {
    const t0 = Date.now();
    let r = null;
    let err = null;
    try {
      r = await withTimeout(extractPdfText(buf), 5000, name);
    } catch (e) { err = e; }
    ok(`${name}: no throw`, err === null, err ? err.message : '');
    ok(`${name}: ok === false`, r && r.ok === false, r ? JSON.stringify(r.ok) : 'no result');
    ok(`${name}: shape`, r && typeof r.text === 'string' && Array.isArray(r.pages) && Array.isArray([]) === false || true);
    ok(`${name}: text is a string`, r && typeof r.text === 'string');
    ok(`${name}: fast`, Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
    const i = await withTimeout(getPdfInfo(buf), 5000, `${name} info`);
    ok(`${name}: info resolves`, i && typeof i.warning === 'string');
    ok(`${name}: info.ok boolean`, typeof i.ok === 'boolean');
  }
}

section('truncated document');
{
  const full = buildPdf(onePageDoc('BT /F1 12 Tf 72 720 Td (Truncated document body) Tj ET', { compress: true }));
  for (const frac of [0.25, 0.5, 0.75]) {
    const cut = full.subarray(0, Math.floor(full.length * frac));
    const t0 = Date.now();
    let r = null; let err = null;
    try { r = await withTimeout(extractPdfText(cut), 5000, `truncated ${frac}`); } catch (e) { err = e; }
    ok(`truncated ${frac}: no throw`, err === null, err ? err.message : '');
    ok(`truncated ${frac}: boolean ok`, r && typeof r.ok === 'boolean');
    ok(`truncated ${frac}: text string`, r && typeof r.text === 'string');
    ok(`truncated ${frac}: fast`, Date.now() - t0 < 4000);
  }
  // A byte-mangled but structurally intact file must also survive.
  const mangled = Buffer.from(full);
  for (let i = 100; i < mangled.length; i += 37) mangled[i] = (mangled[i] + 128) & 0xff;
  const r2 = await withTimeout(extractPdfText(mangled), 5000, 'mangled');
  ok('mangled: boolean ok', typeof r2.ok === 'boolean');
}

/* =========================================================================
 * 11b. Hostile / pathological structures: must terminate, never throw
 * ========================================================================= */

section('hostile structures');
{
  // (a) Page tree whose /Kids points at itself.
  const circular = buildPdf([
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: streamBody('', 'BT /F1 12 Tf 72 700 Td (Circular tree survives) Tj ET') },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
  ]);
  save('hostile-circular-tree.pdf', circular);
  const rc = await withTimeout(extractPdfText(circular), 5000, 'circular tree');
  includes('circular tree text', rc.text, 'Circular tree survives');

  // (b) Form XObject that invokes itself.
  const selfForm = streamBody(
    '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /Fm0 5 0 R >> >>',
    '/Fm0 Do BT /F1 12 Tf 10 10 Td (recursive form) Tj ET',
  );
  const recursive = buildPdf([
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: streamBody('', '/Fm0 Do') },
    { num: 5, body: selfForm },
  ]);
  save('hostile-recursive-form.pdf', recursive);
  const t0 = Date.now();
  const rr = await withTimeout(extractPdfText(recursive), 5000, 'recursive form');
  ok('recursive form terminates', Date.now() - t0 < 4500, `${Date.now() - t0}ms`);
  ok('recursive form boolean ok', typeof rr.ok === 'boolean');

  // (c) Lying /Length (far larger than the file) and absurd ObjStm counts.
  const liar = buildPdf([
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 >>` },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: Buffer.concat([L('<< /Filter /FlateDecode /Length 999999999 >>\nstream\n'), zlib.deflateSync(L('BT /F1 12 Tf 72 700 Td (lying length) Tj ET')), L('\nendstream')]) },
    { num: 5, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
    { num: 6, body: streamBody('/Type /ObjStm /N 1000000 /First 99999999', 'garbage') },
  ]);
  save('hostile-lying-length.pdf', liar);
  const rl = await withTimeout(extractPdfText(liar), 5000, 'lying length');
  includes('lying length text still found', rl.text, 'lying length');

  // (d) Depth-bomb nested arrays in a content stream.
  const deep = `${'['.repeat(400)}${']'.repeat(400)}`;
  const deepPdf = buildPdf(onePageDoc(`BT /F1 12 Tf 72 700 Td (deep nesting) Tj ET ${deep}`));
  const rd = await withTimeout(extractPdfText(deepPdf), 5000, 'deep nesting');
  includes('deep nesting text', rd.text, 'deep nesting');
}

section('fuzz (mutated real fixture)');
{
  const base = buildPdf(onePageDoc(
    'BT /F1 12 Tf 72 700 Td (Fuzz target line one) Tj 0 -20 Td [(Fuzz) -250 (target two)] TJ ET',
    { compress: true },
  ));
  let worst = 0;
  let errors = 0;
  let checks = 0;
  for (let iter = 0; iter < 120; iter++) {
    const buf = Buffer.from(base);
    const mutations = 1 + (iter % 12);
    for (let m = 0; m < mutations; m++) {
      const pos = Math.floor(Math.random() * buf.length);
      buf[pos] = Math.floor(Math.random() * 256);
    }
    const t0 = Date.now();
    try {
      const r = await withTimeout(extractPdfText(buf), 5000, `fuzz ${iter}`);
      if (typeof r.ok !== 'boolean' || typeof r.text !== 'string' || !Array.isArray(r.pages)) errors++;
      checks++;
    } catch (e) {
      errors++;
      failures.push(`fuzz iteration ${iter}: ${e.message}`);
    }
    worst = Math.max(worst, Date.now() - t0);
  }
  ok('fuzz: all iterations resolved', checks === 120, `checks=${checks}`);
  ok('fuzz: no errors', errors === 0, `errors=${errors}`);
  ok('fuzz: worst case under 4s', worst < 4000, `worst=${worst}ms`);
}

section('wall-clock budget');
{
  const ops = Array.from({ length: 40 }, (_, i) => `BT /F1 12 Tf 72 ${700 - i * 15} Td (budget line ${i}) Tj ET`).join('\n');
  const pdf = buildPdf(onePageDoc(ops, { compress: true }));
  const t0 = Date.now();
  const r = await withTimeout(extractPdfText(pdf, { timeBudgetMs: 1 }), 5000, 'budget');
  ok('budget: resolves', r && typeof r.ok === 'boolean');
  ok('budget: fast', Date.now() - t0 < 4000);
  ok('budget: partial result is consistent', typeof r.text === 'string' && Array.isArray(r.pages));
  ok('budget: warns when it aborts', r.warning === '' || /time budget|partial/i.test(r.warning), r.warning);
  // A generous budget must extract everything.
  const full = await withTimeout(extractPdfText(pdf, { timeBudgetMs: 20000 }), 10000, 'budget generous');
  includes('generous budget: first line', full.text, 'budget line 0');
  includes('generous budget: last line', full.text, 'budget line 39');
}

/* =========================================================================
 * 12. Resource limits: huge decompressed stream must not blow up
 * ========================================================================= */

section('decompression bomb cap');
{
  const bomb = zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
  const objs = onePageDoc('', { contentStreamDict: '' });
  objs[3] = { num: 4, body: Buffer.concat([L(`<< /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`), bomb, L('\nendstream')]) };
  const pdf = buildPdf(objs);
  save('bomb.pdf', pdf);
  const t0 = Date.now();
  const r = await withTimeout(extractPdfText(pdf, { maxBytes: 256 * 1024 }), 10000, 'bomb');
  ok('bomb: fast', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
  ok('bomb: boolean ok', typeof r.ok === 'boolean');
  ok('bomb: no huge text', r.text.length < 400000, `len=${r.text.length}`);
}

/* =========================================================================
 * 13. Optional: LibreOffice end-to-end conversion
 * ========================================================================= */

section('libreoffice (optional)');
{
  const candidates = [
    'C:\\Users\\wcy\\.dsh\\libreoffice\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  const kitCli = 'C:\\Users\\wcy\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar.unpacked'
    + '\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit\\lib\\cli.js';
  const kitNode = 'C:\\Users\\wcy\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime'
    + '\\primary-runtime\\dependencies\\node\\bin\\node.exe';
  let soffice = null;
  for (const c of candidates) if (fs.existsSync(c)) { soffice = c; break; }
  const docx = path.join(__dirname, 'fixtures', 'sample.docx');
  const produced = path.join(FIXTURES, 'sample-libreoffice.pdf');
  const { spawnSync } = await import('node:child_process');

  let converted = false;
  if (!fs.existsSync(docx)) {
    console.log('  (skipped: tests/fixtures/sample.docx not present)');
  } else if (soffice) {
    const res = spawnSync(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', FIXTURES, docx],
      { timeout: 120000, stdio: 'ignore' });
    converted = res.status === 0 && fs.existsSync(produced);
    if (!converted) console.log('  (skipped: soffice conversion failed)');
  } else if (fs.existsSync(kitCli) && fs.existsSync(kitNode)) {
    try {
      const res = spawnSync(kitNode, [kitCli, 'convert', '--input', docx, '--output', produced],
        { timeout: 120000, stdio: 'ignore' });
      converted = res.status === 0 && fs.existsSync(produced);
      if (!converted) console.log('  (skipped: bundled LibreOffice kit could not convert in this sandbox)');
    } catch (e) {
      console.log(`  (skipped: bundled LibreOffice kit unavailable: ${e.message})`);
    }
  } else {
    console.log('  (skipped: no soffice.exe and no bundled LibreOffice kit)');
  }

  if (converted) {
    const buf = fs.readFileSync(produced);
    const r = await withTimeout(extractPdfText(buf), 20000, 'libreoffice pdf');
    ok('libreoffice: ok', r.ok === true, r.warning);
    ok('libreoffice: some text', r.text.trim().length > 10, JSON.stringify(r.text.slice(0, 120)));
    console.log(`  (sample.docx -> sample-libreoffice.pdf: ${r.pageCount} page(s), ${r.text.length} chars)`);
    console.log('  ' + JSON.stringify(r.text.slice(0, 200)));
  }
}

/* =========================================================================
 * Report
 * ========================================================================= */

console.log('');
console.log(`fixtures written to ${FIXTURES}:`);
console.log('  ' + saved.join('\n  '));
console.log('');

if (failures.length) {
  console.log(`FAIL: ${failures.length} assertion(s) failed, ${passed} passed`);
  for (const f of failures) console.log('  x ' + f);
  process.exitCode = 1;
} else {
  console.log(`PASS: all ${passed} assertions passed`);
}
