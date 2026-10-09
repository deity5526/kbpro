/**
 * KBPRO — 账号注销测试
 *
 * 注销是一个"不可恢复"的操作，所以这套测试重点不是"能不能注销成功"，
 * 而是**该拦住的时候有没有拦住**、以及**注销之后数据到底清理干净了没有**：
 *   1. 参数与身份校验：缺密码 / 密码错误 必须被拒绝
 *   2. 依赖检查：团队所有者且团队还有其他成员时，必须阻断并提示先转让
 *   3. 数据清理：个人知识库、文件（含磁盘）、笔记、会话记录全部消失
 *   4. 凭据失效：旧密码登不进去，旧 Cookie 立即失效
 *   5. 匿名化：用户记录保留主键但不可识别，邮箱被释放可重新注册
 *   6. 审计：留下 user.delete 记录
 *
 * 运行： node tests/test-account.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = path.join(os.tmpdir(), `kbpro-account-${Date.now().toString(36)}`);
process.env.KBPRO_DATA = TMP_ROOT;
process.env.KBPRO_QUIET = '1';

let passed = 0, failed = 0;
const failures = [];
let section = '';

function head(n) { section = n; console.log(`\n\x1b[36m▸ ${n}\x1b[0m`); }
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push(`[${section}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 400)}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== undefined ? `  → ${JSON.stringify(detail)?.slice(0, 320)}` : ''}`);
  }
}
function eq(actual, expected, label) {
  check(actual === expected, label, actual === expected ? undefined : { actual, expected });
}

/* ------------------------------------------------------------------ 客户端 */

const ADMIN_EMAIL = 'admin@kbpro.local';
const ADMIN_PW = 'admin12345';

let BASE = '';
let cookie = '';

async function api(method, pathname, body) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload = body;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith('kbpro_session=')) cookie = c.split(';')[0];
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
}

/** 切换登录身份，返回切换后的 cookie，用完可以换回来 */
async function loginAs(email, password) {
  const r = await api('POST', '/api/auth/login', { email, password });
  return { ok: r.status === 200, status: r.status, data: r.data, cookie };
}
function useCookie(c) { cookie = c; }

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const { start, stop } = await import('../server/index.js');
  const started = await start({ port: 0, host: '127.0.0.1', silent: true });
  BASE = started.url;
  console.log(`KBPRO 账号注销测试 · 服务地址 ${BASE}\n数据目录 ${TMP_ROOT}`);

  head('准备：管理员登录');
  const admin = await loginAs(ADMIN_EMAIL, ADMIN_PW);
  eq(admin.ok, true, '管理员登录成功');
  const adminCookie = cookie;

  head('准备：注册一个待注销的用户');
  const stamp = Date.now().toString(36);
  const victimEmail = `victim-${stamp}@example.com`;
  const victimPw = 'victimpw12345';
  const reg = await api('POST', '/api/auth/register', { email: victimEmail, password: victimPw, name: '待注销用户' });
  eq(reg.status, 201, '注册成功');
  const victimId = reg.data?.user?.id || '';
  check(!!victimId, '拿到用户 ID', victimId);
  const victimCookie = cookie;

  const ws = await api('GET', '/api/workspaces');
  const personal = (ws.data?.workspaces || []).find((w) => w.kind === 'personal' && w.permission === 'manage');
  check(!!personal, '注册后自动拥有个人知识库', personal?.name);

  head('准备：制造一些要被清理的数据');
  const fileRes = await api('POST', '/api/files/text', {
    workspaceId: personal.id,
    name: `注销测试-${stamp}.md`,
    content: '# 注销测试\n\n这份文档应当随着账号注销一起消失。里边有几个关键词：注销、清理、验证。'
  });
  eq(fileRes.status, 201, '创建了一个文件');
  const fileId = fileRes.data?.file?.id || '';

  const noteRes = await api('POST', '/api/notes', {
    workspaceId: personal.id,
    title: `注销测试笔记-${stamp}`,
    html: '<p>这篇笔记应当随着账号注销一起消失。</p>'
  });
  eq(noteRes.status, 201, '创建了一篇笔记');
  const noteId = noteRes.data?.note?.id || '';

  const listed = await api('GET', `/api/files?workspaceId=${personal.id}&limit=50`);
  const before = (listed.data?.files || []).length;
  check(before >= 1, `个人库中确有 ${before} 个文件`);

  // 记录磁盘上的存储路径，用于验证物理文件被删除
  const { get } = await import('../server/db.js');
  const { absoluteStoragePath } = await import('../server/lib/storage.js');
  const fileRow = get(`SELECT storage_key FROM files WHERE id=?`, fileId);
  const diskPath = fileRow ? absoluteStoragePath(fileRow.storage_key) : '';
  check(!!diskPath && fs.existsSync(diskPath), '文件已落盘（用于校验物理删除）', diskPath);

  head('校验：不满足条件时必须拒绝注销');
  useCookie(victimCookie);
  const noPw = await api('DELETE', '/api/users/me', {});
  eq(noPw.status, 400, '不传密码 → 400');
  check(/缺少参数/.test(noPw.data?.error || ''), '错误信息说明缺少参数', noPw.data?.error);

  const wrongPw = await api('DELETE', '/api/users/me', { password: 'not-the-password' });
  eq(wrongPw.status, 400, '密码错误 → 400');
  check(/密码不正确/.test(wrongPw.data?.error || ''), '错误信息说明密码不正确', wrongPw.data?.error);

  // 方法不匹配时必须告诉调用方「这个路径支持哪些方法」。
  // 曾经的提示只有一句「方法 X 不被支持」，排查全靠猜。
  const badMethod = await api('PUT', '/api/users/me', {});
  eq(badMethod.status, 405, '未注册的方法返回 405');
  check(/该路径支持/.test(badMethod.data?.error || ''), '405 提示列出该路径支持的方法', badMethod.data?.error);
  check(/DELETE/.test(badMethod.data?.error || '') && /PATCH/.test(badMethod.data?.error || ''),
    '列出的方法与实际注册的一致（DELETE / PATCH）', badMethod.data?.error);

  const stillThere = await api('GET', '/api/auth/me');
  eq(stillThere.status, 200, '被拒绝后账号仍然可用（不会误注销）');

  head('校验：团队所有者有其他成员时必须阻断');
  useCookie('');
  const teamOwnerEmail = `owner-${stamp}@example.com`;
  const teamOwnerPw = 'ownerpw12345';
  const reg2 = await api('POST', '/api/auth/register', { email: teamOwnerEmail, password: teamOwnerPw, name: '团队所有者' });
  eq(reg2.status, 201, '注册团队所有者成功');
  const ownerCookie = cookie;

  const team2 = await api('POST', '/api/teams', { name: `阻断测试团队-${stamp}` });
  eq(team2.status, 201, '所有者创建团队成功');
  const team2Id = team2.data?.team?.id || '';

  const soloTry = await api('DELETE', '/api/users/me', { password: teamOwnerPw });
  eq(soloTry.status, 200, '只有自己一个人的团队不阻断注销（团队随账号一起删除）');
  const soloTeamLeft = get(`SELECT COUNT(*) AS n FROM teams WHERE id=?`, team2Id);
  eq(Number(soloTeamLeft?.n || 0), 0, '该团队记录已随账号删除');

  // 重新注册一个所有者专门测"有其他成员"的场景
  const owner2Email = `owner2-${stamp}@example.com`;
  const owner2Pw = 'owner2pw12345';
  useCookie('');
  const reg3 = await api('POST', '/api/auth/register', { email: owner2Email, password: owner2Pw, name: '团队所有者二' });
  eq(reg3.status, 201, '注册第二个团队所有者成功');
  const team3 = await api('POST', '/api/teams', { name: `成员阻断团队-${stamp}` });
  eq(team3.status, 201, '创建团队成功');
  const team3Id = team3.data?.team?.id || '';
  const invite = await api('POST', `/api/teams/${team3Id}/members`, { email: ADMIN_EMAIL, role: 'editor' });
  check([200, 201].includes(invite.status), '邀请管理员加入团队', invite.status);

  const blocked2 = await api('DELETE', '/api/users/me', { password: owner2Pw });
  eq(blocked2.status, 400, '所有者 + 有其他成员 → 400 阻断');
  check(/请先转让团队所有权/.test(blocked2.data?.error || ''), '提示先转让团队所有权', blocked2.data?.error);
  const ownerAlive = await api('GET', '/api/auth/me');
  eq(ownerAlive.status, 200, '阻断后所有者账号仍然可用');

  head('注销成功：数据清理');
  useCookie(victimCookie);
  const del = await api('DELETE', '/api/users/me', { password: victimPw });
  eq(del.status, 200, '密码正确且无阻断 → 注销成功');
  eq(del.data?.deleted, true, '响应标记 deleted');
  check(Number(del.data?.files) >= 1, `清理了 ${del.data?.files} 个文件`);
  check(Number(del.data?.notes) >= 1, `清理了 ${del.data?.notes} 篇笔记`);
  check(Number(del.data?.workspaces) >= 1, `清理了 ${del.data?.workspaces} 个知识库`);

  head('注销后：凭据与数据都必须消失');
  const oldSession = await api('GET', '/api/auth/me');
  eq(oldSession.status, 200, '/api/auth/me 本身是"安全可调用"的接口');
  eq(oldSession.data?.user, null, '旧 Cookie 已识别不出用户');
  const protectedCall = await api('GET', '/api/workspaces');
  eq(protectedCall.status, 401, '受保护接口对旧 Cookie 返回 401');

  cookie = '';
  const oldLogin = await loginAs(victimEmail, victimPw);
  eq(oldLogin.ok, false, '旧邮箱 + 旧密码无法登录');

  useCookie(adminCookie);
  const goneFile = await api('GET', `/api/files/${fileId}`);
  check([403, 404].includes(goneFile.status), '原文件已不可访问', goneFile.status);
  const goneNote = await api('GET', `/api/notes/${noteId}`);
  check([403, 404].includes(goneNote.status), '原笔记已不可访问', goneNote.status);
  check(!fs.existsSync(diskPath), '磁盘上的原始文件已删除', diskPath);

  const victimWs = await api('GET', '/api/workspaces');
  const stillListed = (victimWs.data?.workspaces || []).some((w) => w.id === personal.id);
  eq(stillListed, false, '管理员的知识库列表中不再出现被注销用户的个人库');

  head('注销后：用户记录被匿名化');
  const row = get(`SELECT id, email, name, status, storage_used, ai_key_enc FROM users WHERE id=?`, victimId);
  check(!!row, '用户记录仍然存在（保留主键以免历史记录悬空）');
  eq(row?.status, 'deleted', '状态标记为 deleted');
  eq(row?.name, '已注销用户', '昵称已匿名化');
  check(/^deleted\+/.test(row?.email || ''), '邮箱被替换为占位地址', row?.email);
  eq(Number(row?.storage_used), 0, '存储用量已归零');
  eq(row?.ai_key_enc || '', '', '大模型密钥已清除');

  head('注销后：邮箱被释放，可重新注册');
  cookie = '';
  const reReg = await api('POST', '/api/auth/register', { email: victimEmail, password: 'brandnew12345', name: '复用的邮箱' });
  eq(reReg.status, 201, '同一邮箱可以重新注册');

  head('审计：留下 user.delete 记录');
  useCookie(adminCookie);
  const logs = await api('GET', '/api/logs?limit=200');
  const flat = JSON.stringify(logs.data || {});
  check(logs.status === 200 && /user\.delete/.test(flat), '审计日志中存在 user.delete 记录',
    logs.status === 200 ? flat.slice(0, 160) : logs.status);

  head('收尾');
  await stop();
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }

  console.log('\n' + '─'.repeat(64));
  console.log(`  通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('\n\x1b[31m失败明细：\x1b[0m');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('─'.repeat(64));
  console.log(failed === 0 ? '\x1b[32mRESULT: PASS\x1b[0m' : '\x1b[31mRESULT: FAIL\x1b[0m');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常终止：', err);
  process.exit(1);
});
