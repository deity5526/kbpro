/**
 * KBPRO — 账号注销
 *
 * 语义（按"用户主动注销"的常识来定）：
 *   1. 该用户独占的数据真正删掉：个人知识库、以及"只有他一个人的团队"所拥有的知识库，
 *      连同其下的文件夹、文件（磁盘 + 检索索引）、笔记（含历史版本）、标签、
 *      会话记录一起清理，磁盘空间随之外释放；
 *   2. 团队知识库属于团队资产，不随个人注销删除，只解除成员关系；
 *   3. 用户记录本身保留主键并做匿名化，保证审计日志、评论等历史记录仍然能追溯到
 *      "已注销用户"，不会出现悬空引用；
 *   4. 会话全部作废 —— authenticate() 会因为 status !== 'active' 直接拒绝，
 *      所以注销后所有设备上的登录态立即失效。
 *
 * 注销前必须先处理"还有其他成员的团队"：否则团队会失去所有者。
 */
import { all, tx, nowIso, scalar, removeEntityIndex } from '../db.js';
import { httpError } from './http.js';
import { deleteStored } from './storage.js';
import { removeFileIndex } from './rag.js';
import { hashPassword, randomId } from './crypto.js';

/** 团队中除该用户外是否还有活跃成员 */
function hasOtherMembers(teamId, userId) {
  return Number(scalar(
    `SELECT COUNT(*) FROM team_members WHERE team_id=? AND user_id<>? AND status='active'`,
    teamId, userId
  ) || 0) > 0;
}

/**
 * 注销前的阻断检查。返回不能注销的原因列表（为空表示可以注销）。
 * @returns {string[]}
 */
export function accountDeletionBlockers(userId) {
  const owned = all(`SELECT id, name FROM teams WHERE owner_id=?`, userId);
  return owned.filter((t) => hasOtherMembers(t.id, userId)).map((t) => t.name);
}

/**
 * 执行注销。调用方负责先校验密码。
 * @returns {Promise<{workspaces:number, files:number, notes:number, teams:number}>}
 */
export async function deleteAccount(user) {
  const blockers = accountDeletionBlockers(user.id);
  if (blockers.length) {
    throw httpError(400, `你还是团队「${blockers.join('、')}」的所有者且团队中还有其他成员，请先转让团队所有权再注销`);
  }

  // 只属于该用户、没有其他成员的团队
  const ownedTeams = all(`SELECT id, name FROM teams WHERE owner_id=?`, user.id)
    .filter((t) => !hasOtherMembers(t.id, user.id));
  const teamIds = ownedTeams.map((t) => t.id);

  const personalWs = all(`SELECT id FROM workspaces WHERE owner_id=? AND kind='personal'`, user.id).map((r) => r.id);
  const teamWs = teamIds.length
    ? all(`SELECT id FROM workspaces WHERE team_id IN (${teamIds.map(() => '?').join(',')})`, ...teamIds).map((r) => r.id)
    : [];
  const wsIds = [...new Set([...personalWs, ...teamWs])];

  // 不注销任何知识库时，仍然要继续走下面的匿名化与团队清理
  const ph = wsIds.length ? wsIds.map(() => '?').join(',') : `''`;

  const files = all(`SELECT id, storage_key FROM files WHERE workspace_id IN (${ph})`, ...wsIds);
  const notes = all(`SELECT id FROM notes WHERE workspace_id IN (${ph})`, ...wsIds);
  const chunkIds = all(`SELECT id FROM chunks WHERE workspace_id IN (${ph})`, ...wsIds).map((r) => r.id);
  const chatIds = all(`SELECT id FROM chats WHERE workspace_id IN (${ph})`, ...wsIds).map((r) => r.id);

  // ---- 磁盘与检索索引：IO 不进事务，失败也不阻断注销 ----
  for (const f of files) {
    try { await deleteStored(f.storage_key); } catch { /* 文件可能已不在 */ }
  }
  for (const f of files) {
    try { removeFileIndex(f.id); } catch { /* 索引可能不存在 */ }
  }
  for (const n of notes) {
    try { removeEntityIndex('note', n.id); } catch { /* 同上 */ }
  }

  tx((d) => {
    if (chunkIds.length) {
      const cph = chunkIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM chunk_vectors WHERE chunk_id IN (${cph})`).run(...chunkIds);
    }
    if (chatIds.length) {
      const mph = chatIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM messages WHERE chat_id IN (${mph})`).run(...chatIds);
    }
    if (wsIds.length) {
      const del = (sql) => d.prepare(sql).run(...wsIds);
      del(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE workspace_id IN (${ph}))`);
      del(`DELETE FROM entity_tags WHERE entity_id IN (SELECT id FROM files WHERE workspace_id IN (${ph}))`);
      del(`DELETE FROM entity_tags WHERE entity_id IN (SELECT id FROM notes WHERE workspace_id IN (${ph}))`);
      del(`DELETE FROM chunks WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM file_text WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM files WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM notes WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM folders WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM assets WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM tags WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM shares WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM comments WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM relations WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM ai_outputs WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM chats WHERE workspace_id IN (${ph})`);
      del(`DELETE FROM workspaces WHERE id IN (${ph})`);
    }

    // 仅他所在的成员关系、锁、会话
    d.prepare(`DELETE FROM team_members WHERE user_id=?`).run(user.id);
    d.prepare(`DELETE FROM locks WHERE user_id=?`).run(user.id);
    d.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user.id);

    // 无其他成员的团队一并删除
    for (const t of teamIds) {
      d.prepare(`DELETE FROM team_members WHERE team_id=?`).run(t);
      d.prepare(`DELETE FROM teams WHERE id=?`).run(t);
    }

    // 匿名化：保留主键，历史记录不悬空；密码换成随机值，旧密码无法再登录
    const { hash, salt } = hashPassword(randomId('deleted') + Date.now());
    d.prepare(
      `UPDATE users SET email=?, name=?, title='', bio='', avatar='', settings='{}',
                        ai_provider='', ai_model='', ai_base_url='', ai_key_enc='',
                        password_hash=?, password_salt=?, status='deleted',
                        storage_used=0, updated_at=?
        WHERE id=?`
    ).run(`deleted+${user.id}@kbpro.invalid`, '已注销用户', hash, salt, nowIso(), user.id);
  });

  return {
    workspaces: wsIds.length,
    files: files.length,
    notes: notes.length,
    teams: teamIds.length
  };
}
