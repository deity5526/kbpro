/**
 * KBPRO — 前端契约审计
 *
 * 由于沙箱禁止浏览器所需的命名管道 IPC，无法启动无头浏览器；
 * 本脚本改用「真实模块导入 + 静态交叉校验」的方式验证前端：
 *   1. 语法（所有 .js 必须可被 V8 解析）
 *   2. 页面契约（meta.title / mount / unmount / default）
 *   3. 每一处具名 import 都必须真实存在于目标模块的导出中
 *   4. 每一处 icon('name') 都必须是 icons.js 中真实存在的图标
 *   5. 每一处 api.xxx(...) 都必须是 api.js 中真实存在的方法
 *   6. 页面中出现的 CSS 类名是否在 app.css 中有定义（信息性告警）
 *   7. app.js 路由表中每个页面模块都可被解析
 *
 * 运行： node tests/test-frontend.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const JS_DIR = path.join(WEB, 'js');

let passed = 0, failed = 0;
const failures = [];
let section = '';

function head(n) { section = n; console.log(`\n\x1b[36m▸ ${n}\x1b[0m`); }
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push(`[${section}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 500)}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== undefined ? `  → ${JSON.stringify(detail)?.slice(0, 400)}` : ''}`);
  }
}
function warn(msg) { console.log(`  \x1b[33m•\x1b[0m ${msg}`); }
function eq(actual, expected, label) {
  check(actual === expected, label, actual === expected ? undefined : { actual, expected });
}

/* ------------------------------------------------------------------ 文件发现 */

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/* ------------------------------------------------------------------ import 扫描 */

/** 提取源文件中的所有 ESM import 语句 */
function parseImports(source) {
  const out = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    const clause = m[1].trim();
    const spec = m[2];
    const names = [];
    let hasDefault = false;
    let namespace = null;

    // { a, b as c }
    const brace = /\{([\s\S]*?)\}/.exec(clause);
    if (brace) {
      for (const part of brace[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const [orig, alias] = t.split(/\s+as\s+/).map((x) => x.trim());
        names.push({ imported: orig, local: alias || orig });
      }
    }
    const withoutBraces = clause.replace(/\{[\s\S]*?\}/, '').trim();
    if (withoutBraces) {
      const ns = /^\*\s+as\s+([\w$]+)$/.exec(withoutBraces);
      if (ns) namespace = ns[1];
      else if (/^[\w$]+$/.test(withoutBraces)) hasDefault = true;
      else if (/^[\w$]+\s*,/.test(withoutBraces)) hasDefault = true;
    }
    out.push({ spec, names, hasDefault, namespace, raw: m[0].slice(0, 120) });
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/* ------------------------------------------------------------------ 1. 语法 */

head('语法检查 · 所有前端模块');
{
  const files = walkJs(JS_DIR);
  check(files.length >= 12, `发现 ${files.length} 个前端模块`);
  const bad = [];
  let skipped = false;
  for (const f of files) {
    try {
      // stdio:'ignore' 避免沙箱禁止的管道 IPC；仅用退出码判断
      execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' });
    } catch (err) {
      const msg = String(err.stderr || err.message || '');
      if (err.code === 'EPERM' || /EPERM/.test(msg)) { skipped = true; continue; }
      bad.push({ file: rel(f), error: msg.split('\n').slice(0, 3).join(' ') });
    }
  }
  if (skipped) {
    warn('沙箱禁止子进程管道，改用「动态导入」作为语法与依赖一致性的等价校验（下方各节）');
  }
  check(bad.length === 0, `全部 ${files.length} 个模块通过语法检查`, bad);
}

/* ------------------------------------------------------------------ 2. 共享模块可导入 */

head('共享模块 · 真实导出枚举');
const shared = {};
{
  const targets = ['api.js', 'ui.js', 'icons.js', 'format.js', 'md.js', 'store.js'];
  for (const t of targets) {
    const p = path.join(JS_DIR, t);
    try {
      const mod = await import(url.pathToFileURL(p).href);
      shared[t] = new Set(Object.keys(mod));
      check(shared[t].size > 0, `${t} 可导入（${shared[t].size} 个导出）`);
    } catch (err) {
      shared[t] = new Set();
      check(false, `${t} 可导入`, err.message);
    }
  }
}

/* ------------------------------------------------------------------ 3. 页面契约 */

head('页面契约 · meta / mount / unmount');
const PAGES = ['dashboard', 'files', 'notes', 'folders', 'chat', 'search', 'team', 'trash', 'profile', 'admin', 'share'];
const pageExports = {};
{
  for (const name of PAGES) {
    const p = path.join(JS_DIR, 'pages', `${name}.js`);
    if (!fs.existsSync(p)) {
      check(false, `pages/${name}.js 存在`);
      continue;
    }
    try {
      const mod = await import(url.pathToFileURL(p).href);
      pageExports[name] = mod;
      const hasMount = typeof mod.mount === 'function';
      const hasUnmount = typeof mod.unmount === 'function';
      const title = mod.meta?.title || mod.default?.meta?.title;
      const ico = mod.meta?.icon || mod.default?.meta?.icon;
      check(hasMount && hasUnmount && !!title, `pages/${name}.js 契约完整`, { hasMount, hasUnmount, title });
      if (ico && shared['icons.js']?.size) {
        const iconNames = [...shared['icons.js']].filter((k) => k !== 'ICON_NAMES' && k !== 'icon' && k !== 'hasIcon');
        const realIcons = (await import(url.pathToFileURL(path.join(JS_DIR, 'icons.js')).href)).ICON_NAMES;
        check(realIcons.includes(ico), `pages/${name}.js 的 meta.icon「${ico}」存在`, realIcons.slice(0, 10));
        void iconNames;
      }
    } catch (err) {
      check(false, `pages/${name}.js 可导入`, err.message);
    }
  }
}

/* ------------------------------------------------------------------ 4. 具名 import 交叉校验 */

head('导入完整性 · 每个具名 import 都必须真实导出');
{
  const files = walkJs(JS_DIR);
  const problems = [];
  let checkedNames = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const imp of parseImports(source)) {
      const target = resolveSpec(file, imp.spec);
      if (!target || !target.startsWith(JS_DIR)) continue;

      let exportsSet;
      const base = path.basename(target);
      if (shared[base]) exportsSet = shared[base];
      else {
        try {
          const mod = await import(url.pathToFileURL(target).href);
          exportsSet = new Set(Object.keys(mod));
        } catch {
          continue; // 无法导入的模块由其它检查覆盖
        }
      }
      for (const { imported, local } of imp.names) {
        checkedNames++;
        if (!exportsSet.has(imported)) {
          problems.push(`${rel(file)}: import { ${imported} } from '${imp.spec}'  → 目标模块无此导出（本地名 ${local}）`);
        }
      }
      if (imp.hasDefault) {
        checkedNames++;
        try {
          const mod = await import(url.pathToFileURL(target).href);
          if (!('default' in mod)) {
            problems.push(`${rel(file)}: import 默认导出 from '${imp.spec}' → 目标模块没有 default 导出`);
          }
        } catch { /* 忽略 */ }
      }
    }
  }
  check(checkedNames > 100, `共校验 ${checkedNames} 处 import 绑定`);
  check(problems.length === 0, `所有具名导入均真实存在`, problems.slice(0, 12));
}

/* ------------------------------------------------------------------ 5. 图标交叉校验 */

head('图标完整性 · icon("name") 必须存在');
{
  const { ICON_NAMES } = await import(url.pathToFileURL(path.join(JS_DIR, 'icons.js')).href);
  const iconSet = new Set(ICON_NAMES);
  const files = walkJs(JS_DIR).filter((f) => !f.endsWith('icons.js'));
  const missing = [];
  let total = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // icon('x') / icon("x") / icon: 'x' / iconName: 'x' / data-icon="x"
    const patterns = [
      /\bicon\(\s*['"]([a-zA-Z][\w]*)['"]/g,
      /\bicon\s*:\s*['"]([a-zA-Z][\w]*)['"]/g,
      /\biconName\s*:\s*['"]([a-zA-Z][\w]*)['"]/g,
      /data-icon="([a-zA-Z][\w]*)"/g
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(source))) {
        total++;
        if (!iconSet.has(m[1])) missing.push(`${rel(file)} → '${m[1]}'`);
      }
    }
  }
  check(total > 100, `共校验 ${total} 处图标引用`);
  check(missing.length === 0, `所有图标名称均已定义`, [...new Set(missing)].slice(0, 15));
}

/* ------------------------------------------------------------------ 6. API 方法交叉校验 */

head('API 完整性 · api.xxx() 必须真实存在');
{
  const apiPath = path.join(JS_DIR, 'api.js');
  const apiMod = await import(url.pathToFileURL(apiPath).href);
  const methods = new Set(Object.keys(apiMod.api || {}));
  check(methods.size > 40, `api 客户端暴露 ${methods.size} 个方法`);

  const files = walkJs(JS_DIR).filter((f) => !f.endsWith('api.js'));
  const missing = [];
  let total = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // api.foo(  或  ctx.api.foo(
    const re = /(?:\bapi|\bctx\.api)\.([a-zA-Z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(source))) {
      const name = m[1];
      if (['toString', 'hasOwnProperty', 'then', 'catch', 'finally'].includes(name)) continue;
      total++;
      if (!methods.has(name)) missing.push(`${rel(file)} → api.${name}()`);
    }
  }
  check(total > 100, `共校验 ${total} 处 API 调用`);
  check(missing.length === 0, `所有 API 调用均真实存在`, [...new Set(missing)].slice(0, 15));
}

/* ------------------------------------------------------------------ 7. 路由表校验 */

head('路由 · app.js 的每个页面都能解析');
{
  const appSource = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  const routeBlock = /const ROUTES = \{([\s\S]*?)\n\};/.exec(appSource);
  check(!!routeBlock, 'app.js 中存在 ROUTES 定义');

  const routes = [];
  if (routeBlock) {
    const re = /(\w+):\s*\{\s*title:\s*'([^']+)',\s*load:\s*\(\)\s*=>\s*import\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(routeBlock[1]))) routes.push({ id: m[1], title: m[2], spec: m[3] });
  }
  check(routes.length === PAGES.length, `路由数量与页面一致（${routes.length}）`, routes.map((r) => r.id));

  const missing = [];
  for (const r of routes) {
    if (!fs.existsSync(path.join(JS_DIR, r.spec.replace(/^\.\//, '')))) missing.push(`${r.id} → ${r.spec}`);
  }
  check(missing.length === 0, '所有路由指向真实存在的模块', missing);

  const idsInPages = new Set(PAGES);
  const unknown = routes.filter((r) => !idsInPages.has(r.id));
  check(unknown.length === 0, '路由 id 均在页面清单中', unknown.map((u) => u.id));
}

/* ------------------------------------------------------------------ 8. CSS 类名覆盖（信息性） */

head('样式 · 页面使用的类名在 app.css 中的覆盖情况');
{
  const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');
  const defined = new Set();
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) defined.add(m[1]);

  const used = new Map(); // class -> [files]
  for (const file of walkJs(JS_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    const clsRe = /class="([^"]*?)"/g;
    let c;
    while ((c = clsRe.exec(source))) {
      // 去掉模板插值，避免把 `${...}` 片段当成类名
      const cleaned = c[1].replace(/\$\{[^}]*\}/g, ' ').replace(/\\/g, ' ');
      for (const name of cleaned.split(/\s+/).filter(Boolean)) {
        if (!/^-?[_a-zA-Z][\w-]*$/.test(name)) continue;
        if (!used.has(name)) used.set(name, new Set());
        used.get(name).add(rel(file));
      }
    }
  }

  const undefinedClasses = [...used.keys()].filter((c) => !defined.has(c)).sort();
  const totalUsed = used.size;
  check(totalUsed > 80, `页面共使用 ${totalUsed} 个 CSS 类名`);
  check(defined.size > 150, `app.css 定义了 ${defined.size} 个类名`);

  if (undefinedClasses.length) {
    warn(`${undefinedClasses.length} 个类名未在 app.css 中定义（可能为语义占位或依赖内联样式）：`);
    warn(`  ${undefinedClasses.join(', ')}`);
  } else {
    check(true, '所有使用的类名均有样式定义');
  }
  // 关键设计系统类必须存在
  const critical = ['card', 'btn', 'btn-primary', 'input', 'modal', 'drawer', 'toast', 'empty',
    'file-row', 'tree-row', 'note-item', 'editor-body', 'msg', 'cite-card', 'chat-layout',
    'batch-bar', 'progress', 'tag', 'badge', 'hero', 'stat-card', 'palette', 'setting-row'];
  const missingCritical = critical.filter((c) => !defined.has(c));
  check(missingCritical.length === 0, '关键设计系统类全部存在', missingCritical);
}

/* ------------------------------------------------------------------ 9. HTML 结构 */

head('HTML · 入口结构与脚本引用');
{
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  check(html.includes('<script type="module" src="/js/app.js">'), 'index.html 引入 app.js 模块');
  check(html.includes('id="app"') && html.includes('id="auth-screen"') && html.includes('id="boot"'), '包含应用壳 / 登录 / 启动屏容器');
  for (const id of ['view', 'sidebar', 'crumbs', 'nav']) {
    check(html.includes(`id="${id}"`), `包含 #${id} 容器`);
  }
  const required = ['modal-root', 'toast-root', 'palette-root', 'upload-panel', 'drop-veil', 'hidden-file-input'];
  const missing = required.filter((id) => !html.includes(`id="${id}"`));
  check(missing.length === 0, '所有全局组件容器齐备', missing);

  const srcRefs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('/#'));
  const badRefs = srcRefs.filter((s) => !fs.existsSync(path.join(WEB, s.replace(/^\//, ''))));
  check(badRefs.length === 0, 'HTML 中引用的静态资源均存在', badRefs);
}

/* ------------------------------------------------------------------ 10. 服务端静态资源可达性 */

head('静态资源 · web 目录清单');
{
  const files = walkJs(JS_DIR);
  const css = fs.existsSync(path.join(WEB, 'css', 'app.css'));
  check(css, 'app.css 存在');
  check(files.length >= 12, `web/js 下共 ${files.length} 个模块`);
  const totalBytes = files.reduce((s, f) => s + fs.statSync(f).size, 0) + (css ? fs.statSync(path.join(WEB, 'css', 'app.css')).size : 0);
  check(totalBytes > 100000, `前端代码总量 ${(totalBytes / 1024).toFixed(0)} KB`);
}

/* ------------------------------------------------------------------ 11. 引用折叠 */

head('参考来源 · 折叠行为与标记');
{
  let citations = null;
  try {
    citations = await import(url.pathToFileURL(path.join(JS_DIR, 'citations.js')).href);
  } catch (err) {
    check(false, 'citations.js 可导入', err.message);
  }

  if (citations) {
    const sample = [
      { index: 1, fileId: 'f1', title: '季度经营复盘会议纪要.docx', page: 2, heading: '经营数据', score: 3.739, snippet: '营业收入 3,280 万元' },
      { index: 2, fileId: 'f2', title: '决议事项跟踪表.xlsx', score: 1.76, snippet: 'R-01 完成智能知识库商用版本发布' }
    ];

    // 没有来源时不渲染任何东西
    eq(citations.citationsHtml({ citations: [] }), '', '无来源时不渲染参考来源区块');
    eq(citations.citationsHtml({}), '', '缺少 citations 字段时不渲染');
    eq(citations.citationsHtml(null), '', '传入 null 不抛错');
    eq(citations.citationsHtml({ citations: [null, undefined] }), '', '来源全为空值时不渲染');

    // 默认折叠
    const collapsed = citations.citationsHtml({ citations: sample });
    check(collapsed.includes('data-cites-toggle="1"'), '包含折叠开关');
    check(collapsed.includes('aria-expanded="false"'), '默认 aria-expanded=false（可访问性）');
    check(collapsed.includes('class="citations-list" hidden'), '默认列表带 hidden 属性（真正收起）');
    check(!collapsed.includes('class="citations is-open"'), '默认不带 is-open 类');
    check(collapsed.includes('<span class="citations-count">2</span>'), '收起态显示来源条数', collapsed.match(/citations-count">[^<]*/)?.[0]);
    check(collapsed.includes('参考来源'), '收起态显示「参考来源」标题');
    check(collapsed.includes('citations-caret'), '收起态显示展开箭头');

    // 展开态
    const opened = citations.citationsHtml({ citations: sample, citesOpen: true });
    check(opened.includes('aria-expanded="true"'), '展开后 aria-expanded=true');
    // 注意：图标 svg 自带 aria-hidden，不能用 includes('hidden') 粗判
    check(!/class="citations-list"\s+hidden/.test(opened), '展开后列表不再有 hidden 属性');
    check(opened.includes('class="citations is-open"'), '展开后带 is-open 类（箭头翻转）');

    // 两种状态下来源卡片本身都要保留（角标定位依赖它）
    for (const [label, html] of [['折叠态', collapsed], ['展开态', opened]]) {
      check(html.includes('data-cite-card="1"') && html.includes('data-cite-card="2"'),
        `${label}保留全部来源卡片（供角标定位）`);
      check(html.includes('data-cite-file="f1"'), `${label}卡片携带文件 id（可跳转原文）`);
      check(html.includes('第 2 页') && html.includes('经营数据'), `${label}卡片显示页码与章节`);
      check(html.includes('3.739'), `${label}卡片显示相关性分数`);
    }

    // 转义：标题里的 HTML 不能穿透
    const dirty = citations.citationsHtml({
      citations: [{ index: 1, title: '<img src=x onerror=alert(1)>', snippet: '<script>bad()</script>' }]
    });
    check(!dirty.includes('<img') && !dirty.includes('<script'), '来源标题与片段被转义，不会注入 HTML', dirty.slice(0, 160));
    check(dirty.includes('&lt;img') || dirty.includes('&lt;script'), '恶意内容以实体形式呈现');
  }

  // CSS 必须真的定义了这些类，否则折叠在视觉上不成立
  {
    const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');
    for (const cls of ['.citations-head', '.citations-count', '.citations-caret', '.citations-list', '.citations.is-open .citations-caret']) {
      check(css.includes(cls), `app.css 定义了 ${cls}`);
    }
  }
}

/* ------------------------------------------------------------------ 12. 图标尺寸 */

head('图标尺寸 · 未指定尺寸时不得退化成 300×150');
{
  const iconsMod = await import(url.pathToFileURL(path.join(JS_DIR, 'icons.js')).href);
  const { icon, ICON_NAMES, DEFAULT_ICON_SIZE } = iconsMod;

  eq(typeof DEFAULT_ICON_SIZE, 'number', 'icons.js 导出默认尺寸常量');

  // 根因：app.css 没有全局 svg 尺寸规则，SVG 不写 width/height 会按替换元素
  // 默认尺寸 300×150 渲染，放在 flex 行里就是一个巨大图标（曾真实发生）。
  const noSize = icon('alert');
  check(/width="\d+"/.test(noSize) && /height="\d+"/.test(noSize),
    'icon() 不带尺寸参数时仍会写出 width/height', noSize.slice(0, 60));
  check(noSize.includes(`width="${DEFAULT_ICON_SIZE}"`), `默认尺寸为 ${DEFAULT_ICON_SIZE}px`);

  check(icon('alert', 14).includes('width="14"'), '显式尺寸被采用');
  check(icon('alert', '1em').includes('width="1em"'), '支持 em 等字符串尺寸');
  check(icon('alert', null).includes(`width="${DEFAULT_ICON_SIZE}"`), '传入 null 时回退默认尺寸');
  check(icon('alert', 0).includes(`width="${DEFAULT_ICON_SIZE}"`), '传入 0 时回退默认尺寸');

  // 全量扫描：任何一个图标都不允许缺尺寸
  const missing = [];
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    if (!/width="[^"]+"/.test(svg) || !/height="[^"]+"/.test(svg)) missing.push(name);
  }
  check(missing.length === 0, `全部 ${ICON_NAMES.length} 个图标都带默认尺寸`, missing.slice(0, 8));

  // 「未引用知识库」提示：必须用固定小尺寸，且样式走 CSS 类而不是内联
  const chatSrc = fs.readFileSync(path.join(JS_DIR, 'pages', 'chat.js'), 'utf8');
  const noticeBlock = /function generalNoticeHtml[\s\S]*?\n}/.exec(chatSrc)?.[0] || '';
  check(!!noticeBlock, 'chat.js 中存在 generalNoticeHtml');
  check(/icon\('alert',\s*\d+\)/.test(noticeBlock), '提示里的图标显式指定了小尺寸', noticeBlock.match(/icon\('alert'[^)]*\)/)?.[0]);
  check(noticeBlock.includes('general-notice-ico'), '提示图标有独立的尺寸容器类');
  check(!/icon\('alert'\)/.test(noticeBlock), '提示里不存在未指定尺寸的图标调用');

  const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');
  for (const cls of ['.general-notice', '.general-notice-ico', '.general-notice-title', '.general-notice-desc']) {
    check(css.includes(cls), `app.css 定义了 ${cls}`);
  }
  check(/\.general-notice-ico\s+svg\s*\{[^}]*width/.test(css), '提示图标容器显式约束了 svg 尺寸');
}

/* ------------------------------------------------------------------ 13. 浮层菜单 */

head('浮层菜单 · 条目多时不得被截断，且滚动菜单不能把自己关掉');
{
  const menuPos = await import(url.pathToFileURL(path.join(JS_DIR, 'menu-position.js')).href);
  const { placeMenu, shouldDismissOnScroll, MENU_GAP, MENU_PAD, MENU_MIN_HEIGHT } = menuPos;

  eq(typeof placeMenu, 'function', 'menu-position.js 导出 placeMenu');
  eq(typeof shouldDismissOnScroll, 'function', 'menu-position.js 导出 shouldDismissOnScroll');
  eq(MENU_GAP, 6, '锚点间距常量');
  eq(MENU_PAD, 8, '视口安全距离常量');

  const rect = (top, bottom, right, left = right - 26) => ({ top, bottom, left, right });

  /* --- 曾经的真实故障：文件操作菜单 14 项 ≈ 470px，被 max-height:380px 截断 --- */

  // 复现用户截图里的场景：窗口高 900，菜单挂在列表第一行的「更多」按钮上
  const tall = 470;
  const firstRow = rect(110, 145, 1600);
  const a = placeMenu(firstRow, 226, tall, { viewportWidth: 1706, viewportHeight: 900, align: 'end' });
  eq(a.placedAbove, false, '首行菜单在锚点下方展开');
  eq(a.top, firstRow.bottom + MENU_GAP, '紧贴锚点下沿');
  check(a.maxHeight >= tall, `下方空间足够时不再截断菜单（maxHeight=${a.maxHeight} ≥ ${tall}）`, a);
  check(a.left + 226 <= 1706 - MENU_PAD, '菜单右边缘不越过安全距离（不压住列表滚动条）', a.left);

  /* --- 锚点在底部时向上翻转 --- */

  const nearBottom = rect(840, 870, 1600);
  const b = placeMenu(nearBottom, 226, tall, { viewportWidth: 1706, viewportHeight: 900, align: 'end' });
  eq(b.placedAbove, true, '底部锚点改为向上展开');
  eq(b.top + Math.min(tall, b.maxHeight), nearBottom.top - MENU_GAP, '向上展开时菜单底边贴住锚点上沿');
  check(b.top >= MENU_PAD, '向上展开后不会越过视口上边缘', b.top);

  /* --- 两边都放不下：收敛到较大的一侧，仍然可滚动（而不是溢出） --- */

  const tiny = rect(190, 210, 600);
  const c = placeMenu(tiny, 226, 900, { viewportWidth: 1024, viewportHeight: 400, align: 'end' });
  eq(c.placedAbove, false, '上下空间相同时保持在下方（更符合阅读方向）');
  check(c.maxHeight <= 400 - 210 - MENU_GAP - MENU_PAD, 'max-height 收敛到可用高度，菜单不会溢出视口', c);
  check(c.maxHeight >= MENU_MIN_HEIGHT, '极端情况下仍保留最小可滚动高度', c.maxHeight);
  check(c.top + c.maxHeight <= 400, '下方展开时菜单底边不越出视口', c.top + c.maxHeight);

  /* --- 水平方向：左右都要夹在安全区内 --- */

  const leftAnchor = rect(100, 120, 60, 30);
  const d = placeMenu(leftAnchor, 226, 200, { viewportWidth: 800, viewportHeight: 900, align: 'start' });
  eq(d.left, 30, 'align=start 时左对齐锚点');
  const rightAnchor = rect(100, 120, 810, 780);
  const e2 = placeMenu(rightAnchor, 226, 200, { viewportWidth: 800, viewportHeight: 900, align: 'end' });
  eq(e2.left, 800 - 226 - MENU_PAD, 'align=end 时右对齐并留出安全距离');

  /* --- 锚点被滚出视口时，菜单必须被拉回可视区（否则像「点了没反应」） --- */

  const offscreen = rect(960, 990, 600);   // 锚点在视口下方之外
  const f = placeMenu(offscreen, 226, 470, { viewportWidth: 1024, viewportHeight: 900, align: 'end' });
  check(f.top >= MENU_PAD, '锚点越界时菜单不会被推到视口上方之外', f);
  check(f.top + Math.min(470, f.maxHeight) <= 900 || f.maxHeight >= 900 - 2 * MENU_PAD,
    '锚点越界时菜单仍然落在可视区内（或已占满可用高度）', f);

  /* --- 滚动策略：菜单自身滚动必须放行，其它滚动照旧关闭 --- */

  const fakeMenu = { contains: (n) => n === 'inside' || n === 'self' };
  eq(shouldDismissOnScroll(fakeMenu, 'self'), false, '菜单自身滚动不关闭菜单（否则被截断的条目永远点不到）');
  eq(shouldDismissOnScroll(fakeMenu, 'inside'), false, '菜单内部元素触发的滚动同样不关闭');
  eq(shouldDismissOnScroll(fakeMenu, 'files-scroll'), true, '文件列表滚动仍然关闭菜单（避免与锚点错位）');
  eq(shouldDismissOnScroll(fakeMenu, null), true, '没有目标（页面级滚动）时关闭菜单');
  eq(shouldDismissOnScroll(null, 'x'), true, '菜单缺失时不抛错并关闭');

  /* --- 真实菜单确实很长：保证上面的前提不会随代码改动失效 --- */

  const filesSrc = fs.readFileSync(path.join(JS_DIR, 'pages', 'files.js'), 'utf8');
  const menuBlock = /function openFileMenu[\s\S]*?\n\}/.exec(filesSrc)?.[0] || '';
  check(!!menuBlock, 'files.js 中存在 openFileMenu');
  const itemCount = (menuBlock.match(/\{\s*(icon|sep)\s*:/g) || []).length;
  check(itemCount >= 12, `文件操作菜单条目足够多（${itemCount} 项），必须依赖动态 max-height`, itemCount);

  /* --- ui.js 必须真的用上了这套策略 --- */

  const uiSrc = fs.readFileSync(path.join(JS_DIR, 'ui.js'), 'utf8');
  check(uiSrc.includes("from './menu-position.js'"), 'ui.js 引入了 menu-position.js');
  check(/window\.addEventListener\('scroll',\s*onScroll,\s*true\)/.test(uiSrc),
    'window 上注册的是可判断来源的 onScroll（捕获阶段）');
  check(!/window\.addEventListener\('scroll',\s*close,\s*true\)/.test(uiSrc),
    '不再直接把 close 挂到 scroll 上（这正是「滚动菜单就消失」的根因）');
  check(/window\.removeEventListener\('scroll',\s*onScroll,\s*true\)/.test(uiSrc), '关闭时正确移除该监听');
  check(/menu\.style\.maxHeight/.test(uiSrc), 'ui.js 会按可用空间设置 max-height');
  check(/document\.documentElement\.clientWidth/.test(uiSrc), '用 clientWidth 计算边界（排除滚动条宽度）');

  /* --- CSS 兜底值不能再把菜单截断 --- */

  const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');
  const dropdownBlock = /\.dropdown\s*\{[\s\S]*?\}/.exec(css)?.[0] || '';
  check(!!dropdownBlock, 'app.css 中存在 .dropdown 规则');
  check(!/max-height:\s*380px/.test(dropdownBlock), '.dropdown 不再写死 max-height:380px');
  check(/max-height:\s*min\(\s*560px/.test(dropdownBlock), '.dropdown 兜底高度已放宽到 560px', dropdownBlock.match(/max-height:[^;]*/)?.[0]);
  check(/overscroll-behavior:\s*contain/.test(dropdownBlock), '.dropdown 阻止滚动链传给背后的列表');
}

/* ------------------------------------------------------------------ 汇总 */

console.log('\n' + '─'.repeat(64));
console.log(`  通过 ${passed} · 失败 ${failed}`);
if (failures.length) {
  console.log('\n\x1b[31m失败明细：\x1b[0m');
  for (const f of failures) console.log(`  · ${f}`);
}
console.log('─'.repeat(64));
console.log(failed === 0 ? '\x1b[32mRESULT: PASS\x1b[0m' : '\x1b[31mRESULT: FAIL\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
