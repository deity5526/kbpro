/**
 * zip.js — a minimal, dependency-free ZIP reader/writer that works on in-memory Buffers.
 *
 * Supported:
 *   - stored (method 0) and deflate (method 8) entries
 *   - reading Zip64 end-of-central-directory / extra fields (minimal, gracefully)
 *   - UTF-8 entry names (flag bit 11) and legacy CP437 names
 *   - writing a spec-correct archive with central directory + EOCD
 *
 * Not supported (throws a clear Error instead of misbehaving):
 *   - encrypted entries (flag bit 0)
 *   - compression methods other than 0 and 8
 *   - writing archives larger than 4 GiB (no Zip64 writer)
 *
 * Everything is bounds-checked: a malformed archive throws `Error`, it never
 * reads out of range or allocates a buffer from an attacker-controlled length.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const MAX_COMMENT = 0xffff; // 64 KiB trailing comment
const ZIP64_MARKER32 = 0xffffffff;
const ZIP64_MARKER16 = 0xffff;

const U32_MAX = 0xffffffff;

/* ------------------------------------------------------------------ */
/* crc32                                                               */
/* ------------------------------------------------------------------ */

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

/**
 * Standard CRC-32 (IEEE 802.3, the one ZIP uses).
 * @param {Buffer|Uint8Array|string} buf
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(buf) {
  const data = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : toBytes(buf, 'crc32');
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(value, what) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error(`zip: ${what} must be a Buffer, Uint8Array or ArrayBuffer`);
}

/* ------------------------------------------------------------------ */
/* small safe read helpers                                             */
/* ------------------------------------------------------------------ */

function need(buf, offset, length, what) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    throw new Error(`zip: invalid read of ${length} byte(s) at ${offset} for ${what}`);
  }
  if (offset + length > buf.length) {
    throw new Error(`zip: truncated archive while reading ${what} (needed ${length} byte(s) at ${offset}, buffer is ${buf.length})`);
  }
}

function u16(buf, offset, what) {
  need(buf, offset, 2, what);
  return buf.readUInt16LE(offset);
}

function u32(buf, offset, what) {
  need(buf, offset, 4, what);
  return buf.readUInt32LE(offset);
}

function u64(buf, offset, what) {
  need(buf, offset, 8, what);
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`zip: ${what} is too large to address in memory`);
  }
  return Number(value);
}

/* ------------------------------------------------------------------ */
/* name decoding                                                       */
/* ------------------------------------------------------------------ */

// CP437 code points for bytes 0x80..0xff (the DOS/legacy ZIP default).
const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
  0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
  0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
  0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
  0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
  0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
  0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

/**
 * Decode a ZIP entry name. UTF-8 when flag bit 11 is set, otherwise try UTF-8
 * (many tools write UTF-8 without the flag) and fall back to CP437.
 */
function decodeName(bytes, utf8Flag) {
  const buf = Buffer.from(bytes);
  if (utf8Flag) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
  // No flag: assume UTF-8 only if it is strictly valid, else CP437.
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return decoded;
  } catch {
    let out = '';
    for (const byte of buf) {
      if (byte < 0x80) out += String.fromCharCode(byte);
      else out += String.fromCharCode(CP437_HIGH[byte - 0x80]);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

function findEocd(buf) {
  if (buf.length < 22) {
    throw new Error('zip: buffer is too small to be a ZIP archive');
  }
  const lowest = Math.max(0, buf.length - 22 - MAX_COMMENT);
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return i;
    }
  }
  throw new Error('zip: end of central directory record not found (not a ZIP archive?)');
}

function locateCentralDirectory(buf) {
  const eocd = findEocd(buf);
  const commentLength = u16(buf, eocd + 20, 'EOCD comment length');
  if (eocd + 22 + commentLength > buf.length) {
    // Tolerate a truncated/incorrect comment length rather than failing hard.
    // (Some writers lie about it; the record itself is still usable.)
  }

  let entryCount = u16(buf, eocd + 10, 'EOCD entry count');
  let cdSize = u32(buf, eocd + 12, 'EOCD central directory size');
  let cdOffset = u32(buf, eocd + 16, 'EOCD central directory offset');

  const needsZip64 =
    entryCount === ZIP64_MARKER16 || cdSize === ZIP64_MARKER32 || cdOffset === ZIP64_MARKER32;

  if (needsZip64) {
    const locatorOffset = eocd - 20;
    if (locatorOffset >= 0 && u32(buf, locatorOffset, 'Zip64 locator') === SIG_ZIP64_LOCATOR) {
      const z64Offset = u64(buf, locatorOffset + 8, 'Zip64 EOCD offset');
      if (z64Offset >= 0 && z64Offset + 56 <= buf.length && u32(buf, z64Offset, 'Zip64 EOCD') === SIG_ZIP64_EOCD) {
        entryCount = u64(buf, z64Offset + 32, 'Zip64 entry count');
        cdSize = u64(buf, z64Offset + 40, 'Zip64 central directory size');
        cdOffset = u64(buf, z64Offset + 48, 'Zip64 central directory offset');
      }
    }
  }

  // Recover from a bogus central-directory offset by deriving it from the EOCD.
  // (Also handles archives with a self-extractor stub prepended, where every
  // declared offset is shifted by a constant delta.)
  let offsetDelta = 0;
  const looksLikeCentralDirectory = (candidate) =>
    candidate >= 0 &&
    candidate + 4 <= buf.length &&
    buf.readUInt32LE(candidate) === SIG_CENTRAL;

  const declaredUsable =
    cdOffset >= 0 && cdOffset + cdSize <= buf.length && looksLikeCentralDirectory(cdOffset);

  if (!declaredUsable) {
    const derived = eocd - cdSize;
    if (derived >= 0 && derived + cdSize <= buf.length && looksLikeCentralDirectory(derived)) {
      offsetDelta = derived - cdOffset;
      cdOffset = derived;
    } else if (cdOffset + cdSize > buf.length || cdOffset > buf.length) {
      throw new Error('zip: central directory lies outside the archive buffer');
    }
  }

  return { eocd, entryCount, cdSize, cdOffset, offsetDelta };
}

function parseZip64Extra(extra, fields) {
  // `fields` describes which 32-bit values were 0xFFFFFFFF markers, in the
  // fixed Zip64 order: uncompressed, compressed, local header offset, disk start.
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    p += 4;
    if (p + size > extra.length) break;
    if (id === 0x0001) {
      let q = p;
      const out = {};
      const take64 = (key) => {
        if (!fields.has(key)) return undefined;
        if (q + 8 > p + size) return undefined;
        const value = extra.readBigUInt64LE(q);
        q += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`zip: Zip64 ${key} is too large to address in memory`);
        }
        return Number(value);
      };
      out.uncompressedSize = take64('uncompressedSize');
      out.compressedSize = take64('compressedSize');
      out.localHeaderOffset = take64('localHeaderOffset');
      return out;
    }
    p += size;
  }
  return {};
}

function parseCentralDirectory(buf) {
  const { entryCount, cdOffset, cdSize, offsetDelta } = locateCentralDirectory(buf);
  need(buf, cdOffset, cdSize, 'central directory');

  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;

  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > end) {
      throw new Error('zip: central directory entry is truncated');
    }
    const sig = buf.readUInt32LE(p);
    if (sig !== SIG_CENTRAL) {
      throw new Error(`zip: bad central directory signature at offset ${p}`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const modTime = buf.readUInt16LE(p + 12);
    const modDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localHeaderOffset = buf.readUInt32LE(p + 42);

    if (p + 46 + nameLength + extraLength + commentLength > end) {
      throw new Error('zip: central directory entry overruns the central directory');
    }

    const nameBytes = buf.subarray(p + 46, p + 46 + nameLength);
    const extra = buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);

    if (
      compressedSize === ZIP64_MARKER32 ||
      uncompressedSize === ZIP64_MARKER32 ||
      localHeaderOffset === ZIP64_MARKER32
    ) {
      const markerFields = new Set();
      if (uncompressedSize === ZIP64_MARKER32) markerFields.add('uncompressedSize');
      if (compressedSize === ZIP64_MARKER32) markerFields.add('compressedSize');
      if (localHeaderOffset === ZIP64_MARKER32) markerFields.add('localHeaderOffset');
      const z64 = parseZip64Extra(extra, markerFields);
      if (z64.uncompressedSize !== undefined) uncompressedSize = z64.uncompressedSize;
      if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
      if (z64.localHeaderOffset !== undefined) localHeaderOffset = z64.localHeaderOffset;
    }

    const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
    const isDirectory = name.endsWith('/') || (externalAttrs & 0x10) !== 0;

    entries.push({
      name: name.replace(/\\/g, '/'),
      flags,
      method,
      modTime,
      modDate,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory,
    });

    p += 46 + nameLength + extraLength + commentLength;
  }

  if (offsetDelta) {
    for (const entry of entries) entry.localHeaderOffset += offsetDelta;
  }

  return entries;
}

function extractEntryData(buf, entry) {
  const { localHeaderOffset, compressedSize, method, name } = entry;

  need(buf, localHeaderOffset, 30, `local header of "${name}"`);
  if (buf.readUInt32LE(localHeaderOffset) !== SIG_LOCAL) {
    throw new Error(`zip: bad local header signature for entry "${name}"`);
  }

  const flags = buf.readUInt16LE(localHeaderOffset + 6);
  if (flags & 0x0001) {
    throw new Error(`zip: entry "${name}" is encrypted and cannot be read`);
  }

  const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;

  // Prefer the central directory's compressed size: with flag bit 3 (data
  // descriptor) the local header sizes are zero / unreliable.
  let size = compressedSize;
  if (flags & 0x0008 || size === 0) {
    const localCompressed = buf.readUInt32LE(localHeaderOffset + 18);
    if (!(flags & 0x0008) && localCompressed !== 0) size = localCompressed;
  }

  need(buf, dataStart, size, `compressed data of "${name}"`);
  const raw = buf.subarray(dataStart, dataStart + size);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    // Bound the inflated output against the central directory's declared size so
    // a maliciously small header cannot expand into an unbounded buffer.
    const limit = Math.max(entry.uncompressedSize * 2 + 0x10000, 1 << 20);
    try {
      return inflateRawSync(raw, { maxOutputLength: limit });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`zip: failed to inflate entry "${name}": ${message}`);
    }
  }
  throw new Error(`zip: entry "${name}" uses unsupported compression method ${method}`);
}

function buildResult(buffer, detailed) {
  const buf = toBytes(buffer, 'readZipEntries argument');
  const entries = parseCentralDirectory(buf);
  const out = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) {
      if (detailed) {
        out.set(entry.name, {
          name: entry.name,
          data: Buffer.alloc(0),
          size: 0,
          compressedSize: entry.compressedSize,
          method: entry.method,
          crc32: entry.crc,
          isDirectory: true,
        });
      } else {
        out.set(entry.name, Buffer.alloc(0));
      }
      continue;
    }
    const data = extractEntryData(buf, entry);
    if (detailed) {
      out.set(entry.name, {
        name: entry.name,
        data,
        size: data.length,
        compressedSize: entry.compressedSize,
        method: entry.method,
        crc32: entry.crc,
        isDirectory: false,
      });
    } else {
      out.set(entry.name, data);
    }
  }

  return out;
}

/**
 * Parse a ZIP archive from a Buffer.
 * Directory entries are mapped to empty Buffers.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Map<string, Buffer>} entry name (forward slashes) -> file contents
 */
export function readZipEntries(buffer) {
  return buildResult(buffer, false);
}

/**
 * Same as {@link readZipEntries} but with per-entry metadata.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Map<string, {name:string,data:Buffer,size:number,compressedSize:number,method:number,crc32:number,isDirectory:boolean}>}
 */
export function readZipEntriesDetailed(buffer) {
  return buildResult(buffer, true);
}

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */

function dosDateTime(when) {
  const d = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01 00:00:00
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * Create a ZIP archive in memory.
 *
 * @param {Array<{name:string, data:Buffer|Uint8Array|string}>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('zip: writeZip expects an array of { name, data } entries');
  }

  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error('zip: every entry needs a non-empty string name');
    }
    const name = entry.name.replace(/\\/g, '/');
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 0xffff) {
      throw new Error(`zip: entry name is too long: "${name}"`);
    }

    const raw = entry.data === undefined || entry.data === null
      ? Buffer.alloc(0)
      : typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : toBytes(entry.data, `data for "${name}"`);

    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : raw;

    if (raw.length > U32_MAX || payload.length > U32_MAX || offset > U32_MAX) {
      throw new Error('zip: archive exceeds 4 GiB; Zip64 output is not supported');
    }

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 names
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const localBuffer = Buffer.concat(locals);

  if (offset + centralBuffer.length > U32_MAX) {
    throw new Error('zip: archive exceeds 4 GiB; Zip64 output is not supported');
  }
  if (entries.length > 0xffff) {
    throw new Error('zip: too many entries; Zip64 output is not supported');
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}
