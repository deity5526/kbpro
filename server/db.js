/**
 * KBPRO — 数据层
 *  基于 Node.js 内置 `node:sqlite`（零外部依赖）。
 *  包含：连接管理、事务、Schema 迁移、BM25 倒排表维护、审计日志。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, ensureDirs } from './config.js';

/* ------------------------------------------------------------------ 工具 */

export function nowIso() {
  return new Date().toISOString();
}

export function isoPlusDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

/** node:sqlite 只接受 null/number/bigint/string/Uint8Array */
export function normalizeBind(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function bindAll(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0])) {
    const obj = params[0];
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = normalizeBind(v);
    return out;
  }
  return params.map(normalizeBind);
}

/* ------------------------------------------------------------------ Schema */

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',
  avatar         TEXT DEFAULT '',
  title          TEXT DEFAULT '',
  bio            TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active',
  settings       TEXT NOT NULL DEFAULT '{}',
  ai_provider    TEXT DEFAULT '',
  ai_model       TEXT DEFAULT '',
  ai_base_url    TEXT DEFAULT '',
  ai_key_enc     TEXT DEFAULT '',
  storage_used   INTEGER NOT NULL DEFAULT 0,
  storage_quota  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_login_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT DEFAULT '',
  ua         TEXT DEFAULT '',
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  owner_id    TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'team',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer',
  status     TEXT NOT NULL DEFAULT 'active',
  invited_by TEXT,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'personal',
  owner_id    TEXT NOT NULL,
  team_id     TEXT,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#1F2937',
  icon        TEXT DEFAULT 'folder',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id, kind);

CREATE TABLE IF NOT EXISTS folders (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_id    TEXT,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL DEFAULT '/',
  color        TEXT DEFAULT '',
  icon         TEXT DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_folders_ws ON folders(workspace_id, parent_id);

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  folder_id      TEXT,
  name           TEXT NOT NULL,
  ext            TEXT DEFAULT '',
  mime           TEXT DEFAULT 'application/octet-stream',
  size           INTEGER NOT NULL DEFAULT 0,
  storage_key    TEXT NOT NULL,
  checksum       TEXT DEFAULT '',
  encrypted      INTEGER NOT NULL DEFAULT 0,
  private_flag   INTEGER NOT NULL DEFAULT 0,
  tags           TEXT NOT NULL DEFAULT '[]',
  starred        INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT,
  updated_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  view_count     INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  preview_kind   TEXT DEFAULT 'none',
  acl_level      TEXT NOT NULL DEFAULT 'inherit'
);
CREATE INDEX IF NOT EXISTS idx_files_ws ON files(workspace_id, folder_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_updated ON files(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS file_text (
  file_id     TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT DEFAULT '',
  page_count  INTEGER NOT NULL DEFAULT 0,
  chars       INTEGER NOT NULL DEFAULT 0,
  meta        TEXT NOT NULL DEFAULT '{}',
  engine      TEXT DEFAULT '',
  extract_ms  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_text_status ON file_text(status);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  heading      TEXT DEFAULT '',
  page         INTEGER DEFAULT 0,
  text         TEXT NOT NULL,
  chars        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL,
  model    TEXT NOT NULL DEFAULT 'local-hash-512'
);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  folder_id    TEXT,
  title        TEXT NOT NULL DEFAULT '未命名笔记',
  html         TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL DEFAULT '',
  summary      TEXT DEFAULT '',
  emoji        TEXT DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',
  starred      INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  word_count   INTEGER NOT NULL DEFAULT 0,
  view_count   INTEGER NOT NULL DEFAULT 0,
  acl_level    TEXT NOT NULL DEFAULT 'inherit'
);
CREATE INDEX IF NOT EXISTS idx_notes_ws ON notes(workspace_id, folder_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS note_versions (
  id        TEXT PRIMARY KEY,
  note_id   TEXT NOT NULL,
  version   INTEGER NOT NULL,
  title     TEXT NOT NULL,
  html      TEXT NOT NULL,
  text      TEXT NOT NULL,
  editor_id TEXT,
  summary   TEXT DEFAULT '',
  chars     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_versions ON note_versions(note_id, version DESC);

CREATE TABLE IF NOT EXISTS tags (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT DEFAULT '',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS entity_tags (
  tag_id      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (tag_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS shares (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  grantee_type   TEXT NOT NULL DEFAULT 'user',
  grantee_id     TEXT,
  permission     TEXT NOT NULL DEFAULT 'view',
  token          TEXT UNIQUE,
  expires_at     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_resource ON shares(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_type, grantee_id);

CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  body          TEXT NOT NULL,
  parent_id     TEXT,
  resolved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_resource ON comments(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS chats (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '新对话',
  scope        TEXT NOT NULL DEFAULT 'workspace',
  scope_id     TEXT,
  provider     TEXT DEFAULT '',
  model        TEXT DEFAULT '',
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  citations  TEXT NOT NULL DEFAULT '[]',
  provider   TEXT DEFAULT '',
  model      TEXT DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  feedback   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS ai_outputs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  file_id      TEXT,
  note_id      TEXT,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  provider     TEXT DEFAULT '',
  model        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'ok',
  error        TEXT DEFAULT '',
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_outputs_target ON ai_outputs(file_id, kind);

CREATE TABLE IF NOT EXISTS relations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_type    TEXT NOT NULL,
  from_id      TEXT NOT NULL,
  to_type      TEXT NOT NULL,
  to_id        TEXT NOT NULL,
  score        REAL NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'auto',
  created_at   TEXT NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_type, from_id);

CREATE TABLE IF NOT EXISTS access_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT,
  user_id       TEXT,
  user_name     TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT DEFAULT '',
  resource_id   TEXT DEFAULT '',
  resource_name TEXT DEFAULT '',
  permission    TEXT DEFAULT '',
  ip            TEXT DEFAULT '',
  ua            TEXT DEFAULT '',
  detail        TEXT DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_logs_time ON access_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_ws ON access_logs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'full',
  encrypted  INTEGER NOT NULL DEFAULT 0,
  scope      TEXT DEFAULT '',
  created_by TEXT,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  id            TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  holder_name   TEXT DEFAULT '',
  acquired_at   TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  link       TEXT DEFAULT '',
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

/* -------- BM25 倒排索引（DB 持久化，无需重建） -------- */

CREATE TABLE IF NOT EXISTS postings (
  term        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  tf          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_postings_entity ON postings(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS term_df (
  term TEXT PRIMARY KEY,
  df   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS doc_stats (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  len         INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_stats_ws ON doc_stats(workspace_id, entity_type);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

/* -------- 笔记内嵌资源（图片等） -------- */

CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  note_id      TEXT,
  user_id      TEXT,
  name         TEXT NOT NULL DEFAULT '',
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL DEFAULT 0,
  storage_key  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_note ON assets(note_id);
`;

/* ------------------------------------------------------------------ 连接 */

let db = null;

/** 轻量迁移：为既有数据库补齐后加的列（幂等） */
const REQUIRED_COLUMNS = [
  ['files', 'acl_level', `TEXT NOT NULL DEFAULT 'inherit'`],
  ['files', 'private_flag', `INTEGER NOT NULL DEFAULT 0`],
  ['files', 'preview_kind', `TEXT DEFAULT 'none'`],
  ['files', 'view_count', `INTEGER NOT NULL DEFAULT 0`],
  ['files', 'download_count', `INTEGER NOT NULL DEFAULT 0`],
  ['notes', 'acl_level', `TEXT NOT NULL DEFAULT 'inherit'`],
  ['notes', 'view_count', `INTEGER NOT NULL DEFAULT 0`],
  ['notes', 'summary', `TEXT DEFAULT ''`],
  ['notes', 'emoji', `TEXT DEFAULT ''`],
  ['workspaces', 'icon', `TEXT DEFAULT 'folder'`],
  ['workspaces', 'color', `TEXT DEFAULT '#1F2937'`],
  ['chats', 'pinned', `INTEGER NOT NULL DEFAULT 0`],
  ['messages', 'feedback', `INTEGER NOT NULL DEFAULT 0`],
  ['file_text', 'engine', `TEXT DEFAULT ''`],
  ['file_text', 'extract_ms', `INTEGER NOT NULL DEFAULT 0`],
  ['chunk_vectors', 'model', `TEXT NOT NULL DEFAULT 'local-hash-512'`]
];

function migrateColumns(d) {
  for (const [table, column, ddl] of REQUIRED_COLUMNS) {
    try {
      const info = d.prepare(`PRAGMA table_info(${table})`).all();
      if (!info.length) continue;
      if (info.some((c) => c.name === column)) continue;
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch {
      /* 该表可能尚不存在，忽略 */
    }
  }
}

export function getDb() {
  if (db) return db;
  ensureDirs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA_SQL);
  migrateColumns(db);
  const current = Number(db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()?.value || 0);
  if (current !== SCHEMA_VERSION) {
    db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(SCHEMA_VERSION));
  }
  db.prepare(`INSERT INTO meta(key,value) VALUES('bootstrapped_at',?)
              ON CONFLICT(key) DO NOTHING`).run(nowIso());
  return db;
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

/* ------------------------------------------------------------------ 查询封装 */

export function run(sql, ...params) {
  return getDb().prepare(sql).run(...bindAll(params));
}

export function get(sql, ...params) {
  return getDb().prepare(sql).get(...bindAll(params)) ?? null;
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...bindAll(params));
}

/** 取单列单值 */
export function scalar(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

export function insert(table, data) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  const cols = entries.map(([k]) => k);
  const placeholders = cols.map(() => '?').join(',');
  const values = entries.map(([, v]) => normalizeBind(v));
  getDb().prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`).run(...values);
  return data;
}

export function update(table, id, data, idCol = 'id') {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (!entries.length) return 0;
  const sets = entries.map(([k]) => `"${k}" = ?`).join(', ');
  const values = entries.map(([, v]) => normalizeBind(v));
  const res = getDb().prepare(`UPDATE ${table} SET ${sets} WHERE "${idCol}" = ?`).run(...values, normalizeBind(id));
  return Number(res.changes || 0);
}

/** 事务包装（支持嵌套：内层复用外层事务） */
let txDepth = 0;

export function tx(fn) {
  const d = getDb();
  if (txDepth > 0) {
    txDepth++;
    try { return fn(d); } finally { txDepth--; }
  }
  d.exec('BEGIN');
  txDepth = 1;
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    txDepth = 0;
  }
}

/* ------------------------------------------------------------------ 设置项 */

export function getSetting(key, fallback = null) {
  const row = get(`SELECT value FROM settings WHERE key=?`, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  run(`INSERT INTO settings(key,value) VALUES(?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, JSON.stringify(value ?? null));
}

/* ------------------------------------------------------------------ BM25 倒排维护 */

/**
 * 写入某实体的倒排索引（全量替换该实体）。
 * @param {'file'|'note'|'chunk'} entityType
 */
export function indexEntity(entityType, entityId, workspaceId, tokens) {
  tx((d) => {
    const old = d.prepare(`SELECT term, tf FROM postings WHERE entity_type=? AND entity_id=?`).all(entityType, entityId);
    const dec = d.prepare(`UPDATE term_df SET df = df - 1 WHERE term=?`);
    const cleanup = d.prepare(`DELETE FROM term_df WHERE term=? AND df <= 0`);
    for (const row of old) {
      dec.run(row.term);
      cleanup.run(row.term);
    }
    d.prepare(`DELETE FROM postings WHERE entity_type=? AND entity_id=?`).run(entityType, entityId);

    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    const insPost = d.prepare(`INSERT INTO postings(term,entity_type,entity_id,tf) VALUES(?,?,?,?)
                               ON CONFLICT(term,entity_type,entity_id) DO UPDATE SET tf=excluded.tf`);
    const upsertDf = d.prepare(`INSERT INTO term_df(term,df) VALUES(?,1)
                                ON CONFLICT(term) DO UPDATE SET df = df + 1`);
    for (const [term, count] of tf) {
      insPost.run(term, entityType, entityId, count);
      upsertDf.run(term);
    }

    d.prepare(`INSERT INTO doc_stats(entity_type,entity_id,workspace_id,len,updated_at) VALUES(?,?,?,?,?)
               ON CONFLICT(entity_type,entity_id) DO UPDATE SET len=excluded.len, workspace_id=excluded.workspace_id, updated_at=excluded.updated_at`)
      .run(entityType, entityId, workspaceId || '', tokens.length, nowIso());
  });
}

export function removeEntityIndex(entityType, entityId) {
  tx((d) => {
    const old = d.prepare(`SELECT term FROM postings WHERE entity_type=? AND entity_id=?`).all(entityType, entityId);
    const dec = d.prepare(`UPDATE term_df SET df = df - 1 WHERE term=?`);
    const cleanup = d.prepare(`DELETE FROM term_df WHERE term=? AND df <= 0`);
    for (const row of old) {
      dec.run(row.term);
      cleanup.run(row.term);
    }
    d.prepare(`DELETE FROM postings WHERE entity_type=? AND entity_id=?`).run(entityType, entityId);
    d.prepare(`DELETE FROM doc_stats WHERE entity_type=? AND entity_id=?`).run(entityType, entityId);
  });
}

/** 语料统计（供 BM25 使用） */
export function corpusStats(entityType) {
  const row = get(`SELECT COUNT(*) AS n, AVG(len) AS avgdl FROM doc_stats WHERE entity_type=?`, entityType);
  return { n: Number(row?.n || 0), avgdl: Number(row?.avgdl || 1) || 1 };
}

/** 一次性取多个词条的 df */
export function termDf(terms) {
  if (!terms.length) return new Map();
  const out = new Map();
  const stmt = getDb().prepare(`SELECT term, df FROM term_df WHERE term=?`);
  for (const t of terms) {
    const row = stmt.get(String(t));
    if (row) out.set(t, Number(row.df));
  }
  return out;
}

/** 取某词条命中的实体与 tf */
export function postingsFor(term, entityType, limit = 5000) {
  return all(`SELECT entity_id, tf FROM postings WHERE term=? AND entity_type=? LIMIT ?`, String(term), entityType, limit);
}

/** 批量取多个词条命中，合并后返回 Map<entityId, Map<term, tf>> */
export function postingsForTerms(terms, entityType, limit = 5000) {
  const out = new Map();
  if (!terms.length) return out;
  const stmt = getDb().prepare(`SELECT entity_id, tf FROM postings WHERE term=? AND entity_type=? LIMIT ?`);
  for (const t of terms) {
    const rows = stmt.all(String(t), entityType, limit);
    for (const r of rows) {
      let m = out.get(r.entity_id);
      if (!m) { m = new Map(); out.set(r.entity_id, m); }
      m.set(t, Number(r.tf));
    }
  }
  return out;
}

export function docLen(entityType, entityId) {
  const row = get(`SELECT len FROM doc_stats WHERE entity_type=? AND entity_id=?`, entityType, entityId);
  return Number(row?.len || 1) || 1;
}

export function docLens(entityType, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const stmt = getDb().prepare(`SELECT len FROM doc_stats WHERE entity_type=? AND entity_id=?`);
  for (const id of ids) {
    const row = stmt.get(entityType, id);
    out.set(id, Number(row?.len || 1) || 1);
  }
  return out;
}

/* ------------------------------------------------------------------ 审计 */

export function audit(entry) {
  try {
    insert('access_logs', {
      workspace_id: entry.workspaceId ?? null,
      user_id: entry.userId ?? null,
      user_name: entry.userName ?? '',
      action: entry.action,
      resource_type: entry.resourceType ?? '',
      resource_id: entry.resourceId ?? '',
      resource_name: entry.resourceName ?? '',
      permission: entry.permission ?? '',
      ip: entry.ip ?? '',
      ua: entry.ua ?? '',
      detail: entry.detail ? String(entry.detail).slice(0, 500) : '',
      created_at: nowIso()
    });
  } catch {
    /* 审计失败不应影响主流程 */
  }
}

/* ------------------------------------------------------------------ 健康/统计 */

export function dbSizeBytes() {
  try {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const p = DB_PATH + suffix;
      if (fs.existsSync(p)) total += fs.statSync(p).size;
    }
    return total;
  } catch {
    return 0;
  }
}

export function tableCounts() {
  const tables = ['users', 'workspaces', 'folders', 'files', 'notes', 'note_versions', 'chunks',
    'shares', 'comments', 'chats', 'messages', 'access_logs', 'backups', 'tags', 'team_members'];
  const out = {};
  for (const t of tables) {
    try { out[t] = Number(scalar(`SELECT COUNT(*) FROM ${t}`) || 0); } catch { out[t] = 0; }
  }
  return out;
}
