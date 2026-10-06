/**
 * KBPRO — 标签与文件夹服务
 */
import { all, get, run, insert, update, tx, nowIso } from '../db.js';
import { randomId } from './crypto.js';
import { normalizeTags } from './text.js';
import { httpError } from './http.js';

/* ------------------------------------------------------------------ 标签 */

/**
 * 同步实体标签（同时维护 tags 表与 entity_tags 关联表，并回写 JSON 列）
 */
export function syncTags(workspaceId, entityType, entityId, tags, userId) {
  const list = normalizeTags(tags);
  tx((d) => {
    d.prepare(`DELETE FROM entity_tags WHERE entity_type=? AND entity_id=?`).run(entityType, entityId);
    const findTag = d.prepare(`SELECT * FROM tags WHERE workspace_id=? AND name=?`);
    const insTag = d.prepare(`INSERT INTO tags(id,workspace_id,name,color,created_by,created_at) VALUES(?,?,?,?,?,?)`);
    const link = d.prepare(`INSERT OR IGNORE INTO entity_tags(tag_id,entity_type,entity_id,workspace_id) VALUES(?,?,?,?)`);
    for (const name of list) {
      let tag = findTag.get(workspaceId, name);
      if (!tag) {
        const id = randomId('tag');
        insTag.run(id, workspaceId, name, '', userId || null, nowIso());
        tag = { id, name };
      }
      link.run(tag.id, entityType, entityId, workspaceId);
    }
  });
  return list;
}

export function cleanupOrphanTags(workspaceId) {
  run(
    `DELETE FROM tags WHERE workspace_id=? AND id NOT IN (SELECT tag_id FROM entity_tags)`,
    workspaceId
  );
}

export function workspaceTags(workspaceId) {
  return all(
    `SELECT t.id, t.name, t.color,
            (SELECT COUNT(*) FROM entity_tags et WHERE et.tag_id=t.id AND et.entity_type='file') AS file_count,
            (SELECT COUNT(*) FROM entity_tags et WHERE et.tag_id=t.id AND et.entity_type='note') AS note_count
       FROM tags t WHERE t.workspace_id=? ORDER BY t.name`,
    workspaceId
  ).map((r) => ({
    id: r.id, name: r.name, color: r.color || '',
    fileCount: Number(r.file_count || 0), noteCount: Number(r.note_count || 0),
    count: Number(r.file_count || 0) + Number(r.note_count || 0)
  }));
}

export function renameTag(userId, tagId, name) {
  const tag = get(`SELECT * FROM tags WHERE id=?`, tagId);
  if (!tag) throw httpError(404, '标签不存在');
  const clean = normalizeTags([name])[0];
  if (!clean) throw httpError(400, '标签名不能为空');
  const dup = get(`SELECT id FROM tags WHERE workspace_id=? AND name=? AND id<>?`, tag.workspace_id, clean, tagId);
  if (dup) throw httpError(409, '同名标签已存在');
  const rows = all(`SELECT entity_type, entity_id FROM entity_tags WHERE tag_id=?`, tagId);
  tx((d) => {
    d.prepare(`UPDATE tags SET name=? WHERE id=?`).run(clean, tagId);
    for (const r of rows) {
      const table = r.entity_type === 'file' ? 'files' : 'notes';
      const row = d.prepare(`SELECT tags FROM ${table} WHERE id=?`).get(r.entity_id);
      if (!row) continue;
      let list = [];
      try { list = JSON.parse(row.tags || '[]'); } catch { list = []; }
      if (!Array.isArray(list) || !list.length) continue;
      const next = list.map((x) => (String(x).toLowerCase() === String(tag.name).toLowerCase() ? clean : x));
      d.prepare(`UPDATE ${table} SET tags=? WHERE id=?`).run(JSON.stringify(next), r.entity_id);
    }
  });
  return get(`SELECT * FROM tags WHERE id=?`, tagId);
}

export function deleteTag(userId, tagId) {
  const tag = get(`SELECT * FROM tags WHERE id=?`, tagId);
  if (!tag) throw httpError(404, '标签不存在');
  const rows = all(`SELECT entity_type, entity_id FROM entity_tags WHERE tag_id=?`, tagId);
  tx((d) => {
    d.prepare(`DELETE FROM entity_tags WHERE tag_id=?`).run(tagId);
    d.prepare(`DELETE FROM tags WHERE id=?`).run(tagId);
    for (const r of rows) {
      const table = r.entity_type === 'file' ? 'files' : 'notes';
      const row = d.prepare(`SELECT tags FROM ${table} WHERE id=?`).get(r.entity_id);
      if (!row) continue;
      let list = [];
      try { list = JSON.parse(row.tags || '[]'); } catch { list = []; }
      const next = list.filter((x) => String(x).toLowerCase() !== String(tag.name).toLowerCase());
      d.prepare(`UPDATE ${table} SET tags=? WHERE id=?`).run(JSON.stringify(next), r.entity_id);
    }
  });
  return true;
}

/* ------------------------------------------------------------------ 文件夹 */

export function folderTree(workspaceId) {
  const rows = all(
    `SELECT f.*,
            (SELECT COUNT(*) FROM files fi WHERE fi.folder_id=f.id AND fi.deleted_at IS NULL) AS file_count,
            (SELECT COUNT(*) FROM notes n WHERE n.folder_id=f.id AND n.deleted_at IS NULL) AS note_count
       FROM folders f
      WHERE f.workspace_id=? AND f.deleted_at IS NULL
      ORDER BY f.sort_order, f.name`,
    workspaceId
  );
  const nodes = new Map();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id, name: r.name, parentId: r.parent_id, path: r.path,
      color: r.color || '', icon: r.icon || '', sortOrder: Number(r.sort_order || 0),
      createdAt: r.created_at, updatedAt: r.updated_at,
      fileCount: Number(r.file_count || 0), noteCount: Number(r.note_count || 0),
      totalCount: Number(r.file_count || 0) + Number(r.note_count || 0),
      children: []
    });
  }
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  const sortRec = (list) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  // 自底向上汇总计数
  const rollup = (node) => {
    let f = node.fileCount;
    let n = node.noteCount;
    for (const c of node.children) {
      const sub = rollup(c);
      f += sub.files;
      n += sub.notes;
    }
    node.totalCount = f + n;
    node.totalFileCount = f;
    node.totalNoteCount = n;
    return { files: f, notes: n };
  };
  for (const r of roots) rollup(r);

  return { tree: roots, flat: [...nodes.values()] };
}

export function folderDepthAndPath(folderId) {
  const parts = [];
  let cur = folderId;
  let guard = 0;
  while (cur && guard++ < 40) {
    const row = get(`SELECT id, name, parent_id FROM folders WHERE id=?`, cur);
    if (!row) break;
    parts.unshift(row.name);
    cur = row.parent_id;
  }
  return parts;
}

export function refreshFolderPaths(workspaceId) {
  const { flat } = folderTree(workspaceId);
  const byId = new Map(flat.map((f) => [f.id, f]));
  const build = (node) => {
    const parts = [];
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 40) {
      parts.unshift(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    const p = '/' + parts.join('/');
    run(`UPDATE folders SET path=? WHERE id=?`, p, node.id);
  };
  for (const f of flat) build(f);
}

export function isDescendant(workspaceId, candidateId, ancestorId) {
  if (!candidateId || !ancestorId) return false;
  if (candidateId === ancestorId) return true;
  let cur = candidateId;
  let guard = 0;
  while (cur && guard++ < 50) {
    const row = get(`SELECT parent_id FROM folders WHERE id=?`, cur);
    if (!row) return false;
    if (row.parent_id === ancestorId) return true;
    cur = row.parent_id;
  }
  return false;
}

export function createFolder({ workspaceId, parentId, name, icon, color, createdBy }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw httpError(400, '文件夹名称不能为空');
  if (parentId) {
    const parent = get(`SELECT * FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, parentId, workspaceId);
    if (!parent) throw httpError(404, '父文件夹不存在');
  }
  const dup = get(
    `SELECT id FROM folders WHERE workspace_id=? AND deleted_at IS NULL AND name=? AND IFNULL(parent_id,'')=IFNULL(?,'')`,
    workspaceId, clean, parentId ?? null
  );
  if (dup) throw httpError(409, '同级下已存在同名文件夹');
  const now = nowIso();
  const id = randomId('fld');
  const maxOrder = Number(get(`SELECT MAX(sort_order) AS m FROM folders WHERE workspace_id=? AND IFNULL(parent_id,'')=IFNULL(?,'')`, workspaceId, parentId ?? null)?.m || 0);
  insert('folders', {
    id, workspace_id: workspaceId, parent_id: parentId ?? null, name: clean,
    path: '/', color: color || '', icon: icon || 'folder',
    sort_order: maxOrder + 1, created_by: createdBy, created_at: now, updated_at: now, deleted_at: null
  });
  refreshFolderPaths(workspaceId);
  return get(`SELECT * FROM folders WHERE id=?`, id);
}

export function moveFolder({ workspaceId, folderId, targetParentId }) {
  const folder = get(`SELECT * FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, folderId, workspaceId);
  if (!folder) throw httpError(404, '文件夹不存在');
  if (targetParentId) {
    const target = get(`SELECT * FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, targetParentId, workspaceId);
    if (!target) throw httpError(404, '目标文件夹不存在');
    if (isDescendant(workspaceId, targetParentId, folderId)) throw httpError(400, '不能把文件夹移动到它自己的子目录中');
  }
  update('folders', folderId, { parent_id: targetParentId ?? null, updated_at: nowIso() });
  refreshFolderPaths(workspaceId);
  return get(`SELECT * FROM folders WHERE id=?`, folderId);
}

/** 递归删除文件夹（含子文件夹），并处理内部文件 */
export function deleteFolder({ workspaceId, folderId, mode = 'move-to-root' }) {
  const folder = get(`SELECT * FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, folderId, workspaceId);
  if (!folder) throw httpError(404, '文件夹不存在');

  const descendants = collectDescendants(workspaceId, folderId);
  const ids = [folderId, ...descendants];
  const ph = ids.map(() => '?').join(',');
  const now = nowIso();

  if (mode === 'cascade') {
    run(`UPDATE files SET deleted_at=? WHERE workspace_id=? AND folder_id IN (${ph}) AND deleted_at IS NULL`, now, workspaceId, ...ids);
    run(`UPDATE notes SET deleted_at=? WHERE workspace_id=? AND folder_id IN (${ph}) AND deleted_at IS NULL`, now, workspaceId, ...ids);
  } else {
    run(`UPDATE files SET folder_id=NULL WHERE workspace_id=? AND folder_id IN (${ph})`, workspaceId, ...ids);
    run(`UPDATE notes SET folder_id=NULL WHERE workspace_id=? AND folder_id IN (${ph})`, workspaceId, ...ids);
  }
  run(`UPDATE folders SET deleted_at=? WHERE workspace_id=? AND id IN (${ph})`, now, workspaceId, ...ids);
  cleanupOrphanTags(workspaceId);
  return { removed: ids.length, mode };
}

function collectDescendants(workspaceId, rootId) {
  const out = [];
  const stack = [rootId];
  let guard = 0;
  while (stack.length && guard++ < 5000) {
    const cur = stack.pop();
    const children = all(`SELECT id FROM folders WHERE workspace_id=? AND parent_id=? AND deleted_at IS NULL`, workspaceId, cur);
    for (const c of children) {
      out.push(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

/** 面包屑 */
export function breadcrumb(folderId) {
  const out = [];
  let cur = folderId;
  let guard = 0;
  while (cur && guard++ < 40) {
    const row = get(`SELECT id, name, parent_id, icon FROM folders WHERE id=?`, cur);
    if (!row) break;
    out.unshift({ id: row.id, name: row.name, icon: row.icon || '' });
    cur = row.parent_id;
  }
  return out;
}

export { get, all, run, insert, update, tx };
