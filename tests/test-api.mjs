/**
 * KBPRO — 端到端 API 测试
 * 在临时数据目录中启动真实服务器，走完整业务链路。
 *
 * 运行： node tests/test-api.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const TMP_ROOT = path.join(os.tmpdir(), `kbpro-test-${Date.now().toString(36)}`);
process.env.KBPRO_DATA = TMP_ROOT;
process.env.KBPRO_HOST = '127.0.0.1';
process.env.KBPRO_QUIET = '1';

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n\x1b[36m▸ ${name}\x1b[0m`);
}

function check(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(`[${currentSection}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 400)}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== undefined ? `  → ${JSON.stringify(detail)?.slice(0, 300)}` : ''}`);
  }
}

function eq(actual, expected, label) {
  check(actual === expected, label, { actual, expected });
}

/* ------------------------------------------------------------------ HTTP 客户端 */

let BASE = '';
let cookie = '';

async function api(method, pathname, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    if (c.startsWith('kbpro_session=')) cookie = c.split(';')[0];
  }
  const ct = res.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  else if (opts.raw) data = Buffer.from(await res.arrayBuffer());
  else data = await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function json(method, pathname, body, opts) {
  const r = await api(method, pathname, body, opts);
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { tries = 60, delay = 250, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(delay);
  }
  throw new Error(`等待超时：${label}`);
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const { start, stop } = await import('../server/index.js');
  const started = await start({ port: 0, host: '127.0.0.1', silent: true });
  BASE = started.url;
  console.log(`KBPRO E2E 测试 · 服务地址 ${BASE}\n数据目录 ${TMP_ROOT}`);

  try {
    await runSuite();
  } finally {
    await stop();
    await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  }

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

async function runSuite() {

  /* ============================ 健康检查 ============================ */
  section('健康检查与启动');
  {
    const r = await json('GET', '/api/health');
    eq(r.status, 200, 'GET /api/health 返回 200');
    eq(r.data.service, 'kbpro', '服务标识为 kbpro');
  }

  /* ============================ 认证 ============================ */
  section('认证 · 注册 / 登录 / 会话');
  let adminToken = '';
  {
    const login = await json('POST', '/api/auth/login', { email: 'admin@kbpro.local', password: 'admin12345' });
    eq(login.status, 200, '默认管理员登录成功');
    check(login.data.user?.role === 'admin', '管理员角色正确');
    check(!!cookie, '服务端下发了会话 Cookie');

    const me = await json('GET', '/api/auth/me');
    eq(me.status, 200, 'GET /api/auth/me 可用');
    check(me.data.user?.email === 'admin@kbpro.local', '当前用户正确');
    check(Array.isArray(me.data.workspaces) && me.data.workspaces.length >= 2, '已初始化个人 + 团队知识库', me.data.workspaces?.length);
    adminToken = login.data.token;
  }

  let userCookieBackup = cookie;
  let memberUserId = '';
  {
    // 注册第二个用户（用于共享 / 团队）
    cookie = '';
    const reg = await json('POST', '/api/auth/register', { name: '李协作', email: 'lily@example.com', password: 'lily12345' });
    eq(reg.status, 201, '新用户注册成功');
    memberUserId = reg.data.user.id;
    check(!!memberUserId, '返回了新用户 ID');

    const dup = await json('POST', '/api/auth/register', { name: 'x', email: 'lily@example.com', password: 'lily12345' });
    eq(dup.status, 409, '重复邮箱注册被拒绝');

    const weak = await json('POST', '/api/auth/register', { name: 'x', email: 'weak@example.com', password: '123' });
    eq(weak.status, 400, '弱密码被拒绝');

    const bad = await json('POST', '/api/auth/login', { email: 'lily@example.com', password: 'wrong-password' });
    eq(bad.status, 401, '错误密码登录被拒绝');
  }

  // 回到管理员
  cookie = '';
  await json('POST', '/api/auth/login', { email: 'admin@kbpro.local', password: 'admin12345' });

  /* ============================ 知识库 ============================ */
  section('知识库 · 列表 / 创建 / 隔离');
  let personalWs = '';
  let teamWs = '';
  {
    const r = await json('GET', '/api/workspaces');
    eq(r.status, 200, 'GET /api/workspaces 可用');
    const personal = r.data.workspaces.find((w) => w.kind === 'personal');
    const team = r.data.workspaces.find((w) => w.kind === 'team');
    check(!!personal, '存在个人知识库');
    check(!!team, '存在团队知识库');
    personalWs = personal.id;
    teamWs = team.id;
    check(typeof personal.stats?.files === 'number', '知识库包含统计信息');

    const created = await json('POST', '/api/workspaces', { name: '测试项目库', kind: 'personal', description: 'e2e' });
    eq(created.status, 201, '创建知识库成功');

    const noName = await json('POST', '/api/workspaces', { name: '' });
    eq(noName.status, 400, '空名称创建被拒绝');

    const ov = await json('GET', `/api/workspaces/${personalWs}/overview`);
    eq(ov.status, 200, '概览接口可用');
    check(Array.isArray(ov.data.trend) && ov.data.trend.length === 14, '概览返回 14 天趋势');
  }

  /* ============================ 文件夹 ============================ */
  section('文件夹 · 分层 / 重命名 / 移动 / 删除');
  let folderA = '';
  let folderB = '';
  {
    const a = await json('POST', '/api/folders', { workspaceId: personalWs, name: '第一章·资料' });
    eq(a.status, 201, '创建根文件夹成功');
    folderA = a.data.folder.id;

    const b = await json('POST', '/api/folders', { workspaceId: personalWs, parentId: folderA, name: '1.1 子目录' });
    eq(b.status, 201, '创建子文件夹成功');
    folderB = b.data.folder.id;

    const dup = await json('POST', '/api/folders', { workspaceId: personalWs, name: '第一章·资料' });
    eq(dup.status, 409, '同级重名被拒绝');

    const tree = await json('GET', `/api/workspaces/${personalWs}/folders`);
    eq(tree.status, 200, '获取文件夹树成功');
    const root = tree.data.tree.find((n) => n.id === folderA);
    check(!!root, '文件夹树包含根节点');
    check(root?.children?.some((c) => c.id === folderB), '嵌套层级正确');

    const badMove = await json('POST', `/api/folders/${folderA}/move`, { parentId: folderB });
    eq(badMove.status, 400, '禁止把父文件夹移动到子目录');

    const bc = await json('GET', `/api/folders/${folderB}/breadcrumb`);
    check(bc.data.breadcrumb?.length >= 2, '面包屑包含层级路径', bc.data.breadcrumb?.length);

    const ren = await json('PATCH', `/api/folders/${folderA}`, { name: '第一章·核心资料' });
    eq(ren.status, 200, '文件夹重命名成功');
    eq(ren.data.folder.name, '第一章·核心资料', '重命名结果正确');
  }

  /* ============================ 文件上传 ============================ */
  section('文件 · 上传 / 解析 / 预览 / 列表');
  let fileId = '';
  {
    const content = [
      '# 季度业务报告',
      '',
      '## 一、核心结论',
      '本季度营收同比增长 23.4%，其中企业服务业务增长 41.2%，是主要驱动力。',
      '客户留存率达到 94.7%，较上季度提升 2.1 个百分点。',
      '',
      '## 二、风险提示',
      '供应链成本上升 8.3%，预计下季度毛利率承压约 1.5 个百分点。',
      '海外市场合规成本增加，需要在第二季度前完成数据合规审计。',
      '',
      '## 三、下季度计划',
      '重点投入智能知识库产品的研发，目标是在六月底前完成商用版本发布。',
      '计划新增 3 个行业解决方案：金融、医疗、制造业。'
    ].join('\n');

    const fd = new FormData();
    fd.append('workspaceId', personalWs);
    fd.append('folderId', folderA);
    fd.append('tags', '财报,季度');
    fd.append('file', new Blob([content], { type: 'text/markdown' }), '季度业务报告.md');

    const up = await api('POST', '/api/files/upload', fd);
    eq(up.status, 201, '文件上传成功');
    check(up.data.files?.length === 1, '返回 1 个文件');
    fileId = up.data.files[0].id;
    eq(up.data.files[0].name, '季度业务报告.md', '文件名保持正确');
    check(up.data.files[0].size > 0, '文件大小已记录');
    check(up.data.files[0].tags.includes('财报'), '标签已保存');

    // 同名去重
    const fd2 = new FormData();
    fd2.append('workspaceId', personalWs);
    fd2.append('folderId', folderA);
    fd2.append('file', new Blob([content], { type: 'text/markdown' }), '季度业务报告.md');
    const up2 = await api('POST', '/api/files/upload', fd2);
    check(up2.data.files[0].name !== '季度业务报告.md', '同名文件自动重命名', up2.data.files[0].name);

    // 等待自动解析完成
    await waitFor(async () => {
      const t = await json('GET', `/api/files/${fileId}/text`);
      return t.data.status === 'ok';
    }, { label: '文件解析完成' });

    const detail = await json('GET', `/api/files/${fileId}`);
    eq(detail.data.file.text.status, 'ok', '解析状态为 ok');
    check(detail.data.file.text.chars > 100, '抽取字符数合理', detail.data.file.text.chars);

    const text = await json('GET', `/api/files/${fileId}/text`);
    check(text.data.text.includes('23.4%'), '抽取文本包含关键数字');
    check(text.data.html.includes('<h1'), 'Markdown 已渲染为 HTML');

    const preview = await json('GET', `/api/files/${fileId}/preview`);
    eq(preview.data.kind, 'markdown', '预览类型识别为 markdown');

    const raw = await api('GET', `/api/files/${fileId}/content`, undefined, { raw: true });
    eq(raw.status, 200, '原始内容可下载');
    check(Buffer.isBuffer(raw.data) && raw.data.length > 0, '原始内容非空');

    const list = await json('GET', `/api/files?workspaceId=${personalWs}&folderId=${folderA}`);
    eq(list.status, 200, '文件列表可用');
    check(list.data.total >= 2, '列表中包含上传的文件', list.data.total);
  }

  /* ============================ 检索 ============================ */
  section('检索 · BM25 / 高亮 / 标签 / 建议');
  {
    const r = await json('GET', `/api/search?workspaceId=${personalWs}&q=${encodeURIComponent('留存率')}`);
    eq(r.status, 200, '全局检索可用');
    check(r.data.total >= 1, '检索命中文件', r.data.total);
    check(r.data.items[0].snippet.includes('<mark>'), '检索结果包含高亮标记', r.data.items[0].snippet?.slice(0, 120));

    const r2 = await json('GET', `/api/search?workspaceId=all&q=${encodeURIComponent('毛利率承压')}`);
    check(r2.data.total >= 1, '跨知识库检索命中', r2.data.total);

    const r3 = await json('GET', `/api/search?workspaceId=${personalWs}&q=${encodeURIComponent('供应链')}`);
    check(r3.data.total >= 1, '中文分词检索命中');

    const r4 = await json('GET', `/api/search?workspaceId=${personalWs}&q=${encodeURIComponent('不存在的词汇xyzzy')}`);
    eq(r4.data.total, 0, '无关查询不返回结果');

    const sug = await json('GET', `/api/search/suggest?workspaceId=${personalWs}&q=${encodeURIComponent('季度')}`);
    check(Array.isArray(sug.data.titles), '检索建议可用');
    check(sug.data.titles.some((t) => t.title.includes('季度')), '建议命中标题');

    const tags = await json('GET', `/api/workspaces/${personalWs}/tags`);
    check(tags.data.tags.some((t) => t.name === '财报'), '标签已建立索引', tags.data.tags.map((t) => t.name));

    const cloud = await json('GET', `/api/workspaces/${personalWs}/tagcloud`);
    check(cloud.data.tags.length >= 1, '标签云可用');

    const tr = await json('GET', `/api/search?workspaceId=${personalWs}&q=${encodeURIComponent('报告')}&tags=财报`);
    check(tr.data.total >= 1, '标签过滤检索可用', tr.data.total);
  }

  /* ============================ 笔记 ============================ */
  section('笔记 · 富文本 / 自动保存 / 版本历史');
  let noteId = '';
  {
    const create = await json('POST', '/api/notes', {
      workspaceId: personalWs, folderId: folderB, title: '会议纪要测试',
      html: '<h1>周会纪要</h1><p>讨论了<strong>知识库</strong>的检索准确率问题。</p><ul><li>第一项</li><li>第二项</li></ul>',
      tags: ['会议']
    });
    eq(create.status, 201, '创建笔记成功');
    noteId = create.data.note.id;
    check(create.data.note.wordCount > 0, '笔记字数统计正确');
    check(create.data.note.text.includes('知识库'), 'HTML 已转为纯文本索引');

    const save1 = await json('PUT', `/api/notes/${noteId}`, {
      html: '<h1>周会纪要</h1><p>讨论了<strong>知识库</strong>的检索准确率问题，决定引入 RAG 方案。</p><pre><code>npm run index</code></pre>',
      title: '周会纪要（已更新）'
    });
    eq(save1.status, 200, '笔记自动保存成功');
    check(save1.data.note.version >= 2, '版本号自增', save1.data.note.version);
    check(!!save1.data.savedAt, '返回保存时间戳');

    const save2 = await json('PUT', `/api/notes/${noteId}`, {
      html: '<h1>周会纪要</h1><p>讨论了<strong>知识库</strong>的检索准确率问题，决定引入 RAG 方案。</p><pre><code>npm run index</code></pre><table><tr><th>项</th><th>值</th></tr><tr><td>准确率</td><td>92%</td></tr></table>',
      createVersion: true
    });
    eq(save2.status, 200, '第二次保存成功');

    const versions = await json('GET', `/api/notes/${noteId}/versions`);
    check(versions.data.versions.length >= 2, '历史版本已留存', versions.data.versions.length);
    check(versions.data.versions.some((v) => v.summary), '版本带有备注');

    const v1 = await json('GET', `/api/notes/${noteId}/versions/1`);
    eq(v1.status, 200, '可读取指定版本');
    check(v1.data.version.html.includes('周会纪要'), '版本内容正确');

    const restore = await json('POST', `/api/notes/${noteId}/versions/1/restore`);
    eq(restore.status, 200, '版本恢复成功');
    check(!restore.data.note.html.includes('92%'), '恢复后内容回到历史版本');

    const noteSearch = await json('GET', `/api/search?workspaceId=${personalWs}&types=note&q=${encodeURIComponent('检索准确率')}`);
    check(noteSearch.data.total >= 1, '笔记可被检索到');

    // XSS 净化
    const dirty = await json('PUT', `/api/notes/${noteId}`, {
      html: '<p>安全测试</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">链接</a>'
    });
    eq(dirty.status, 200, '含脚本内容保存成功');
    check(!dirty.data.note.html.includes('<script'), 'script 标签被净化');
    check(!dirty.data.note.html.toLowerCase().includes('onerror'), '事件属性被净化');
    check(!dirty.data.note.html.includes('javascript:'), 'javascript: 链接被净化');

    const dup = await json('POST', `/api/notes/${noteId}/duplicate`);
    eq(dup.status, 201, '笔记复制成功');
    check(dup.data.note.title.includes('副本'), '副本标题正确');
  }

  /* ============================ 文件管理 ============================ */
  section('文件 · 重命名 / 移动 / 收藏 / 置顶 / 批量');
  {
    const ren = await json('PATCH', `/api/files/${fileId}`, { name: '季度业务报告-终版.md' });
    eq(ren.status, 200, '文件重命名成功');
    eq(ren.data.file.name, '季度业务报告-终版.md', '重命名结果正确');
    eq(ren.data.file.ext, 'md', '扩展名被保留');

    const star = await json('PATCH', `/api/files/${fileId}`, { starred: true, pinned: true });
    check(star.data.file.starred && star.data.file.pinned, '收藏与置顶生效');

    const move = await json('PATCH', `/api/files/${fileId}`, { folderId: folderB });
    eq(move.data.file.folderId, folderB, '文件移动成功');

    const listRoot = await json('GET', `/api/files?workspaceId=${personalWs}&folderId=root`);
    check(!listRoot.data.files.some((f) => f.id === fileId), '移动后不在原目录');

    const listSub = await json('GET', `/api/files?workspaceId=${personalWs}&folderId=${folderB}`);
    check(listSub.data.files.some((f) => f.id === fileId), '移动后在目标目录');

    const listPinned = await json('GET', `/api/files?workspaceId=${personalWs}&pinned=1`);
    check(listPinned.data.files.some((f) => f.id === fileId), '置顶过滤生效');

    const listStar = await json('GET', `/api/files?workspaceId=${personalWs}&starred=1`);
    check(listStar.data.files.some((f) => f.id === fileId), '收藏过滤生效');

    const del = await json('DELETE', `/api/files/${fileId}`);
    eq(del.status, 200, '软删除成功');
    const trash = await json('GET', `/api/files?workspaceId=${personalWs}&trash=1`);
    check(trash.data.files.some((f) => f.id === fileId), '回收站可见');
    const back = await json('POST', `/api/files/${fileId}/restore`);
    eq(back.status, 200, '从回收站还原成功');

    // 批量
    const all = await json('GET', `/api/files?workspaceId=${personalWs}&folderId=all`);
    const ids = all.data.files.map((f) => f.id);
    const batch = await json('POST', '/api/files/batch', { action: 'star', ids });
    eq(batch.data.ok, ids.length, '批量收藏全部成功');

    const untag = await json('POST', '/api/files/batch', { action: 'untag', ids: [fileId], tags: ['财报'] });
    eq(untag.data.ok, 1, '批量去标签成功');
    const after = await json('GET', `/api/files/${fileId}`);
    check(!after.data.file.tags.includes('财报'), '标签已移除');
  }

  /* ============================ 共享与权限 ============================ */
  section('共享 · 权限 / 评论 / 通知');
  {
    // 把文件设为私密，再共享给另一用户
    await json('PATCH', `/api/files/${fileId}`, { private: true });
    const before = await json('GET', `/api/shares?resourceType=file&resourceId=${fileId}`);
    eq(before.status, 200, '查看共享列表可用');

    const share = await json('POST', '/api/shares', {
      resourceType: 'file', resourceId: fileId, granteeType: 'user', granteeId: memberUserId, permission: 'view'
    });
    eq(share.status, 201, '共享给用户成功');
    const shareRow = share.data.share.find((s) => s.granteeId === memberUserId);
    check(!!shareRow, '共享记录已返回');
    eq(shareRow.permission, 'view', '共享权限正确');

    const linkShare = await json('POST', '/api/shares', {
      resourceType: 'file', resourceId: fileId, granteeType: 'link', permission: 'view'
    });
    eq(linkShare.status, 201, '创建分享链接成功');
    const tokenRow = linkShare.data.share.find((s) => s.granteeType === 'link');
    check(!!tokenRow?.token, '分享链接包含 token');

    const viaToken = await json('GET', `/api/share/${tokenRow.token}`);
    eq(viaToken.status, 200, '通过分享链接可访问');
    check(viaToken.data.resource.name.includes('季度业务报告'), '分享链接返回正确资源');

    const badToken = await json('GET', '/api/share/not-a-real-token');
    eq(badToken.status, 404, '无效分享链接返回 404');

    // 回归：匿名访客凭分享 token 可读取文件内容/预览；无 token 必须被拒绝
    {
      const savedCookie = cookie;
      cookie = '';
      const anonContent = await api('GET', `/api/files/${fileId}/content?inline=1&token=${tokenRow.token}`, undefined, { raw: true });
      eq(anonContent.status, 200, '匿名凭分享 token 可读取文件内容');
      check(Buffer.isBuffer(anonContent.data) && anonContent.data.length > 0, '匿名读取内容非空');
      const anonPreview = await api('GET', `/api/files/${fileId}/preview?token=${tokenRow.token}`);
      eq(anonPreview.status, 200, '匿名凭分享 token 可预览');
      const noToken = await api('GET', `/api/files/${fileId}/content`, undefined, { raw: true });
      eq(noToken.status, 401, '匿名无 token 读取内容被拒绝');
      const wrongToken = await api('GET', `/api/files/${fileId}/content?token=not-real`, undefined, { raw: true });
      eq(wrongToken.status, 401, '匿名错误 token 被拒绝');
      cookie = savedCookie;
      await json('GET', '/api/auth/me');
    }

    const comment = await json('POST', '/api/comments', {
      resourceType: 'file', resourceId: fileId, body: '这个数据需要再核对一下。'
    });
    eq(comment.status, 201, '发表评论成功');

    const comments = await json('GET', `/api/comments?resourceType=file&resourceId=${fileId}`);
    check(comments.data.comments.length === 1, '评论列表正确', comments.data.comments.length);
    check(comments.data.comments[0].userName.length > 0, '评论带用户名');

    const notif = await json('GET', '/api/notifications');
    eq(notif.status, 200, '通知列表可用');
  }

  /* ============================ 团队 ============================ */
  section('团队 · 成员 / 角色 / 团队知识库');
  {
    const teams = await json('GET', '/api/teams');
    check(teams.data.teams.length >= 1, '团队列表可用');
    const teamId = teams.data.teams[0].id;

    const add = await json('POST', `/api/teams/${teamId}/members`, { email: 'lily@example.com', role: 'editor' });
    eq(add.status, 200, '邀请成员成功');
    eq(add.data.member.role, 'editor', '成员角色正确');

    const members = await json('GET', `/api/teams/${teamId}/members`);
    check(members.data.members.length >= 2, '成员列表包含新成员', members.data.members.length);

    const badRole = await json('POST', `/api/teams/${teamId}/members`, { email: 'lily@example.com', role: 'root' });
    eq(badRole.status, 400, '非法角色被拒绝');

    const promote = await json('PATCH', `/api/teams/${teamId}/members/${memberUserId}`, { role: 'admin' });
    eq(promote.status, 200, '修改成员角色成功');

    const owner = members.data.members.find((m) => m.role === 'owner');
    const demoteOwner = await json('PATCH', `/api/teams/${teamId}/members/${owner.id}`, { role: 'viewer' });
    eq(demoteOwner.status, 400, '不能修改团队所有者角色');

    // 回归：重复邀请已存在成员，只能更新目标成员，不得覆盖其他成员（含所有者）的角色
    const reAdd = await json('POST', `/api/teams/${teamId}/members`, { email: 'lily@example.com', role: 'admin' });
    eq(reAdd.status, 200, '重复邀请已存在成员成功');
    const membersAfter = await json('GET', `/api/teams/${teamId}/members`);
    const ownerAfter = membersAfter.data.members.find((m) => m.id === owner.id);
    eq(ownerAfter.role, 'owner', '重复邀请后所有者角色未被覆盖');
    const lilyAfter = membersAfter.data.members.find((m) => m.id === memberUserId);
    eq(lilyAfter.role, 'admin', '重复邀请只更新目标成员角色');

    const newTeam = await json('POST', '/api/teams', { name: '研发中心', description: 'e2e 团队' });
    eq(newTeam.status, 201, '创建团队成功');
    check(!!newTeam.data.workspaceId, '团队自动创建了知识库');
  }

  /* ============================ 知识库隔离 ============================ */
  section('隔离 · 个人与团队知识库互不可见');
  {
    const savedCookie = cookie;
    cookie = '';
    await json('POST', '/api/auth/login', { email: 'lily@example.com', password: 'lily12345' });

    const ws = await json('GET', '/api/workspaces');
    const kinds = ws.data.workspaces.map((w) => w.kind);
    check(kinds.includes('team'), '新成员能看到团队知识库');
    check(!ws.data.workspaces.some((w) => w.id === personalWs), '新成员看不到他人的个人知识库');

    const denied = await json('GET', `/api/workspaces/${personalWs}/overview`);
    eq(denied.status, 403, '访问他人个人知识库被拒绝（403）');

    // 通过共享获得的文件仍可访问
    const shared = await json('GET', `/api/files/${fileId}`);
    eq(shared.status, 200, '通过共享可访问私密文件');
    eq(shared.data.permission, 'view', '共享权限为只读');

    const editDenied = await json('PATCH', `/api/files/${fileId}`, { name: 'hacked.md' });
    eq(editDenied.status, 403, '只读共享无法修改');

    // 团队库中该用户为 admin，可写
    const teamList = ws.data.workspaces.find((w) => w.kind === 'team');
    const canWrite = await json('POST', '/api/folders', { workspaceId: teamList.id, name: '协作目录' });
    eq(canWrite.status, 201, '团队 admin 可创建文件夹');

    cookie = savedCookie;
    await json('GET', '/api/auth/me');
  }

  /* ============================ 安全回归 ============================ */
  section('安全 · 私有资源隔离与检索越权');
  {
    // 管理员个人库中一份未共享的私密文件
    const secretToken = '绝密暗号ZZZ997';
    const fd = new FormData();
    fd.append('workspaceId', personalWs);
    fd.append('file', new Blob([`# 机密\n\n本文件包含 ${secretToken}，不得外泄。`], { type: 'text/markdown' }), '机密.md');
    const up = await api('POST', '/api/files/upload', fd);
    eq(up.status, 201, '私密文件上传成功');
    const secretId = up.data.files[0].id;
    await json('PATCH', `/api/files/${secretId}`, { private: true });
    await waitFor(async () => {
      const t = await json('GET', `/api/files/${secretId}/text`);
      return t.data.status === 'ok';
    }, { label: '私密文件解析完成' });

    const own = await json('GET', `/api/search?workspaceId=${personalWs}&q=${encodeURIComponent(secretToken)}`);
    check(own.data.total >= 1, '所有者可检索到私密文件', own.data.total);

    const savedCookie = cookie;
    cookie = '';
    await json('POST', '/api/auth/login', { email: 'lily@example.com', password: 'lily12345' });

    const crossSearch = await json('GET', `/api/search?workspaceId=all&q=${encodeURIComponent(secretToken)}`);
    check(crossSearch.data.total === 0, '他人无法跨库检索到私密文件', crossSearch.data.total);

    const idor = await json('GET', `/api/search/suggest?workspaceId=${personalWs}&q=${encodeURIComponent('机密')}`);
    eq(idor.status, 403, '检索建议接口拒绝越权知识库（403）');

    const askLeak = await json('POST', '/api/ai/ask', { question: `关于 ${secretToken} 的内容`, stream: false });
    const leaked = (askLeak.data.citations || []).some((c) => c.fileId === secretId);
    check(!leaked, 'RAG 问答不会引用他人私密文件', askLeak.data.citations);

    cookie = savedCookie;
    await json('GET', '/api/auth/me');
  }

  /* ============================ AI / RAG ============================ */
  section('AI · RAG 问答 / 摘要 / 提炼 / 关联');
  {
    const status = await json('GET', '/api/ai/status');
    eq(status.status, 200, 'AI 状态接口可用');
    check(status.data.effective.provider !== undefined, '返回实际生效的提供商', status.data.effective);
    check(status.data.index.indexed >= 1, '已有文件完成索引', status.data.index);

    // 测试连接：使用表单值探测且不写库
    const aiTest = await json('POST', '/api/users/me/ai/test', { provider: 'local', model: '', baseUrl: '', apiKey: '' });
    eq(aiTest.status, 200, '测试连接接口可用');
    eq(aiTest.data.status.provider, 'local', '内置引擎测试返回 local');
    const aiTestBadUrl = await json('POST', '/api/users/me/ai/test', { provider: 'openai', baseUrl: 'ftp://x', apiKey: 'k' });
    eq(aiTestBadUrl.status, 400, '测试连接拒绝非法 Base URL');
    const afterTest = await json('GET', '/api/users/me/ai');
    check(!afterTest.data.config.provider, '测试连接不会写入配置', afterTest.data.config.provider);

    const ask = await json('POST', '/api/ai/ask', {
      question: '本季度营收增长了多少？主要驱动力是什么？',
      workspaceId: personalWs,
      stream: false
    });
    eq(ask.status, 200, 'RAG 问答可用');
    check(typeof ask.data.answer === 'string' && ask.data.answer.length > 20, '生成了回答内容');
    check(Array.isArray(ask.data.citations) && ask.data.citations.length > 0, '回答附带引用来源', ask.data.citations?.length);
    check(ask.data.citations[0].fileId === fileId, '引用指向正确的文件');
    check(ask.data.answer.includes('23.4') || ask.data.answer.includes('企业服务'), '回答包含文档中的事实', ask.data.answer.slice(0, 200));

    const ask2 = await json('POST', '/api/ai/ask', { question: '完全不相关的量子纠缠问题', workspaceId: personalWs, stream: false });
    check(ask2.data.answer.length > 0, '无依据问题时仍给出结构化回复');

    const streamed = await streamAsk('下季度的重点计划是什么？', personalWs);
    check(streamed.tokens > 0, '流式问答返回了 token', streamed.tokens);
    check(streamed.events.includes('contexts'), '流式响应先推送引用');
    check(streamed.events.includes('done'), '流式响应以 done 结束');

    const analyze = await json('POST', '/api/ai/analyze', { fileId, kind: 'all' });
    eq(analyze.status, 200, '文档智能解析可用');
    check(analyze.data.result.local.summary.content.length > 20, '生成了摘要');
    check(analyze.data.result.local.outline.items.length > 0, '生成了大纲');
    check(analyze.data.result.local.keywords.items.length > 0, '生成了关键词');

    const analysis = await json('GET', `/api/files/${fileId}/analysis`);
    check(Object.keys(analysis.data.latest).length >= 1, '解析结果已持久化', Object.keys(analysis.data.latest));

    const related = await json('GET', `/api/files/${fileId}/related`);
    eq(related.status, 200, '相关知识接口可用');

    const expand = await json('POST', '/api/ai/expand', { topic: '知识库检索', workspaceId: personalWs });
    eq(expand.status, 200, '知识拓展可用');
    check(expand.data.local.questions.length > 0, '生成了延伸问题');

    const graph = await json('GET', `/api/workspaces/${personalWs}/graph`);
    eq(graph.status, 200, '知识图谱接口可用');
    check(Array.isArray(graph.data.nodes), '图谱返回节点数组');
  }

  /* ============================ 会话管理 ============================ */
  section('会话 · 列表 / 详情 / 删除');
  {
    const chats = await json('GET', `/api/chats?workspaceId=${personalWs}`);
    eq(chats.status, 200, '会话列表可用');
    check(chats.data.chats.length >= 1, '问答已生成会话记录', chats.data.chats.length);
    const chatId = chats.data.chats[0].id;

    const detail = await json('GET', `/api/chats/${chatId}`);
    check(detail.data.messages.length >= 2, '会话包含用户与助手消息', detail.data.messages.length);
    const assistant = detail.data.messages.find((m) => m.role === 'assistant');
    check(assistant?.citations?.length > 0, '助手消息保存了引用');

    const del = await json('DELETE', `/api/chats/${chatId}`);
    eq(del.status, 200, '删除会话成功');
  }

  /* ============================ 备份与导出 ============================ */
  section('备份 · 创建 / 下载 / 检查 / 导出');
  {
    const backup = await json('POST', '/api/backups', { kind: 'full', note: 'e2e 全量备份' });
    eq(backup.status, 201, '创建全量备份成功');
    check(backup.data.backup.size > 0, '备份包非空', backup.data.backup.sizeText);

    const list = await json('GET', '/api/backups');
    check(list.data.backups.length >= 1, '备份列表可用');
    check(list.data.backups[0].exists, '备份文件存在磁盘上');

    const dl = await api('GET', `/api/backups/${backup.data.backup.id}/download`, undefined, { raw: true });
    eq(dl.status, 200, '下载备份成功');
    check(dl.data.length > 0, '备份内容非空');
    check(dl.data.subarray(0, 2).toString() === 'PK', '备份包是合法 ZIP');

    // 加密备份
    const enc = await json('POST', '/api/backups', { kind: 'metadata', encrypt: true, password: 'secret-pass' });
    eq(enc.status, 201, '创建加密备份成功');
    check(enc.data.backup.encrypted, '加密标志正确');
    const dlEnc = await api('GET', `/api/backups/${enc.data.backup.id}/download`, undefined, { raw: true });
    check(dlEnc.data.subarray(0, 8).toString() === 'KBPBAK01', '加密备份带有魔数头');

    const shortPw = await json('POST', '/api/backups', { kind: 'metadata', encrypt: true, password: '123' });
    eq(shortPw.status, 400, '过短口令被拒绝');

    // 知识库导出
    const exp = await api('GET', `/api/workspaces/${personalWs}/export`, undefined, { raw: true });
    eq(exp.status, 200, '知识库导出成功');
    check(exp.data.subarray(0, 2).toString() === 'PK', '导出包是合法 ZIP');
    check(exp.data.length > 500, '导出包包含内容', exp.data.length);

    // 校验导出的 ZIP 可被解压
    const zlib = await import('node:zlib');
    const { listZip, readZipEntry } = await import('../server/lib/archive.js');
    const entries = listZip(exp.data);
    check(entries.length >= 2, '导出包内条目数合理', entries.length);
    check(entries.some((e) => e.name === 'manifest.json'), '导出包含 manifest.json');
    check(entries.some((e) => e.name === 'README.md'), '导出包含 README.md');
    const manifest = JSON.parse(readZipEntry(exp.data, entries.find((e) => e.name === 'manifest.json')).toString('utf8'));
    check(manifest.files.length >= 1, 'manifest 记录了文件');
    check(manifest.notes.length >= 1, 'manifest 记录了笔记');
  }

  /* ============================ 个人中心与审计 ============================ */
  section('个人中心 · 资料 / 密码 / 存储 / 审计');
  {
    const upd = await json('PATCH', '/api/users/me', { name: '知识库管理员', title: '平台负责人', bio: 'KBPRO 管理员' });
    eq(upd.status, 200, '更新个人资料成功');
    eq(upd.data.user.name, '知识库管理员', '昵称已更新');

    const storage = await json('GET', '/api/users/me/storage');
    eq(storage.status, 200, '存储用量接口可用');
    check(storage.data.used > 0, '存储用量已统计', storage.data.usedText);

    const pw = await json('POST', '/api/users/me/password', { oldPassword: 'admin12345', newPassword: 'newpass12345' });
    eq(pw.status, 200, '修改密码成功');
    check(!!pw.data.token, '修改密码后重新签发会话');

    cookie = '';
    const oldLogin = await json('POST', '/api/auth/login', { email: 'admin@kbpro.local', password: 'admin12345' });
    eq(oldLogin.status, 401, '旧密码已失效');
    const newLogin = await json('POST', '/api/auth/login', { email: 'admin@kbpro.local', password: 'newpass12345' });
    eq(newLogin.status, 200, '新密码登录成功');

    const logs = await json('GET', '/api/logs?limit=50');
    eq(logs.status, 200, '审计日志可用');
    check(logs.data.total > 0, '审计日志有记录', logs.data.total);
    check(logs.data.logs.some((l) => l.action === 'file.upload'), '记录了文件上传操作');
    check(logs.data.logs.some((l) => l.action === 'login.success'), '记录了登录操作');

    const stats = await json('GET', '/api/system/stats');
    eq(stats.status, 200, '系统统计可用');
    check(stats.data.counts.files >= 1, '统计包含文件数');

    const settings = await json('GET', '/api/settings');
    eq(settings.status, 200, '管理员可读取实例设置');

    const patched = await json('PATCH', '/api/settings', { ragTopK: 10, ai: { temperature: 0.3 } });
    eq(patched.status, 200, '管理员可更新实例设置');
    const after = await json('GET', '/api/settings');
    eq(after.data.settings.ragTopK, 10, '设置已生效');
  }

  /* ============================ 边界 ============================ */
  section('AI 提供商探测 · 降级必须如实上报');
  {
    const status = await json('GET', '/api/ai/status');
    eq(status.status, 200, 'AI 状态接口可用');
    eq(status.data.effective.provider, status.data.status.provider,
      'effective.provider 与实际探测结果一致（不会把不可用的大模型报成已就绪）');
    check(['local', 'ollama', 'openai'].includes(status.data.effective.provider),
      'effective.provider 取值合法', status.data.effective.provider);
    check(typeof status.data.status.note === 'string' && status.data.status.note.length > 0,
      '返回人类可读的状态说明', status.data.status.note);
    check(typeof status.data.effective.embedModel === 'string', '返回嵌入模型字段');

    // Ollama 地址归一化：不能把监听地址 0.0.0.0 当成连接地址
    const { normalizeOllamaUrl, resolveAiConfig } = await import('../server/lib/ai.js');
    const { encryptText } = await import('../server/lib/crypto.js');
    eq(normalizeOllamaUrl('0.0.0.0'), 'http://127.0.0.1:11434', '0.0.0.0 归一化为本机回环地址');
    eq(normalizeOllamaUrl(':11434'), 'http://127.0.0.1:11434', ':11434 补全主机名');
    eq(normalizeOllamaUrl('127.0.0.1:11434'), 'http://127.0.0.1:11434', '裸 host:port 补全协议');
    eq(normalizeOllamaUrl(''), 'http://127.0.0.1:11434', '空值回退默认地址');
    eq(normalizeOllamaUrl('http://localhost:11434'), 'http://127.0.0.1:11434', 'localhost 归一化为回环');
    eq(normalizeOllamaUrl('https://ollama.example.com'), 'https://ollama.example.com', 'https 不强行追加 11434');
    eq(normalizeOllamaUrl('10.0.0.5'), 'http://10.0.0.5:11434', '远程主机补默认端口');

    // 模型默认值：不得把 OpenAI 的模型名硬套到其它兼容接口（否则静默回退本地引擎）
    const keyEnc = encryptText('dummy-key');
    const ds = resolveAiConfig({ ai_provider: 'openai', ai_base_url: 'https://api.deepseek.com/v1', ai_model: '', ai_key_enc: keyEnc });
    eq(ds.provider, 'openai', '显式 openai + baseUrl + key 生效');
    eq(ds.chatModel, 'deepseek-chat', 'DeepSeek 未填模型时推断为 deepseek-chat');
    const unknown = resolveAiConfig({ ai_provider: 'openai', ai_base_url: 'https://gateway.example.com/v1', ai_model: '', ai_key_enc: keyEnc });
    eq(unknown.chatModel, '', '未知兼容接口不编造模型名');
    eq(unknown.modelMissing, true, '未指定模型时标记 modelMissing');
    eq(unknown.embedModel, '', '未知兼容接口不编造嵌入模型');
    // 「自动」+ 仅填 Key（无 baseUrl）不应把 key 当作可用
    const autoKeyOnly = resolveAiConfig({ ai_provider: 'auto', ai_base_url: '', ai_model: '', ai_key_enc: keyEnc });
    check(autoKeyOnly.provider !== 'openai', '只有 Key 没有 Base URL 时不会启用大模型', autoKeyOnly.provider);
  }

  /* ============================ 权限边界 ============================ */
  section('边界 · 未登录 / 非法参数 / 越权');
  {
    const saved = cookie;
    cookie = '';
    const anon = await json('GET', '/api/files?workspaceId=' + personalWs);
    eq(anon.status, 401, '未登录访问被拒绝（401）');
    cookie = saved;

    const noWs = await json('GET', '/api/files');
    eq(noWs.status, 400, '缺少 workspaceId 返回 400');

    const fake = await json('GET', '/api/files/not-a-real-file-id');
    eq(fake.status, 404, '不存在的文件返回 404');

    const fakeApi = await json('GET', '/api/does/not/exist');
    eq(fakeApi.status, 404, '不存在的接口返回 404');

    const badJson = await fetch(`${BASE}/api/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{bad json'
    });
    eq(badJson.status, 400, '非法 JSON 返回 400');
  }
}

/* ------------------------------------------------------------------ 流式问答 */

async function streamAsk(question, workspaceId) {
  const res = await fetch(`${BASE}/api/ai/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ question, workspaceId, stream: true })
  });
  if (!res.ok) throw new Error(`流式请求失败 ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let tokens = 0;
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() || '';
    for (const block of blocks) {
      const evLine = block.split('\n').find((l) => l.startsWith('event:'));
      const dataLines = block.split('\n').filter((l) => l.startsWith('data:'));
      if (!evLine) continue;
      const ev = evLine.slice(6).trim();
      if (!events.includes(ev)) events.push(ev);
      if (ev === 'token') tokens++;
      void dataLines;
    }
  }
  return { tokens, events };
}

main().catch((err) => {
  console.error('\n\x1b[31m测试执行异常：\x1b[0m', err);
  process.exit(1);
});
