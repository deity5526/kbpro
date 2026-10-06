/**
 * Tests for kbpro/server/lib/zip.js and kbpro/server/lib/officedoc.js.
 *
 * Run:  node kbpro/tests/test-officedoc.mjs
 * Fixtures are produced by kbpro/tests/make_fixtures.py (see --regen flag below);
 * this script runs the generator automatically when the fixtures are missing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32, readZipEntries, readZipEntriesDetailed, writeZip } from '../server/lib/zip.js';
import {
  docxToHtml,
  docxToText,
  pptxToHtml,
  pptxToText,
  xlsxToHtml,
  xlsxToText,
} from '../server/lib/officedoc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const PYTHON = 'C:\\Users\\wcy\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

/* ------------------------------------------------------------------ */
/* tiny test harness                                                  */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function includes(name, haystack, needle) {
  const text = String(haystack == null ? '' : haystack);
  check(name, text.includes(needle), `missing ${JSON.stringify(needle)}`);
}

function excludes(name, haystack, needle) {
  const text = String(haystack == null ? '' : haystack);
  check(name, !text.includes(needle), `unexpected ${JSON.stringify(needle)}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n== ${title}`);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Calls an async export and never throws: returns { threw, value, timedOut }. */
async function callSafely(fn, arg, label) {
  const started = Date.now();
  let result;
  try {
    result = await withTimeout(
      Promise.resolve()
        .then(() => fn(arg))
        .catch((err) => ({ __rejected: err })),
      10000,
      label,
    );
  } catch (err) {
    return { threw: err, value: null, timedOut: false, ms: Date.now() - started };
  }
  if (result && result.__timeout) return { threw: null, value: null, timedOut: true, ms: Date.now() - started };
  if (result && result.__rejected) return { threw: result.__rejected, value: null, timedOut: false, ms: Date.now() - started };
  return { threw: null, value: result, timedOut: false, ms: Date.now() - started };
}

function ensureFixtures() {
  const needed = ['sample.docx', 'sample.xlsx', 'sample.pptx'];
  const missing = needed.filter((name) => !existsSync(join(FIXTURES, name)));
  if (missing.length === 0) return;
  console.log(`fixtures missing (${missing.join(', ')}); running make_fixtures.py`);
  const result = spawnSync(PYTHON, [join(HERE, 'make_fixtures.py')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.log('WARNING: fixture generation failed; falling back to hand-built OOXML only');
  }
}

function fixture(name) {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

/* ------------------------------------------------------------------ */
/* 1. zip round trips                                                 */
/* ------------------------------------------------------------------ */

function testCrc32() {
  section('crc32');
  equal('crc32 empty', crc32(Buffer.alloc(0)), 0);
  equal('crc32 "123456789"', crc32(Buffer.from('123456789')), 0xcbf43926);
  equal('crc32 string input', crc32('123456789'), 0xcbf43926);
  equal('crc32 is unsigned', crc32(Buffer.from('the quick brown fox')) >>> 0, crc32(Buffer.from('the quick brown fox')));
}

function testZipRoundTrip() {
  section('zip writer/reader round trip');

  const cases = [
    ['empty', Buffer.alloc(0)],
    ['one-byte', Buffer.from([0x00])],
    ['text', Buffer.from('hello world, hello world, hello world')],
    ['random-4k', randomBytes(4096)],
    ['compressible-150k', Buffer.from('abcabcabc'.repeat(17000))],
    ['random-3mb', randomBytes(3 * 1024 * 1024)],
    ['compressible-3mb', Buffer.alloc(3 * 1024 * 1024, 0x41)],
  ];

  const entries = [
    { name: 'a.txt', data: 'first' },
    { name: 'nested/dir/b.bin', data: randomBytes(2048) },
    { name: 'unicode/日本語-ünïcode-Ω.txt', data: 'unicode!' },
    ...cases.map(([name, data]) => ({ name: `cases/${name}.bin`, data })),
  ];

  const zip = writeZip(entries);
  check('writeZip returns a Buffer', Buffer.isBuffer(zip), typeof zip);

  const read = readZipEntries(zip);
  equal('round trip entry count', read.size, entries.length);
  for (const entry of entries) {
    const expected = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const got = read.get(entry.name);
    check(`round trip has "${entry.name}"`, Buffer.isBuffer(got));
    if (Buffer.isBuffer(got)) {
      equal(`round trip size of "${entry.name}"`, got.length, expected.length);
      check(`round trip bytes of "${entry.name}"`, got.equals(expected));
    }
  }

  const detailed = readZipEntriesDetailed(zip);
  equal('detailed entry count', detailed.size, entries.length);
  const threeMb = detailed.get('cases/random-3mb.bin');
  check('detailed metadata for 3MB entry', Boolean(threeMb));
  if (threeMb) {
    equal('detailed size', threeMb.size, 3 * 1024 * 1024);
    equal('detailed crc32', threeMb.crc32, crc32(threeMb.data));
    check('detailed method is 0 or 8', threeMb.method === 0 || threeMb.method === 8, String(threeMb.method));
    check('detailed compressedSize <= size', threeMb.compressedSize <= threeMb.size);
    equal('detailed isDirectory', threeMb.isDirectory, false);
  }

  // A compressible 3MB payload must actually go through the deflate path.
  const bigCompressible = detailed.get('cases/compressible-3mb.bin');
  check('detailed metadata for compressible 3MB entry', Boolean(bigCompressible));
  if (bigCompressible) {
    equal('compressible 3MB size', bigCompressible.size, 3 * 1024 * 1024);
    check('3MB payload actually compressed', bigCompressible.compressedSize < 1024 * 1024, String(bigCompressible.compressedSize));
    equal('compressible 3MB method is deflate', bigCompressible.method, 8);
  }

  // Directory entry.
  const dirZip = writeZip([
    { name: 'folder/', data: Buffer.alloc(0) },
    { name: 'folder/inside.txt', data: 'inside' },
  ]);
  const dirRead = readZipEntriesDetailed(dirZip);
  const dirEntry = dirRead.get('folder/');
  check('directory entry present', Boolean(dirEntry));
  if (dirEntry) {
    equal('directory entry flagged', dirEntry.isDirectory, true);
    equal('directory entry size', dirEntry.size, 0);
  }
  equal('file next to directory entry', String(dirRead.get('folder/inside.txt').data), 'inside');

  // Stored (method 0) path: incompressible data should be stored, and readable.
  const storedZip = writeZip([{ name: 'r.bin', data: randomBytes(64) }]);
  const storedEntry = readZipEntriesDetailed(storedZip).get('r.bin');
  if (storedEntry && storedEntry.method === 0) {
    check('stored entry round trips', storedEntry.data.equals(readZipEntries(storedZip).get('r.bin')));
  }
}

function testZipRobustness() {
  section('zip reader robustness');

  const bad = [
    ['not a zip', Buffer.from('not a zip')],
    ['empty buffer', Buffer.alloc(0)],
    ['short buffer', Buffer.from([0x50, 0x4b])],
    ['random noise', randomBytes(4096)],
    ['signature only', Buffer.concat([Buffer.alloc(30), Buffer.from([0x50, 0x4b, 0x05, 0x06])])],
  ];
  for (const [label, buffer] of bad) {
    let error = null;
    try {
      readZipEntries(buffer);
    } catch (err) {
      error = err;
    }
    check(`readZipEntries throws readable Error for ${label}`, error instanceof Error, String(error));
    if (error) check(`error message for ${label} is readable`, error.message.length > 8, error.message);
  }

  // Truncated archive: must throw, never read out of bounds.
  const zip = writeZip([{ name: 'x.txt', data: 'y'.repeat(1000) }]);
  let truncatedError = null;
  try {
    readZipEntries(zip.subarray(0, Math.floor(zip.length / 2)));
  } catch (err) {
    truncatedError = err;
  }
  check('truncated archive throws Error', truncatedError instanceof Error, String(truncatedError));

  // Trailing archive comment (up to 64 KiB) must not confuse the EOCD scan.
  const comment = randomBytes(3000);
  const withComment = Buffer.concat([zip, comment]);
  withComment.writeUInt16LE(comment.length, withComment.length - comment.length - 2);
  const commented = readZipEntries(withComment);
  equal('entry found with trailing comment', String(commented.get('x.txt')), 'y'.repeat(1000));

  // A self-extractor style prefix shifts every declared offset.
  const prefix = randomBytes(512);
  const prefixed = Buffer.concat([prefix, zip]);
  let prefixedRead = null;
  try {
    prefixedRead = readZipEntries(prefixed);
  } catch (err) {
    prefixedRead = err;
  }
  check('prepended stub is handled', prefixedRead instanceof Map, String(prefixedRead));
  if (prefixedRead instanceof Map) {
    equal('prepended stub content', String(prefixedRead.get('x.txt')), 'y'.repeat(1000));
  }

  // Local header sizes must not be trusted when the central directory disagrees.
  const mutated = Buffer.from(zip);
  const localOffset = mutated.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  check('found local header to mutate', localOffset >= 0);
  if (localOffset >= 0) {
    mutated.writeUInt32LE(0, localOffset + 18); // compressed size
    mutated.writeUInt32LE(0, localOffset + 22); // uncompressed size
    mutated.writeUInt16LE(mutated.readUInt16LE(localOffset + 6) | 0x0008, localOffset + 6); // data descriptor flag
    const mutatedRead = readZipEntries(mutated);
    equal('central directory sizes win over local header', String(mutatedRead.get('x.txt')), 'y'.repeat(1000));
  }

  // Encrypted entries must produce a clear error, not garbage.
  const encrypted = Buffer.from(zip);
  const encOffset = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (encOffset >= 0) {
    encrypted.writeUInt16LE(encrypted.readUInt16LE(encOffset + 6) | 0x0001, encOffset + 6);
    let encError = null;
    try {
      readZipEntries(encrypted);
    } catch (err) {
      encError = err;
    }
    check('encrypted entry throws', encError instanceof Error, String(encError));
    if (encError) includes('encryption error message', encError.message, 'encrypted');
  }

  // A wildly understated uncompressed size must not expand into an unbounded buffer.
  const bombZip = writeZip([{ name: 'bomb.txt', data: Buffer.alloc(2 * 1024 * 1024, 0x41) }]);
  const bomb = Buffer.from(bombZip);
  const centralOffset = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  check('found central directory to patch', centralOffset >= 0);
  if (centralOffset >= 0) {
    bomb.writeUInt32LE(1024, centralOffset + 24); // lie: uncompressedSize = 1 KiB
    let bombError = null;
    try {
      readZipEntries(bomb);
    } catch (err) {
      bombError = err;
    }
    check('zip bomb is rejected', bombError instanceof Error, String(bombError));
    if (bombError) includes('zip bomb error message is readable', bombError.message, 'inflate');
  }

  // writeZip argument validation.
  let argError = null;
  try {
    writeZip([{ name: '', data: 'x' }]);
  } catch (err) {
    argError = err;
  }
  check('writeZip rejects empty entry name', argError instanceof Error);
}

/* ------------------------------------------------------------------ */
/* 2. docx                                                            */
/* ------------------------------------------------------------------ */

async function testDocx() {
  section('docx');
  const buffer = fixture('sample.docx');
  if (!buffer) {
    check('sample.docx fixture exists', false, 'run make_fixtures.py');
    return;
  }

  const res = await docxToHtml(buffer);
  equal('docx ok', res.ok, true);
  if (!res.ok) console.log(`  docx warning: ${res.warning}`);

  includes('docx text: heading', res.text, 'Quarterly Report');
  includes('docx text: subheading', res.text, 'Financial Highlights');
  includes('docx text: bold run', res.text, 'BoldMarker');
  includes('docx text: italic run', res.text, 'ItalicMarker');
  includes('docx text: bullet', res.text, 'BulletAlpha');
  includes('docx text: second bullet', res.text, 'BulletBeta');
  includes('docx text: table cell', res.text, 'TableCellMarker');
  includes('docx text: hyperlink text', res.text, 'ExampleLink');
  includes('docx text: escaped source string preserved verbatim', res.text, '5 < 10 & "quoted"');
  includes('docx text: table cell separator is a tab', res.text, 'TableCellMarker\t1250000');
  check(
    'docx text has no raw html',
    !/[<>]/.test(res.text.replace(/5 < 10 & "quoted"/, '')),
    res.text.slice(0, 120),
  );

  includes('docx html: h1', res.html, '<h1');
  includes('docx html: heading level 2', res.html, '<h2');
  includes('docx html: strong', res.html, '<strong>BoldMarker</strong>');
  includes('docx html: em', res.html, '<em>ItalicMarker</em>');
  includes('docx html: ul', res.html, '<ul>');
  includes('docx html: li', res.html, '<li>BulletAlpha</li>');
  includes('docx html: table', res.html, '<table class="doc-table">');
  includes('docx html: td', res.html, '<td>');
  includes('docx html: image', res.html, '<img src="data:image/png;base64,');
  includes('docx html: hyperlink', res.html, '<a href="https://example.com/report"');
  includes('docx html: color style', res.html, 'color:#c00000');
  includes('docx html: font size style', res.html, 'font-size:14pt');

  // Escaping: the injected string must be escaped, never live markup.
  includes('docx html escapes <', res.html, '&lt;');
  includes('docx html escapes &', res.html, '&amp;');
  includes('docx html escapes quotes', res.html, '&quot;quoted&quot;');
  excludes('docx html has no raw injected "<"', res.html, '5 < 10');
  excludes('docx html has no raw injected "&"', res.html, '10 & "');
  check(
    'docx html has no dangling script/img onerror',
    !/<script|onerror=|javascript:/i.test(res.html),
  );

  equal('docx meta title', res.meta.title, 'Quarterly Report Fixture');
  equal('docx meta author', res.meta.author, 'Fixture Author');
  equal('docx meta subject', res.meta.subject, 'Testing');
  check('docx meta created present', typeof res.meta.created === 'string' && res.meta.created.length > 0);
  check('docx meta wordCount > 20', res.meta.wordCount > 20, String(res.meta.wordCount));

  const text = await docxToText(buffer);
  check('docxToText returns string', typeof text === 'string');
  includes('docxToText content', text, 'Quarterly Report');

  // Truncated / garbage docx must not throw.
  const result = await callSafely(docxToHtml, buffer.subarray(0, 512), 'docx truncated');
  check('truncated docx does not throw', result.threw === null, String(result.threw));
  check('truncated docx resolves', Boolean(result.value) && typeof result.value === 'object');
  if (result.value && !result.value.ok) check('truncated docx warning text', result.value.warning.length > 0);
}

/* ------------------------------------------------------------------ */
/* 3. xlsx                                                            */
/* ------------------------------------------------------------------ */

async function testXlsx() {
  section('xlsx');
  const buffer = fixture('sample.xlsx');
  if (!buffer) {
    check('sample.xlsx fixture exists', false, 'run make_fixtures.py');
    return;
  }

  const res = await xlsxToHtml(buffer);
  equal('xlsx ok', res.ok, true);
  if (!res.ok) console.log(`  xlsx warning: ${res.warning}`);

  equal('xlsx sheet count', res.sheets.length, 2);
  equal('xlsx first sheet name', res.sheets[0].name, 'Data');
  equal('xlsx second sheet name', res.sheets[1].name, 'Summary');

  includes('xlsx text: header', res.text, 'Product');
  includes('xlsx text: string cell', res.text, 'Widget');
  includes('xlsx text: sparse cell', res.text, 'SparseCell');
  includes('xlsx text: date cell formatted', res.text, '2024-03-15');
  includes('xlsx text: percent cell formatted', res.text, '25%');
  includes('xlsx text: number passthrough', res.text, '19.5');

  includes('xlsx html: table', res.html, '<table class="sheet-table"');
  includes('xlsx html: thead', res.html, '<thead>');
  includes('xlsx html: multi-sheet separator', res.html, '<h3 class="sheet-title">Data</h3>');
  includes('xlsx html: second sheet table', res.sheets[1].html, '<table class="sheet-table"');
  includes('xlsx html: sparse value cell', res.sheets[1].html, '<td>SparseCell</td>');
  excludes('xlsx html: no unescaped script', res.html, '<script');

  // Both sheets are separate extractions too.
  includes('xlsx sheet 1 text', res.sheets[0].text, 'Widget');
  includes('xlsx sheet 2 text', res.sheets[1].text, 'SparseCell');

  // The Summary sheet is deliberately sparse (A1, B3, D5): gaps stay aligned.
  const summaryLines = res.sheets[1].text.split('\n');
  equal('xlsx sparse sheet row 1', summaryLines[0], 'SummaryHeader');
  equal('xlsx sparse sheet row 2 is an empty gap', summaryLines[1], '');
  check('xlsx sparse sheet row 3 holds B3', (summaryLines[2] || '').includes('SparseCell'), JSON.stringify(summaryLines[2]));
  equal('xlsx sparse sheet row 4 is an empty gap', summaryLines[3], '');
  check('xlsx sparse sheet row 5 holds D5', (summaryLines[4] || '').includes('1234.5'), JSON.stringify(summaryLines[4]));

  const text = await xlsxToText(buffer);
  check('xlsxToText returns string', typeof text === 'string');
  includes('xlsxToText content', text, 'SparseCell');

  // Hand-built workbook: sparse refs, leading empty row/column trimming,
  // inline strings, booleans, errors, and an absurd cell reference.
  const minimal = buildMinimalXlsx();
  const minimalRes = await xlsxToHtml(minimal);
  equal('minimal xlsx ok', minimalRes.ok, true);
  includes('minimal xlsx trims leading empty rows/cols (text)', minimalRes.text, 'TrimmedCell');
  includes('minimal xlsx inline string', minimalRes.text, 'InlineCell');
  includes('minimal xlsx boolean', minimalRes.text, 'TRUE');
  includes('minimal xlsx error cell', minimalRes.text, '#DIV/0!');
  check(
    'minimal xlsx html starts with the trimmed cell',
    minimalRes.html.startsWith('<table class="sheet-table"><thead><tr><th>TrimmedCell</th>'),
    minimalRes.html.slice(0, 160),
  );
  excludes('minimal xlsx drops the absurd XFD1048576 row from html', minimalRes.html, 'FarAwayCell');
  excludes('minimal xlsx drops the absurd XFD1048576 row from text', minimalRes.text, 'FarAwayCell');

  const truncated = await callSafely(xlsxToHtml, buffer.subarray(0, 512), 'xlsx truncated');
  check('truncated xlsx does not throw', truncated.threw === null, String(truncated.threw));
  check('truncated xlsx resolves', Boolean(truncated.value) && typeof truncated.value === 'object');

  // Hostile dimensions must not blow up time or memory.
  const started = Date.now();
  const hostile = await xlsxToHtml(buildHostileXlsx());
  const elapsed = Date.now() - started;
  equal('hostile xlsx ok', hostile.ok, true);
  includes('hostile xlsx keeps the anchor cell', hostile.text, 'AnchorCell');
  excludes('hostile xlsx drops the far row', hostile.text, 'FarRowCell');
  excludes('hostile xlsx drops the far column in html', hostile.html, 'FarColumnCell');
  check('hostile xlsx is fast', elapsed < 3000, `${elapsed}ms`);
}

function buildHostileXlsx() {
  const sheet = `<worksheet>
  <dimension ref="A1:XFD1048576"/>
  <sheetData>
    <row r="1"><c r="A1" t="str"><v>AnchorCell</v></c><c r="XFD1" t="str"><v>FarColumnCell</v></c></row>
    <row r="1048576"><c r="A2" t="str"><v>FarRowCell</v></c></row>
  </sheetData>
</worksheet>`;

  return writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'xl/workbook.xml',
      data:
        '<workbook><sheets><sheet name="Hostile" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

function buildMinimalXlsx() {
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sparse" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="4"><c r="C4" t="str"><v>TrimmedCell</v></c><c r="D4" t="inlineStr"><is><t xml:space="preserve">InlineCell</t></is></c><c r="E4" t="b"><v>1</v></c><c r="F4" t="e"><v>#DIV/0!</v></c></row>
    <row r="1048576"><c r="XFD1048576" t="str"><v>FarAwayCell</v></c></row>
  </sheetData>
</worksheet>`;

  return writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/* ------------------------------------------------------------------ */
/* 4. pptx                                                            */
/* ------------------------------------------------------------------ */

async function testPptx() {
  section('pptx');
  const buffer = fixture('sample.pptx');
  if (!buffer) {
    check('sample.pptx fixture exists', false, 'run make_fixtures.py');
    return;
  }

  const res = await pptxToHtml(buffer);
  equal('pptx ok', res.ok, true);
  if (!res.ok) console.log(`  pptx warning: ${res.warning}`);

  equal('pptx slide count', res.slides.length, 3);
  includes('pptx text: slide 1 title', res.text, 'QuarterlyReportSlide');
  includes('pptx text: slide 1 bullet', res.text, 'SlideOneBullet');
  includes('pptx text: slide 2 bullet', res.text, 'SlideTwoBullet');
  includes('pptx text: slide 3 bullet', res.text, 'SlideThreeBullet');
  includes('pptx text: blank line between slides', res.text, 'Third bullet\n\nOperations Update');
  check(
    'pptx slide order is preserved',
    res.text.indexOf('QuarterlyReportSlide') < res.text.indexOf('Operations Update') &&
      res.text.indexOf('Operations Update') < res.text.indexOf('Next Steps'),
    res.text.slice(0, 200),
  );

  includes('pptx html: section', res.html, '<section class="slide">');
  includes('pptx html: slide body', res.html, '<div class="slide-body">');
  includes('pptx html: title heading', res.html, '<h2>QuarterlyReportSlide</h2>');
  includes('pptx html: body paragraph', res.html, '<p>SlideOneBullet</p>');
  equal('pptx slide index 1', res.slides[0].index, 1);
  equal('pptx slide index 3', res.slides[2].index, 3);

  const text = await pptxToText(buffer);
  check('pptxToText returns string', typeof text === 'string');
  includes('pptxToText content', text, 'SlideThreeBullet');

  const truncated = await callSafely(pptxToHtml, buffer.subarray(0, 512), 'pptx truncated');
  check('truncated pptx does not throw', truncated.threw === null, String(truncated.threw));
  check('truncated pptx resolves', Boolean(truncated.value) && typeof truncated.value === 'object');
}

/* ------------------------------------------------------------------ */
/* 5. garbage inputs for every export                                 */
/* ------------------------------------------------------------------ */

async function testGarbageInputs() {
  section('garbage inputs never throw and never hang');

  const docx = fixture('sample.docx');
  const xlsx = fixture('sample.xlsx');
  const pptx = fixture('sample.pptx');

  const inputs = [
    ['text junk', Buffer.from('not a zip')],
    ['empty', Buffer.alloc(0)],
    ['random bytes', randomBytes(8192)],
    ['null-ish bytes', Buffer.alloc(64, 0)],
  ];
  if (docx) inputs.push(['truncated docx', docx.subarray(0, 200)]);
  if (xlsx) inputs.push(['truncated xlsx', xlsx.subarray(0, 200)]);
  if (pptx) inputs.push(['truncated pptx', pptx.subarray(0, 200)]);

  const htmlExports = [
    ['docxToHtml', docxToHtml],
    ['xlsxToHtml', xlsxToHtml],
    ['pptxToHtml', pptxToHtml],
  ];
  const textExports = [
    ['docxToText', docxToText],
    ['xlsxToText', xlsxToText],
    ['pptxToText', pptxToText],
  ];

  for (const [fnName, fn] of htmlExports) {
    for (const [label, input] of inputs) {
      const outcome = await callSafely(fn, input, `${fnName}/${label}`);
      const tag = `${fnName}(${label})`;
      check(`${tag} does not throw`, outcome.threw === null, String(outcome.threw));
      check(`${tag} does not hang`, outcome.timedOut === false);
      check(`${tag} is fast`, outcome.ms < 5000, `${outcome.ms}ms`);
      if (outcome.value) {
        check(`${tag} returns an object`, typeof outcome.value === 'object');
        check(`${tag} reports ok:false`, outcome.value.ok === false, JSON.stringify(outcome.value).slice(0, 160));
        check(`${tag} has empty html`, outcome.value.html === '', JSON.stringify(outcome.value.html).slice(0, 80));
        check(`${tag} has empty text`, outcome.value.text === '');
        check(`${tag} has a warning`, typeof outcome.value.warning === 'string' && outcome.value.warning.length > 0);
      }
    }
  }

  for (const [fnName, fn] of textExports) {
    for (const [label, input] of inputs) {
      const outcome = await callSafely(fn, input, `${fnName}/${label}`);
      const tag = `${fnName}(${label})`;
      check(`${tag} does not throw`, outcome.threw === null, String(outcome.threw));
      check(`${tag} does not hang`, outcome.timedOut === false);
      check(`${tag} returns a string`, typeof outcome.value === 'string', typeof outcome.value);
    }
  }

  // Non-buffer inputs must also be survivable.
  for (const [fnName, fn] of htmlExports) {
    for (const value of [null, undefined, 'a string', 42, {}]) {
      const outcome = await callSafely(fn, value, `${fnName}/${String(value)}`);
      const tag = `${fnName}(${String(value)})`;
      check(`${tag} does not throw`, outcome.threw === null, String(outcome.threw));
      if (outcome.value) check(`${tag} reports ok:false`, outcome.value.ok === false);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6. corruption fuzzing on real fixtures                             */
/* ------------------------------------------------------------------ */

async function testCorruptionFuzz() {
  section('bit-flip fuzzing on real fixtures (no throw, no crash)');
  const sources = [
    ['docx', fixture('sample.docx'), docxToHtml],
    ['xlsx', fixture('sample.xlsx'), xlsxToHtml],
    ['pptx', fixture('sample.pptx'), pptxToHtml],
  ].filter(([, buffer]) => Boolean(buffer));

  for (const [label, buffer, fn] of sources) {
    let okCount = 0;
    let softCount = 0;
    for (let round = 0; round < 12; round += 1) {
      const mutated = Buffer.from(buffer);
      const flips = 1 + (round % 4);
      for (let i = 0; i < flips; i += 1) {
        const at = Math.floor(Math.random() * mutated.length);
        mutated[at] = mutated[at] ^ (1 << Math.floor(Math.random() * 8));
      }
      const outcome = await callSafely(fn, mutated, `${label} fuzz ${round}`);
      if (outcome.threw) {
        check(`${label} fuzz ${round} does not throw`, false, String(outcome.threw));
      } else if (outcome.timedOut) {
        check(`${label} fuzz ${round} does not hang`, false);
      } else if (outcome.value && outcome.value.ok) {
        okCount += 1;
      } else {
        softCount += 1;
      }
    }
    check(`${label} fuzz: no throw and no hang in 12 rounds`, true);
    console.log(`  ${label}: ${okCount} still parsed, ${softCount} reported failure`);
  }
}

/* ------------------------------------------------------------------ */
/* 4b. hand-built docx edge cases                                     */
/* ------------------------------------------------------------------ */

function buildMinimalDocx({ images = [], hyperlink = null } = {}) {
  const rels = [];
  const bodyParts = [];
  const files = [];

  images.forEach((data, index) => {
    const relId = `rIdImg${index + 1}`;
    rels.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.png"/>`,
    );
    bodyParts.push(`<w:p><w:r><w:drawing><a:blip r:embed="${relId}"/></w:drawing></w:r></w:p>`);
    files.push({ name: `word/media/image${index + 1}.png`, data });
  });

  if (hyperlink) {
    rels.push(
      `<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${hyperlink}" TargetMode="External"/>`,
    );
    bodyParts.push(`<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>LinkText</w:t></w:r></w:hyperlink></w:p>`);
  }

  const document = `<w:document><w:body>${bodyParts.join('')}</w:body></w:document>`;
  const relsXml = `<Relationships>${rels.join('')}</Relationships>`;

  return writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: relsXml },
    ...files,
  ]);
}

async function testDocxEdgeCases() {
  section('docx edge cases (hand-built OOXML)');

  // Two 8 MB images exceed the ~15 MB embedding budget: only the first is inlined.
  const twoBig = await docxToHtml(
    buildMinimalDocx({ images: [Buffer.alloc(8 * 1024 * 1024, 0xab), Buffer.alloc(8 * 1024 * 1024, 0xcd)] }),
  );
  equal('image budget docx ok', twoBig.ok, true);
  const imgCount = (twoBig.html.match(/<img /g) || []).length;
  equal('only one 8MB image is embedded (15MB cap)', imgCount, 1);

  const oneHuge = await docxToHtml(buildMinimalDocx({ images: [Buffer.alloc(16 * 1024 * 1024, 0xef)] }));
  equal('16MB image is skipped', (oneHuge.html.match(/<img /g) || []).length, 0);

  const small = await docxToHtml(buildMinimalDocx({ images: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])] }));
  includes('small image is embedded as a data URI', small.html, '<img src="data:image/png;base64,');
  includes('image data matches the source bytes', small.html, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'));

  // Dangerous hyperlink targets are dropped, the text survives.
  const unsafe = await docxToHtml(buildMinimalDocx({ hyperlink: 'javascript:alert(1)' }));
  includes('unsafe link text still rendered', unsafe.html, 'LinkText');
  excludes('javascript: href is stripped', unsafe.html, 'javascript:');

  const safe = await docxToHtml(buildMinimalDocx({ hyperlink: 'https://example.com/a?b=1&c=2' }));
  includes('safe href is kept', safe.html, 'href="https://example.com/a?b=1&amp;c=2"');

  // A docx that is a valid zip but has no word/document.xml.
  const emptyZip = writeZip([{ name: 'hello.txt', data: 'not a word file' }]);
  const notDocx = await docxToHtml(emptyZip);
  equal('zip without document.xml reports ok:false', notDocx.ok, false);
  includes('zip without document.xml explains itself', notDocx.warning, 'word/document.xml');

  // Run formatting, tabs/breaks and table span handling.
  const formatting = `<w:document><w:body>
    <w:p>
      <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Highlighted</w:t></w:r>
      <w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>Sup</w:t></w:r>
      <w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>Sub</w:t></w:r>
      <w:r><w:rPr><w:strike/></w:rPr><w:t>Struck</w:t></w:r>
      <w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Under</w:t></w:r>
      <w:r><w:t>Tab</w:t><w:tab/><w:t>AfterTab</w:t><w:br/><w:t>AfterBreak</w:t></w:r>
    </w:p>
    <w:tbl><w:tr>
      <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>SpanCell</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>PlainCell</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>
  </w:body></w:document>`;

  const formatted = await docxToHtml(
    writeZip([
      { name: 'word/document.xml', data: formatting },
      { name: 'word/_rels/document.xml.rels', data: '<Relationships/>' },
    ]),
  );
  equal('formatting docx ok', formatted.ok, true);
  includes('highlight becomes a background color', formatted.html, 'background-color:#ffff00');
  includes('superscript', formatted.html, '<sup>Sup</sup>');
  includes('subscript', formatted.html, '<sub>Sub</sub>');
  includes('strikethrough', formatted.html, '<s>Struck</s>');
  includes('underline', formatted.html, '<u>Under</u>');
  includes('br becomes <br>', formatted.html, 'AfterTab<br>AfterBreak');
  check('tab becomes a literal tab', formatted.html.includes('Tab\tAfterTab'), JSON.stringify(formatted.html.slice(0, 260)));
  includes('gridSpan becomes colspan', formatted.html, '<td colspan="2">SpanCell</td>');
  includes('table cell text', formatted.text, 'SpanCell\tPlainCell');
}

/* ------------------------------------------------------------------ */

async function main() {
  ensureFixtures();
  console.log('kbpro officedoc/zip test suite');
  for (const [name, buffer] of [
    ['sample.docx', fixture('sample.docx')],
    ['sample.xlsx', fixture('sample.xlsx')],
    ['sample.pptx', fixture('sample.pptx')],
  ]) {
    if (buffer) console.log(`fixture ${name}: ${buffer.length} bytes`);
  }

  testCrc32();
  testZipRoundTrip();
  testZipRobustness();
  await testDocx();
  await testXlsx();
  await testPptx();
  await testDocxEdgeCases();
  await testGarbageInputs();
  await testCorruptionFuzz();

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`checks passed: ${passed}`);
  console.log(`checks failed: ${failed}`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log(failed === 0 ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exitCode = 1;
});
