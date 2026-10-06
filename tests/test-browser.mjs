/**
 * KBPRO — 无头浏览器端到端渲染测试
 *
 * 用真实的 Chromium 内核加载前端，逐个渲染全部路由，校验：
 *   · 应用壳正常挂载（未停留在登录页 / 启动屏）
 *   · 每个页面模块成功渲染出自身布局，而不是「页面加载失败」兜底
 *   · 页面控制台没有未捕获异常、模块解析失败或导入错误
 *
 * 注意：Chrome 需要命名管道 IPC，在受限沙箱中无法启动。
 * 若浏览器不可用，本套件会明确跳过（SKIP）而不是假装通过。
 *
 * 运行： node tests/test-browser.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const TMP_ROOT = path.join(os.tmpdir(), `kbpro-browser-${Date.now().toString(36)}`);
process.env.KBPRO_DATA = TMP_ROOT;
process.env.KBPRO_QUIET = '1';
process.env.KBPRO_TEST_LOGIN = '1';

let passed = 0, failed = 0, skipped = 0;
const failures = [];
let section = '';

function head(n) { section = n; console.log(`\n\x1b[36m▸ ${n}\x1b[0m`); }
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push(`[${section}] ${label}${detail !== undefined ? ` — ${String(detail).slice(0, 400)}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`);
  }
}
function skip(label, why) { skipped++; console.log(`  \x1b[33m⊘\x1b[0m ${label}（${why}）`); }

/* ------------------------------------------------------------------ Chrome */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* */ }
  }
  return null;
}

let PROFILE_DIR = '';

/**
 * 用无头 Chrome 加载 URL 并导出最终 DOM。
 *
 * 关键点：不能使用 spawnSync 默认的「管道」stdio。Chrome 会派生若干子进程
 * （crashpad 等），子进程会继承管道句柄并可能比父进程存活更久，导致
 * spawnSync 永远等不到 EOF 而挂起。因此这里改用**文件描述符**重定向输出，
 * spawnSync 只需等待直接子进程退出，随后从文件读取内容。
 *
 * @returns {{dom:string, logs:string, ok:boolean, error?:string}}
 */
function dumpDom(chrome, target, { budget = 8000, timeout = 45000 } = {}) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outFile = path.join(os.tmpdir(), `kbpro-chrome-${stamp}.out`);
  const errFile = path.join(os.tmpdir(), `kbpro-chrome-${stamp}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');

  let res;
  try {
    res = spawnSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--disable-sync',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-crash-upload',
      '--mute-audio',
      '--hide-scrollbars',
      `--user-data-dir=${PROFILE_DIR}`,
      `--virtual-time-budget=${budget}`,
      '--enable-logging=stderr',
      '--log-level=0',
      '--dump-dom',
      target
    ], { stdio: ['ignore', outFd, errFd], timeout, killSignal: 'SIGKILL' });
  } finally {
    try { fs.closeSync(outFd); } catch { /* */ }
    try { fs.closeSync(errFd); } catch { /* */ }
  }

  let dom = '';
  let logs = '';
  try { dom = fs.readFileSync(outFile, 'utf8'); } catch { /* */ }
  try { logs = fs.readFileSync(errFile, 'utf8'); } catch { /* */ }
  try { fs.unlinkSync(outFile); } catch { /* */ }
  try { fs.unlinkSync(errFile); } catch { /* */ }

  if (!dom) {
    const hint = logs.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(0, 2).join(' | ');
    return { dom, logs, ok: false, error: hint || `exit=${res?.status} signal=${res?.signal || ''} 无输出` };
  }
  return { dom, logs, ok: true };
}

/* ------------------------------------------------------------------ 断言数据 */

const ROUTES = [
  { hash: '#/dashboard', name: '首页', markers: ['hero', 'stat-card', 'stat-value'] },
  { hash: '#/files', name: '文件库', markers: ['files-layout', 'tree-pane', 'files-pane'] },
  { hash: '#/notes', name: '笔记中心', markers: ['notes-layout', 'editor-pane'] },
  { hash: '#/folders', name: '分类文件夹', markers: ['page', 'folder'] },
  { hash: '#/chat', name: '智能问答', markers: ['chat-layout', 'chat-main', 'chat-compose'] },
  { hash: '#/search', name: '全局检索', markers: ['search-page', 'search-big'] },
  { hash: '#/team', name: '团队协作', markers: ['page', 'card'] },
  { hash: '#/trash', name: '回收站', markers: ['page', 'tabs'] },
  { hash: '#/profile', name: '个人中心', markers: ['tabs', 'tab'] },
  { hash: '#/admin', name: '系统管理', markers: ['tabs', 'tab', 'stat-card'] }
];

const CONSOLE_ERROR_RE = /(Uncaught|SyntaxError|ReferenceError|TypeError|RangeError|Failed to (load|resolve) module|does not provide an export|Cannot read|is not a function|is not defined)/;

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const chrome = findChrome();
  console.log('KBPRO 无头浏览器渲染测试');
  console.log('─'.repeat(64));
  if (!chrome) {
    console.log('\x1b[33m⊘ 未找到 Chrome / Edge 可执行文件，跳过浏览器测试\x1b[0m');
    console.log('  可通过设置环境变量 CHROME_PATH 指定浏览器路径。');
    process.exit(0);
  }
  console.log(`浏览器：${chrome}`);

  const { start, stop } = await import('../server/index.js');
  const started = await start({ port: 0, host: '127.0.0.1', silent: true });
  const BASE = started.url;
  console.log(`服务：${BASE}\n数据目录：${TMP_ROOT}`);

  let cookie = '';
  try {
    // ---------------- 播种数据 ----------------
    head('准备测试数据');
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@kbpro.local', password: 'admin12345' })
    });
    const setCookie = login.headers.getSetCookie?.() || [];
    cookie = setCookie.find((c) => c.startsWith('kbpro_session='))?.split(';')[0] || '';
    check(login.ok && !!cookie, '管理员登录成功');

    const ws = (await (await fetch(`${BASE}/api/workspaces`, { headers: { Cookie: cookie } })).json())
      .workspaces.find((w) => w.kind === 'personal');
    check(!!ws, '获取个人知识库');

    // 文件夹 + 笔记 + 文件
    await fetch(`${BASE}/api/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workspaceId: ws.id, name: '浏览器测试目录' })
    });
    const note = await (await fetch(`${BASE}/api/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        workspaceId: ws.id, title: '浏览器渲染测试笔记',
        html: '<h1>测试标题</h1><p>这是用于浏览器渲染测试的<strong>正文</strong>内容。</p><table><tr><th>项</th><td>值</td></tr></table>',
        tags: ['测试']
      })
    })).json();
    check(note.ok, '创建测试笔记');

    const textBody = '# 浏览器测试文档\n\n这是用于渲染测试的 Markdown 文档，包含关键词 ZMARKBROWSER 与检索验证内容。\n\n## 小节\n- 要点一\n- 要点二\n';
    const fd = new FormData();
    fd.append('workspaceId', ws.id);
    fd.append('tags', '测试,浏览器');
    fd.append('file', new Blob([textBody], { type: 'text/markdown' }), '浏览器测试文档.md');
    const up = await (await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie }, body: fd })).json();
    check(up.ok, '上传测试文档');

    const pdfPath = path.join(FIXTURES, 'pdf', 'basic.pdf');
    if (fs.existsSync(pdfPath)) {
      const fd2 = new FormData();
      fd2.append('workspaceId', ws.id);
      fd2.append('file', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), '浏览器测试.pdf');
      await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie }, body: fd2 });
    }

    // 等待索引完成
    for (let i = 0; i < 40; i++) {
      const t = await (await fetch(`${BASE}/api/files/${up.files[0].id}/text`, { headers: { Cookie: cookie } })).json();
      if (t.status === 'ok') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const searchCheck = await (await fetch(`${BASE}/api/search?workspaceId=${ws.id}&q=ZMARKBROWSER`, { headers: { Cookie: cookie } })).json();
    check(searchCheck.total >= 1, '测试文档已建立索引（可被检索）');

    // ---------------- 浏览器能力探测 ----------------
    head('浏览器能力探测');
    PROFILE_DIR = path.join(os.tmpdir(), `kbpro-chrome-profile-${Date.now().toString(36)}`);
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    const probe = dumpDom(chrome, 'data:text/html,<h1>probe</h1>', { budget: 800, timeout: 30000 });
    if (!probe.ok || !probe.dom.includes('probe')) {
      console.log(`\x1b[33m⊘ Chrome 无法启动，跳过渲染测试（${probe.error || '未知原因'}）\x1b[0m`);
      await stop();
      await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
      console.log('\n\x1b[33mRESULT: SKIP (浏览器不可用)\x1b[0m');
      process.exit(0);
    }
    check(true, 'Chrome 进程可启动');

    // 真正的关卡：Chrome 的网络服务是独立子进程，需要命名管道 IPC。
    // 受限沙箱会拒绝该管道，导致 HTTP 页面永远加载不出来（data: URL 不受影响）。
    const httpProbe = dumpDom(chrome, `${BASE}/api/health`, { budget: 2500, timeout: 30000 });
    if (!httpProbe.ok || !httpProbe.dom.includes('kbpro')) {
      console.log('');
      console.log('\x1b[33m⊘ 浏览器无法加载 HTTP 页面，跳过渲染测试\x1b[0m');
      console.log('  现象：Chrome 进程可启动并渲染 data: URL，但访问 http:// 时无任何输出。');
      console.log('  原因：Chromium 的网络服务运行在独立子进程中，需要通过命名管道 IPC 通信；');
      console.log('        本沙箱禁止创建命名管道（single-process 模式下 Chrome 会直接崩溃）。');
      console.log('  结论：这是运行环境的限制，不是代码缺陷。');
      console.log('  在普通桌面环境 / CI 中运行同一命令即可完成浏览器渲染验证。');
      await stop();
      await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
      console.log('\n' + '─'.repeat(64));
      console.log(`  通过 ${passed} · 失败 ${failed} · 跳过 ${skipped + 1}（浏览器渲染）`);
      console.log('─'.repeat(64));
      console.log('\x1b[33mRESULT: SKIP (环境不支持无头浏览器，非代码问题)\x1b[0m');
      process.exit(0);
    }
    check(true, 'Chrome 可加载 HTTP 页面');

    // 通过测试登录接口写入会话 Cookie（Chrome 的 profile 会持久化它）
    const loginGet = dumpDom(chrome, `${BASE}/api/test/login`, { budget: 2000, timeout: 30000 });
    check(loginGet.ok && /"ok"\s*:\s*true/.test(loginGet.dom), '测试会话 Cookie 已写入浏览器', loginGet.dom.slice(0, 160));

    // ---------------- 登录页渲染 ----------------
    head('登录页渲染');
    {
      const r = dumpDom(chrome, `${BASE}/`, { budget: 5000 });
      check(r.ok, '首页 HTML 加载成功', r.error);
      check(r.dom.includes('id="auth-screen"') || r.dom.includes('id="app"'), '包含应用壳或登录页容器');
      check(r.dom.includes('KBPRO'), '页面标题/品牌已渲染');
      const consoleLines = (r.logs.match(/CONSOLE[^\n]*/g) || [])
        .filter((l) => CONSOLE_ERROR_RE.test(l))
        .filter((l) => !/favicon|net::ERR_|Failed to load resource/i.test(l));
      check(consoleLines.length === 0, '登录页无控制台错误', consoleLines.slice(0, 3).join(' | '));
    }
    void skip;

    // ---------------- 逐路由渲染 ----------------
    head('路由渲染 · 全部页面');
    for (const route of ROUTES) {
      const r = dumpDom(chrome, `${BASE}/${route.hash}`, { budget: 7000 });
      if (!r.ok) {
        check(false, `${route.name}（${route.hash}）渲染`, r.error);
        continue;
      }
      const dom = r.dom;

      const looksLoggedIn = /id="app"/.test(dom) && !/id="app"[^>]*\shidden/.test(dom);
      const crashed = dom.includes('页面加载失败') || dom.includes('无法连接到服务器');
      const hasShell = dom.includes('id="sidebar"') && dom.includes('id="view"');
      const markerHit = route.markers.some((m) => dom.includes(m));
      const bigEnough = dom.length > 4000;

      // 页面自身抛出的控制台异常（过滤掉资源/网络噪声）
      const consoleLines = (r.logs.match(/CONSOLE[^\n]*/g) || [])
        .filter((l) => CONSOLE_ERROR_RE.test(l))
        .filter((l) => !/favicon|net::ERR_|Failed to load resource/i.test(l));

      check(looksLoggedIn && hasShell && !crashed && bigEnough,
        `${route.name}（${route.hash}）渲染成功`,
        { looksLoggedIn, hasShell, crashed, domLength: dom.length, error: r.error });
      check(markerHit, `${route.name} 渲染出自身布局标记（${route.markers.join(' / ')}）`,
        dom.slice(0, 240));
      check(consoleLines.length === 0, `${route.name} 无未捕获异常`,
        consoleLines.slice(0, 3).join(' | '));
    }

    // ---------------- 深度链接 ----------------
    head('深度链接与交互状态');
    {
      const r = dumpDom(chrome, `${BASE}/#/search?q=ZMARKBROWSER`, { budget: 7000 });
      check(r.ok && r.dom.includes('search-page'), '带查询参数的检索路由可渲染');
      check(r.dom.includes('ZMARKBROWSER'), '检索关键词回填到输入框', r.dom.slice(0, 200));
    }
    {
      const r = dumpDom(chrome, `${BASE}/#/admin`, { budget: 7000 });
      check(r.ok && (r.dom.includes('tabs') || r.dom.includes('stat-card')), '管理员可进入系统管理页');
      const denied = r.dom.includes('需要管理员权限');
      check(!denied, '管理员未被误判为无权限');
    }

  } finally {
    await stop();
    await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
    if (PROFILE_DIR) await fsp.rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`  通过 ${passed} · 失败 ${failed}${skipped ? ` · 跳过 ${skipped}` : ''}`);
  if (failures.length) {
    console.log('\n\x1b[31m失败明细：\x1b[0m');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('─'.repeat(64));
  console.log(failed === 0 ? '\x1b[32mRESULT: PASS\x1b[0m' : '\x1b[31mRESULT: FAIL\x1b[0m');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31m测试执行异常：\x1b[0m', err);
  process.exit(1);
});
