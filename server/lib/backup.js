/**
 * KBPRO — 备份 / 恢复 / 导出
 *  备份粒度：
 *    · full       —— 数据库 + 全部文件（可选口令加密，生成自包含 .kbpro 包）
 *    · metadata   —— 仅数据库
 *    · workspace  —— 指定知识库的元数据 + 文件（可导入到其它实例）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, FILES_DIR, BACKUP_DIR, DB_PATH, ensureDirs } from '../config.js';
import { all, get, run, insert, nowIso, getDb, tx, closeDb } from '../db.js';
import { randomId, deriveKeyFromPassword, encryptBuffer, decryptBuffer, sha256, isEncryptedPayload } from './crypto.js';
import { createZip, directoryToEntries, listZip, readZipEntry, timestampName, safeArchiveName } from './archive.js';
import { absoluteStoragePath } from './storage.js';

/* ------------------------------------------------------------------ 数据库快照 */

/** 使用 SQLite VACUUM INTO 生成一致性的数据库快照 */
export async function snapshotDatabase(destPath) {
  ensureDirs();
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) await fsp.unlink(destPath);
  getDb().exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  const stat = await fsp.stat(destPath);
  return { path: destPath, size: stat.size };
}

/* ------------------------------------------------------------------ 创建备份 */

/**
 * @param {object} p
 * @param {'full'|'metadata'|'workspace'} p.kind
 * @param {string} [p.workspaceId]
 * @param {string} [p.password] 设置后备份包将被 AES-256-GCM 加密
 * @param {string} p.userId
 * @param {string} [p.note]
 */
export async function createBackup(p) {
  ensureDirs();
  const kind = p.kind || 'full';
  const started = Date.now();
  const id = randomId('bak');
  const workDir = path.join(BACKUP_DIR, `.work_${id}`);
  await fsp.mkdir(workDir, { recursive: true });

  try {
    const dbSnap = path.join(workDir, 'kbpro.sqlite');
    await snapshotDatabase(dbSnap);

    const manifest = {
      product: 'KBPRO',
      formatVersion: 1,
      createdAt: nowIso(),
      kind,
      workspaceId: p.workspaceId || null,
      appVersion: '1.0.0',
      encrypted: false,
      counts: {},
      files: []
    };

    const entries = [];

    if (kind === 'workspace' && p.workspaceId) {
      // 仅导出该知识库：元数据以 JSON 形式打包
      manifest.workspace = get(`SELECT * FROM workspaces WHERE id=?`, p.workspaceId);
      manifest.folders = all(`SELECT * FROM folders WHERE workspace_id=?`, p.workspaceId);
      manifest.files = all(`SELECT * FROM files WHERE workspace_id=? AND deleted_at IS NULL`, p.workspaceId);
      manifest.notes = all(`SELECT * FROM notes WHERE workspace_id=? AND deleted_at IS NULL`, p.workspaceId);
      manifest.tags = all(`SELECT * FROM tags WHERE workspace_id=?`, p.workspaceId);
      manifest.fileText = all(`SELECT * FROM file_text WHERE workspace_id=?`, p.workspaceId);
      entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

      for (const f of manifest.files) {
        try {
          const p2 = absoluteStoragePath(f.storage_key);
          const data = await fsp.readFile(p2);
          entries.push({ name: `files/${f.storage_key}`, data, mtime: new Date(f.created_at) });
        } catch { /* 缺失文件跳过 */ }
      }
    } else {
      manifest.counts.users = Number(get(`SELECT COUNT(*) AS n FROM users`)?.n || 0);
      manifest.counts.workspaces = Number(get(`SELECT COUNT(*) AS n FROM workspaces`)?.n || 0);
      manifest.counts.files = Number(get(`SELECT COUNT(*) AS n FROM files`)?.n || 0);
      manifest.counts.notes = Number(get(`SELECT COUNT(*) AS n FROM notes`)?.n || 0);
      if (kind === 'full') {
        const fileEntries = await directoryToEntries(FILES_DIR, { prefix: 'files' });
        entries.push({ name: 'kbpro.sqlite', data: await fsp.readFile(dbSnap) }, ...fileEntries);
        manifest.counts.filesOnDisk = fileEntries.length;
      } else {
        entries.push({ name: 'kbpro.sqlite', data: await fsp.readFile(dbSnap) });
      }
      // manifest 始终作为第一项写入
      entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
    }

    let zipBuf = createZip(entries);
    let encrypted = false;

    if (p.password) {
      const { key, salt } = deriveKeyFromPassword(p.password);
      const sealed = encryptBuffer(zipBuf, key);
      const header = Buffer.from(JSON.stringify({
        product: 'KBPRO', format: 'encrypted-backup', version: 1,
        salt, algo: 'aes-256-gcm+scrypt', createdAt: manifest.createdAt, kind
      }), 'utf8');
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32BE(header.length, 0);
      zipBuf = Buffer.concat([Buffer.from('KBPBAK01', 'ascii'), headerLen, header, sealed]);
      encrypted = true;
    }

    const ext = encrypted ? 'kbpro' : 'zip';
    const name = timestampName(`kbpro-${kind}`, ext);
    const finalPath = path.join(BACKUP_DIR, name);
    await fsp.writeFile(finalPath, zipBuf);

    const checksum = sha256(zipBuf);
    insert('backups', {
      id, name, path: finalPath, size: zipBuf.length, kind,
      encrypted: encrypted ? 1 : 0, scope: p.workspaceId || '', created_by: p.userId,
      note: p.note || '', created_at: nowIso()
    });

    return {
      id, name, path: finalPath, size: zipBuf.length, kind, encrypted, checksum,
      ms: Date.now() - started, manifest
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ 读取备份 */

export function listBackups() {
  return all(`SELECT * FROM backups ORDER BY created_at DESC`).map((b) => ({
    id: b.id, name: b.name, size: Number(b.size || 0), kind: b.kind,
    encrypted: !!b.encrypted, scope: b.scope, note: b.note,
    createdBy: b.created_by, createdAt: b.created_at,
    exists: fs.existsSync(b.path)
  }));
}

export function deleteBackup(id) {
  const row = get(`SELECT * FROM backups WHERE id=?`, id);
  if (!row) return false;
  try { fs.unlinkSync(row.path); } catch { /* */ }
  run(`DELETE FROM backups WHERE id=?`, id);
  return true;
}

/** 打开备份包（自动识别是否加密） */
export async function openBackup(filePath, password) {
  const buf = await fsp.readFile(filePath);
  if (buf.length > 8 && buf.subarray(0, 8).toString('ascii') === 'KBPBAK01') {
    if (!password) throw new Error('该备份包已加密，请提供解压口令');
    const headerLen = buf.readUInt32BE(8);
    const header = JSON.parse(buf.subarray(12, 12 + headerLen).toString('utf8'));
    const payload = buf.subarray(12 + headerLen);
    const { key } = deriveKeyFromPassword(password, header.salt);
    let plain;
    try {
      plain = decryptBuffer(payload, key);
    } catch {
      throw new Error('解压口令不正确或备份包已损坏');
    }
    return { zip: plain, header };
  }
  return { zip: buf, header: null };
}

export function inspectBackup(buffer) {
  const entries = listZip(buffer);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  let manifest = null;
  if (manifestEntry) {
    try { manifest = JSON.parse(readZipEntry(buffer, manifestEntry).toString('utf8')); } catch { /* */ }
  }
  return { entries: entries.map((e) => ({ name: e.name, size: e.rawSize })), manifest };
}

/* ------------------------------------------------------------------ 恢复 */

/**
 * 从备份包恢复（全量 / 知识库导入）。恢复数据库需要重启进程。
 */
export async function restoreBackup({ filePath, password, userId, mode = 'merge' }) {
  const { zip, header } = await openBackup(filePath, password);
  const { entries, manifest } = inspectBackup(zip);
  const hasDb = entries.some((e) => e.name === 'kbpro.sqlite');

  if (hasDb) {
    // 先做一次安全快照
    const safety = path.join(BACKUP_DIR, timestampName('kbpro-before-restore', 'sqlite'));
    await snapshotDatabase(safety);
    const dbEntry = listZip(zip).find((e) => e.name === 'kbpro.sqlite');
    const dbData = readZipEntry(zip, dbEntry);
    closeDb();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await fsp.rm(DB_PATH + suffix, { force: true });
    }
    await fsp.writeFile(DB_PATH, dbData);
    // 恢复文件
    const fileEntries = listZip(zip).filter((e) => e.name.startsWith('files/'));
    let restored = 0;
    for (const e of fileEntries) {
      const rel = safeArchiveName(e.name.slice('files/'.length));
      const dest = path.join(FILES_DIR, rel.split('/').join(path.sep));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, readZipEntry(zip, e));
      restored++;
    }
    return { mode: 'full', restoredFiles: restored, safetySnapshot: safety, requiresRestart: true, header };
  }

  if (manifest && manifest.workspace) {
    return await importWorkspaceArchive({ zip, manifest, userId, mode });
  }

  throw new Error('无法识别的备份包结构');
}

/** 将知识库归档导入到当前实例 */
async function importWorkspaceArchive({ zip, manifest, userId, mode = 'merge' }) {
  const entries = listZip(zip);
  const oldWs = manifest.workspace;
  const newWsId = randomId('ws');
  const now = nowIso();
  const idMap = { folders: new Map(), files: new Map(), notes: new Map(), tags: new Map() };

  // 解包文件到临时位置
  const staged = [];
  for (const e of entries) {
    if (!e.name.startsWith('files/')) continue;
    staged.push({ entry: e, data: readZipEntry(zip, e) });
  }

  tx((d) => {
    d.prepare(`INSERT INTO workspaces(id,name,kind,owner_id,team_id,description,color,icon,is_default,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,0,?,?)`)
      .run(newWsId, `${oldWs.name}（导入）`, 'personal', userId, null,
        oldWs.description || '', oldWs.color || '#1F2937', oldWs.icon || 'folder', now, now);

    for (const f of manifest.folders || []) {
      const nid = randomId('fld');
      idMap.folders.set(f.id, nid);
      d.prepare(`INSERT INTO folders(id,workspace_id,parent_id,name,path,color,icon,sort_order,created_by,created_at,updated_at,deleted_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .run(nid, newWsId, null, f.name, '/', f.color || '', f.icon || '', f.sort_order || 0, userId, f.created_at || now, now);
    }
    // 修正父子关系
    for (const f of manifest.folders || []) {
      const nid = idMap.folders.get(f.id);
      const pid = f.parent_id ? idMap.folders.get(f.parent_id) : null;
      d.prepare(`UPDATE folders SET parent_id=? WHERE id=?`).run(pid || null, nid);
    }

    for (const t of manifest.tags || []) {
      const nid = randomId('tag');
      idMap.tags.set(t.id, nid);
      d.prepare(`INSERT INTO tags(id,workspace_id,name,color,created_by,created_at) VALUES(?,?,?,?,?,?)`)
        .run(nid, newWsId, t.name, t.color || '', userId, now);
    }

    for (const f of manifest.files || []) {
      const nid = randomId('file');
      idMap.files.set(f.id, nid);
      d.prepare(`INSERT INTO files(id,workspace_id,folder_id,name,ext,mime,size,storage_key,checksum,encrypted,
                 private_flag,tags,starred,pinned,created_by,updated_by,created_at,updated_at,deleted_at,version,
                 view_count,download_count,preview_kind,acl_level)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,0,0,?,'inherit')`)
        .run(nid, newWsId, f.folder_id ? idMap.folders.get(f.folder_id) : null, f.name, f.ext, f.mime,
          f.size, `${newWsId}/${path.basename(f.storage_key)}`, f.checksum || '', f.encrypted || 0, 0,
          f.tags || '[]', f.starred || 0, f.pinned || 0, userId, userId, f.created_at || now, now,
          f.version || 1, f.preview_kind || 'none');
    }

    for (const n of manifest.notes || []) {
      const nid = randomId('note');
      idMap.notes.set(n.id, nid);
      d.prepare(`INSERT INTO notes(id,workspace_id,folder_id,title,html,text,summary,emoji,tags,starred,pinned,
                 created_by,updated_by,created_at,updated_at,deleted_at,version,word_count,view_count)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,0)`)
        .run(nid, newWsId, n.folder_id ? idMap.folders.get(n.folder_id) : null, n.title, n.html, n.text,
          n.summary || '', n.emoji || '', n.tags || '[]', n.starred || 0, n.pinned || 0,
          userId, userId, n.created_at || now, now, n.version || 1, n.word_count || 0);
    }
  });

  // 落盘文件
  let filesWritten = 0;
  for (const s of staged) {
    const rel = safeArchiveName(s.entry.name.slice('files/'.length));
    const dest = path.join(FILES_DIR, newWsId, path.basename(rel));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, s.data);
    filesWritten++;
  }
  // 修正 storage_key（保持与磁盘一致）
  for (const [oldId, newId] of idMap.files) {
    const old = (manifest.files || []).find((f) => f.id === oldId);
    if (!old) continue;
    const key = `${newWsId}/${path.basename(old.storage_key)}`;
    run(`UPDATE files SET storage_key=? WHERE id=?`, key, newId);
  }

  // 重新建立检索索引
  const { processFile } = await import('./pipeline.js');
  for (const [, newId] of idMap.files) {
    try { await processFile(newId, { force: true }); } catch { /* */ }
  }
  for (const [oldId, newId] of idMap.notes) {
    const note = get(`SELECT * FROM notes WHERE id=?`, newId);
    const { indexEntity } = await import('../db.js');
    const { tokenize } = await import('./text.js');
    if (note) indexEntity('note', newId, newWsId, tokenize(`${note.title}\n${note.title}\n${note.text}`));
  }

  return {
    mode: 'workspace-import',
    workspaceId: newWsId,
    workspaceName: `${oldWs.name}（导入）`,
    counts: { files: idMap.files.size, notes: idMap.notes.size, folders: idMap.folders.size, tags: idMap.tags.size, filesWritten }
  };
}

/* ------------------------------------------------------------------ 导出 */

/**
 * 导出知识库为 ZIP（可读形式：Markdown + 原始文件 + 结构化清单）
 */
export async function exportWorkspace(workspaceId, { includeFiles = true, userId } = {}) {
  const ws = get(`SELECT * FROM workspaces WHERE id=?`, workspaceId);
  if (!ws) throw new Error('知识库不存在');
  const folders = all(`SELECT * FROM folders WHERE workspace_id=? AND deleted_at IS NULL`, workspaceId);
  const files = all(`SELECT * FROM files WHERE workspace_id=? AND deleted_at IS NULL`, workspaceId);
  const notes = all(`SELECT * FROM notes WHERE workspace_id=? AND deleted_at IS NULL`, workspaceId);
  const tags = all(`SELECT * FROM tags WHERE workspace_id=?`, workspaceId);
  const folderPath = (id) => {
    const parts = [];
    let cur = id;
    let guard = 0;
    while (cur && guard++ < 20) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      parts.unshift(f.name.replace(/[\\/:*?"<>|]/g, '_'));
      cur = f.parent_id;
    }
    return parts.join('/');
  };

  const entries = [];
  const safeWsName = ws.name.replace(/[\\/:*?"<>|]/g, '_');

  entries.push({
    name: 'README.md',
    data: `# ${ws.name}\n\n> 由 KBPRO 导出 · ${nowIso()}\n\n` +
      `- 类型：${ws.kind === 'team' ? '团队知识库' : '个人知识库'}\n` +
      `- 文件：${files.length} 个\n- 笔记：${notes.length} 个\n- 文件夹：${folders.length} 个\n- 标签：${tags.length} 个\n\n` +
      `## 目录结构\n\n\`\`\`\n${folders.map((f) => `${folderPath(f.id)}/`).join('\n')}\n\`\`\`\n`
  });

  entries.push({
    name: 'manifest.json',
    data: JSON.stringify({
      product: 'KBPRO', exportedAt: nowIso(), workspace: ws,
      folders, tags,
      files: files.map((f) => ({ id: f.id, name: f.name, folder: f.folder_id ? folderPath(f.folder_id) : '/', ext: f.ext, size: f.size, tags: f.tags, createdAt: f.created_at })),
      notes: notes.map((n) => ({ id: n.id, title: n.title, folder: n.folder_id ? folderPath(n.folder_id) : '/', tags: n.tags, wordCount: n.word_count, updatedAt: n.updated_at }))
    }, null, 2)
  });

  for (const n of notes) {
    const dir = n.folder_id ? folderPath(n.folder_id) : '笔记';
    entries.push({
      name: `${safeWsName}/笔记/${dir}/${sanitizeSegment(n.title)}.md`,
      data: `# ${n.title}\n\n> 标签：${(JSON.parse(n.tags || '[]')).join(' · ') || '无'} · 版本 v${n.version} · 更新于 ${n.updated_at}\n\n${n.text}`
    });
    if (n.html) {
      entries.push({
        name: `${safeWsName}/笔记/${dir}/${sanitizeSegment(n.title)}.html`,
        data: `<!doctype html><meta charset="utf-8"><title>${n.title}</title><body>${n.html}</body>`
      });
    }
  }

  for (const f of files) {
    const dir = f.folder_id ? folderPath(f.folder_id) : '未分类';
    const text = get(`SELECT text FROM file_text WHERE file_id=?`, f.id);
    if (text?.text) {
      entries.push({
        name: `${safeWsName}/文本提取/${dir}/${sanitizeSegment(f.name)}.txt`,
        data: text.text
      });
    }
    if (includeFiles) {
      try {
        const data = await fsp.readFile(absoluteStoragePath(f.storage_key));
        entries.push({ name: `${safeWsName}/原始文件/${dir}/${sanitizeSegment(f.name)}`, data, mtime: new Date(f.updated_at) });
      } catch { /* 文件缺失则跳过 */ }
    }
  }

  const zip = createZip(entries);
  return { buffer: zip, name: `${safeWsName}-${timestampName('', 'zip').replace(/^-/, '')}`, entries: entries.length };
}

function sanitizeSegment(s) {
  return String(s || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

export { DB_PATH, DATA_DIR, BACKUP_DIR };
