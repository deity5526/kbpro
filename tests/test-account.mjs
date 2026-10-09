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

  head('校验：唯一的管理员不能注销自己');
  // 否则实例会永久失去管理员：用户记录还在（status=deleted），
  // 而引导逻辑只在「一个用户都没有」时才创建管理员
  useCookie(adminCookie);
  const lastAdmin = await api('DELETE', '/api/users/me', { password: ADMIN_PW });
  eq(lastAdmin.status, 400, '唯一管理员注销自己 → 400 阻断');
  check(/唯一可用的管理员/.test(lastAdmin.data?.error || ''), '提示先创建或指定另一位管理员', lastAdmin.data?.error);
  const adminStillOk = await api('GET', '/api/auth/me');
  eq(adminStillOk.data?.user?.role, 'admin', '管理员账号未受影响，仍可登录');
  const adminWs = await api('GET', '/api/workspaces');
  check((adminWs.data?.workspaces || []).length > 0, '管理员的知识库未被清理');

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

  head('用户管理（管理员端账户管理）');
  useCookie(adminCookie);
  const list = await api('GET', '/api/admin/users');
  eq(list.status, 200, '管理员可以拉取用户列表');
  check(Array.isArray(list.data?.users) && list.data.users.length >= 2, `列表中至少两个账号（${list.data?.users?.length}）`);
  check((list.data?.summary?.admins || 0) >= 1, `统计里有可用管理员 ${list.data?.summary?.admins} 个`);
  const meRow = (list.data?.users || []).find((u) => u.isSelf);
  check(!!meRow, '列表标出了"我自己"');
  check(typeof meRow?.storageUsedText === 'string', '列表带存储用量等统计字段', meRow?.storageUsedText);

  // 非管理员不能访问
  const someUser = (list.data?.users || []).find((u) => !u.isSelf && u.role !== 'admin' && u.status === 'active');
  check(!!someUser, '列表里有一个普通成员可用于测试', someUser?.email);
  let memberCookie = '';
  const memberLogin = await loginAs(someUser.email, 'brandnew12345');
  if (memberLogin.ok) {
    memberCookie = memberLogin.cookie;
    const denied = await api('GET', '/api/admin/users');
    eq(denied.status, 403, '普通成员访问用户管理 → 403');
    const deniedPatch = await api('PATCH', `/api/admin/users/${someUser.id}`, { role: 'admin' });
    eq(deniedPatch.status, 403, '普通成员修改角色 → 403');
  } else {
    check(false, '普通成员登录失败，跳过越权校验', memberLogin.status);
  }

  head('用户管理：保护最后一位管理员');
  useCookie(adminCookie);
  const demoteSelf = await api('PATCH', `/api/admin/users/${meRow.id}`, { role: 'user' });
  eq(demoteSelf.status, 400, '不能取消自己的管理员权限');
  const disableSelf = await api('PATCH', `/api/admin/users/${meRow.id}`, { status: 'disabled' });
  eq(disableSelf.status, 400, '不能停用自己的账号');
  const badRole = await api('PATCH', `/api/admin/users/${someUser.id}`, { role: 'superuser' });
  eq(badRole.status, 400, '非法角色被拒绝');
  const noField = await api('PATCH', `/api/admin/users/${someUser.id}`, {});
  eq(noField.status, 400, '没有可修改字段时返回 400');
  const delSelfViaAdmin = await api('DELETE', `/api/admin/users/${meRow.id}`);
  eq(delSelfViaAdmin.status, 400, '管理员不能从用户管理里删除自己（应走个人中心注销）');

  head('用户管理：提升为管理员后，原管理员即可注销');
  const promote = await api('PATCH', `/api/admin/users/${someUser.id}`, { role: 'admin' });
  eq(promote.status, 200, '把普通成员提升为管理员');
  eq(promote.data?.user?.role, 'admin', '角色已更新为 admin');

  // 现在系统里有两个管理员，"唯一管理员"这道闸门应当放行
  useCookie(adminCookie);
  const adminDel = await api('DELETE', '/api/users/me', { password: ADMIN_PW });
  eq(adminDel.status, 200, '有第二位管理员后，原管理员可以正常注销');
  eq(adminDel.data?.deleted, true, '注销成功并返回清理结果');
  useCookie(adminCookie);
  const deadCookie = await api('GET', '/api/workspaces');
  eq(deadCookie.status, 401, '原管理员注销后其会话立即失效');

  head('用户管理：新管理员可以继续管理');
  useCookie(memberCookie);
  const afterList = await api('GET', '/api/admin/users');
  eq(afterList.status, 200, '新管理员可以拉取用户列表');
  eq(afterList.data?.summary?.admins, 1, '系统里仍有一位可用管理员');

  // 注册一个干净的账号，用于验证"停用后立即无法登录"
  cookie = '';
  const spareEmail = `spare-${stamp}@example.com`;
  const sparePw = 'sparepw12345';
  const spareReg = await api('POST', '/api/auth/register', { email: spareEmail, password: sparePw, name: '待停用用户' });
  eq(spareReg.status, 201, '注册一个用于停用测试的账号');
  const spareCookie = cookie;

  useCookie(memberCookie);
  const spareRow = (await api('GET', `/api/admin/users?q=${encodeURIComponent(spareEmail)}`)).data?.users?.[0];
  check(!!spareRow, '能在用户管理里搜到这个账号', spareEmail);
  const disabled = await api('PATCH', `/api/admin/users/${spareRow.id}`, { status: 'disabled' });
  eq(disabled.status, 200, '管理员可以停用账号');
  eq(disabled.data?.user?.status, 'disabled', '状态已置为 disabled');

  useCookie(spareCookie);
  const kicked = await api('GET', '/api/workspaces');
  eq(kicked.status, 401, '停用后该用户已有会话立即失效');
  cookie = '';
  const tryLogin = await loginAs(spareEmail, sparePw);
  eq(tryLogin.ok, false, '被停用的账号无法再登录', tryLogin.status);

  useCookie(memberCookie);
  const enabled = await api('PATCH', `/api/admin/users/${spareRow.id}`, { status: 'active' });
  eq(enabled.status, 200, '再次启用该账号');
  cookie = '';
  const relogin = await loginAs(spareEmail, sparePw);
  eq(relogin.ok, true, '启用后可以重新登录');

  head('用户管理：管理员删除他人账号');
  useCookie(memberCookie);
  const wouldBlock = await api('DELETE', `/api/admin/users/${spareRow.id}`);
  check([200, 400].includes(wouldBlock.status), '管理员可以删除他人账号（或被合理阻断）', wouldBlock.status);
  if (wouldBlock.status === 200) {
    eq(wouldBlock.data?.deleted, true, '删除返回 deleted');
    const gone = get(`SELECT status, name FROM users WHERE id=?`, spareRow.id);
    eq(gone?.status, 'deleted', '目标账号已被匿名化');
    eq(gone?.name, '已注销用户', '昵称已匿名化');
  }

  head('团队所有权可以转让（注销阻断的出口）');
  // owner2 仍是团队所有者且团队里还有其他成员，只有转让出去才能注销
  cookie = '';
  const owner2Login = await loginAs(owner2Email, owner2Pw);
  eq(owner2Login.ok, true, '团队所有者重新登录');
  const owner2Cookie = owner2Login.cookie;

  // 注意：此时原来的管理员已经注销，要邀请一个"当前仍然有效"的用户作为转让目标
  const invite2 = await api('POST', `/api/teams/${team3Id}/members`, { email: someUser.email, role: 'editor' });
  check([200, 201].includes(invite2.status), '邀请当前管理员加入团队', invite2.status);

  const members = await api('GET', `/api/teams/${team3Id}/members`);
  const other = (members.data?.members || []).find((m) => m.role !== 'owner');
  check(!!other, '团队里有可接收所有权的成员', other?.email || JSON.stringify(members.data).slice(0, 120));
  if (!other) throw new Error('没有可接收所有权的成员，后续断言无法进行');

  const transfer = await api('POST', `/api/teams/${team3Id}/transfer`, { userId: other.id });
  eq(transfer.status, 200, '所有者可以转让团队所有权');
  const afterTransfer = await api('GET', `/api/teams/${team3Id}/members`);
  const newOwner = (afterTransfer.data?.members || []).find((m) => m.id === other.id);
  eq(newOwner?.role, 'owner', '接收方已成为所有者');
  const oldOwnerRow = (afterTransfer.data?.members || []).find((m) => m.email === owner2Email);
  eq(oldOwnerRow?.role, 'admin', '原所有者降为团队管理员（不会失去管理权限）');

  const notOwner = await api('POST', `/api/teams/${team3Id}/transfer`, { userId: other.id });
  check([400, 403].includes(notOwner.status), '非所有者不能再次转让', notOwner.status);

  useCookie(owner2Cookie);
  const nowAllowed = await api('DELETE', '/api/users/me', { password: owner2Pw });
  eq(nowAllowed.status, 200, '转让后原所有者可以正常注销');

  head('收尾');
  await stop();

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
