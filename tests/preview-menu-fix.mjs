#!/usr/bin/env node
/**
 * 生成「浮层菜单滚动修复」的交互验证页（不依赖服务，也不需要测试框架）。
 *
 * 用途：沙箱里跑不了 HTTP 时，仍然可以用无头 Chrome 打开 file:// 页面，
 * 用**真实的** menu-position.js / icons.js / ui.js 里的 dropdown() 跑一遍：
 *   · 条目多的菜单是否还被截断
 *   · 在菜单内部滚动，菜单会不会把自己关掉（用户遇到的 bug）
 *   · 文件列表滚动时菜单是否照旧关闭
 *   · 对照：把 close 直接挂到 window 滚动监听上，能否复现旧 bug
 *
 * 用法：
 *   node tests/preview-menu-fix.mjs [输出路径]
 *   chrome --headless=new --no-sandbox --virtual-time-budget=9000 \
 *          --dump-dom "file:///<输出路径>?case=inside"
 *   case = layout | inside | list | legacy
 *
 * 注意（实测踩过的坑）：无头 Chrome 在 --virtual-time-budget 下，
 * **异步任务里**给 scrollTop 赋值不会再触发 scroll 事件（渲染机会不再产生），
 * 只有解析期间**同步**赋值才会。所以每个用例的滚动都在解析期同步完成，
 * 断言放到 setTimeout 里。否则会把测试环境限制误判成产品 bug。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { icon } from '../web/js/icons.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const out = process.argv[2] || path.join(ROOT, 'demo-docs', 'menu-preview.html');

const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');

/** 把 ESM 源码降级成普通脚本：去掉 export 关键字即可（这几个模块没有 import） */
const asScript = (file) =>
  fs.readFileSync(path.join(WEB, 'js', file), 'utf8').replace(/^export\s+/gm, '');

const iconsSrc = asScript('icons.js');
const menuPosSrc = asScript('menu-position.js');

const uiSrc = fs.readFileSync(path.join(WEB, 'js', 'ui.js'), 'utf8');
const dropdownSrc = (/export function dropdown\(anchor, items[\s\S]*?\n\}/.exec(uiSrc)?.[0] || '')
  .replace(/^export\s+/, '');
if (!dropdownSrc) throw new Error('未能从 ui.js 中提取 dropdown()');

const STUBS = `
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(htmlStr) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(htmlStr).trim();
  return tpl.content.firstElementChild;
}
function applyIcons() { /* 图标已内联，无需补 */ }
let activeDropdown = null;
function closeAllDropdowns() { if (activeDropdown) { activeDropdown(); activeDropdown = null; } }
`;

/** 与 files.js 的 openFileMenu 同构：17 项，自然高度远超旧的 380px 上限 */
const FILE_MENU_ITEMS = [
  ['eye', '打开预览'], ['download', '下载原文件'], ['sep'],
  ['star', '取消收藏'], ['pin', '置顶'], ['edit', '重命名'], ['move', '移动到…'],
  ['tag', '编辑标签'], ['lock', '设为私密'], ['sep'],
  ['sparkle', 'AI 智能解析'], ['refresh', '重新解析并索引'], ['share', '共享与权限'],
  ['external', '导出为 Markdown'], ['external', '导出为 HTML'], ['sep'], ['trash', '删除']
];

/** 静态对照图用的菜单标记（结构与 dropdown() 生成的完全一致） */
const menuMarkup = FILE_MENU_ITEMS.map((it) => (it[0] === 'sep'
  ? '<div class="menu-sep"></div>'
  : `<button class="menu-item">${icon(it[0])}<span class="mi-label">${it[1]}</span></button>`)).join('');

const rows = Array.from({ length: 14 }, (_, i) => `
  <div class="file-row" data-file="f${i}">
    <span class="file-check"><span class="checkbox"></span></span>
    <div class="file-ico f-doc">DOC</div>
    <div class="file-main">
      <div class="file-name"><span class="truncate">演示文档 ${i + 1} · 需求规格说明书.docx</span>
        <span class="badge badge-success">已索引</span></div>
      <div class="file-meta"><span class="fm-item">${37 + i} KB</span></div>
    </div>
    <div class="file-col col-date">1 小时前</div>
    <div class="file-col num col-size">${37 + i} KB</div>
    <div class="file-col num col-views">${i} 次查看</div>
    <div class="file-actions">
      <button class="icon-btn sm" data-file-act="menu" data-id="f${i}" title="更多操作">${icon('moreV')}</button>
    </div>
  </div>`).join('');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>PENDING</title>
<style>${css}
body { margin: 0; background: var(--c-bg); font-family: var(--font-sans); }
.harness { display: flex; flex-direction: column; height: 100vh; }
.harness-head { padding: 12px 20px; border-bottom: 1px solid var(--c-border); background: var(--c-surface); display: flex; gap: 14px; align-items: baseline; }
.harness-title { font-weight: 620; font-size: 14px; }
.harness-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 460px; }
.harness-body > .files-scroll { min-height: 0; }
#selftest { border-left: 1px solid var(--c-border); padding: 14px 16px; background: var(--c-surface); overflow: auto;
  font: 12px/1.75 var(--font-mono); white-space: pre-wrap; }
#selftest .ok { color: #0E9F6E; } #selftest .bad { color: #D93025; font-weight: 700; }
#selftest .note { color: var(--c-text-3); }
#visual { padding: 26px 30px; }
#visual .cols { display: flex; gap: 34px; align-items: flex-start; }
#visual .case-label { font: 600 12px/1.6 var(--font-sans); color: var(--c-text-3); margin-bottom: 10px; letter-spacing: .02em; }
#visual .case-label b { color: var(--c-text); }
#visual .panel { background: var(--c-bg); border: 1px dashed var(--c-border-2); border-radius: var(--r-lg); padding: 14px; }
#visual .dropdown { position: relative; animation: none; }
#visual .note { margin-top: 14px; font-size: 12px; color: var(--c-text-3); }
</style></head><body>

<div class="harness">
  <div class="harness-head">
    <span class="harness-title">浮层菜单滚动修复 · 交互验证</span>
    <span class="text-xs text-muted">条目数 17 · 与「文件库 → 更多操作」菜单同构</span>
  </div>
  <div class="harness-body">
    <div class="files-scroll" id="files-scroll">
      <div class="file-list">${rows}</div>
    </div>
    <div id="selftest">运行中…</div>
  </div>
</div>

<div id="visual" hidden>
  <div class="cols">
    <div>
      <div class="case-label">修复前 · <b>.dropdown { max-height: 380px }</b> · 只能看到 12 项</div>
      <div class="panel"><div class="dropdown" style="max-height:380px">${menuMarkup}</div></div>
    </div>
    <div>
      <div class="case-label">修复后 · <b>按锚点上下可用空间自适应</b> · 17 项全部可见</div>
      <div class="panel"><div class="dropdown">${menuMarkup}</div></div>
    </div>
  </div>
  <div class="note">修复前「共享与权限 / 导出为 Markdown / 导出为 HTML / 删除」落在可视区之外，
  而在菜单内部滚动会触发 window 的捕获阶段 scroll 监听，菜单立刻把自己关掉 —— 这几项永远点不到。</div>
</div>

<script>${iconsSrc}</script>
<script>${menuPosSrc}</script>
<script>${STUBS}
${dropdownSrc}</script>
<script>
const ITEMS = ${JSON.stringify(FILE_MENU_ITEMS)};

const host = document.getElementById('selftest');
const lines = [];
function log(ok, msg) {
  lines.push({ ok, msg });
  host.innerHTML = lines.map((l) => '<div class="' + (l.ok ? 'ok' : 'bad') + '">' + (l.ok ? '✓ ' : '✗ ') + l.msg + '</div>').join('');
}
const menus = () => [...document.querySelectorAll('.dropdown')];
const lastMenu = () => menus().length ? menus()[menus().length - 1] : null;

let winScrolls = 0;
window.addEventListener('scroll', () => { winScrolls++; }, true);

function buildItems() {
  return ITEMS.map((it) => it[0] === 'sep'
    ? { sep: true }
    : { icon: it[0], label: it[1], onClick: () => {} });
}

const CASE = new URLSearchParams(location.search).get('case') || 'layout';
const buttons = document.querySelectorAll('[data-file-act="menu"]');
const listScroll = document.getElementById('files-scroll');
const openMenu = () => { dropdown(buttons[0], buildItems(), { align: 'end', width: 226 }); return lastMenu(); };

if (CASE === 'visual') {
  // 纯静态对照：不跑交互，只把两版菜单并排画出来（截图用，避免无头环境动画停在 opacity:0）
  document.querySelector('.harness').hidden = true;
  document.getElementById('visual').hidden = false;
  document.title = 'VISUAL';
}

function finish() {
  const ok = lines.every((l) => l.ok);
  host.setAttribute('data-result', ok ? 'PASS' : 'FAIL');
  host.setAttribute('data-case', CASE);
  document.title = 'SELFTEST ' + (ok ? 'PASS' : 'FAIL') + ' [' + CASE + ']';
}

/* 所有滚动都在解析期同步完成（原因见文件头注释），断言放到 setTimeout 里 */
if (CASE === 'layout') {
  const m = openMenu();
  m.style.animation = 'none';   // 截图用
  const box = m.getBoundingClientRect();
  const natural = m.scrollHeight, visible = m.clientHeight;
  log(true, '菜单自然高度 ' + natural + 'px / 可视 ' + visible + 'px（修复前被 CSS 写死在 380px）');
  log(!(natural > visible + 1), natural > visible + 1
    ? '菜单仍被截断，需要内部滚动'
    : '菜单完整展示：' + ITEMS.length + ' 项操作全部可见');
  log(box.top >= 7, '顶边在视口内（top=' + Math.round(box.top) + '）');
  log(box.bottom <= window.innerHeight - 7, '底边在视口内（bottom=' + Math.round(box.bottom) + ' / vh=' + window.innerHeight + '）');
  log(box.right <= document.documentElement.clientWidth - 7, '右边缘不压住列表滚动条（right=' + Math.round(box.right) + ' / clientWidth=' + document.documentElement.clientWidth + '）');
  log(menus().length === 1, '页面上只有一个菜单实例');
  finish();
} else if (CASE === 'before') {
  // 复现修复前的样子：CSS 把菜单高度写死在 380px（当时 JS 不会再收敛 max-height）
  const m = openMenu();
  m.style.animation = 'none';   // 截图用：入场动画在无头虚拟时间下可能停在 opacity:0
  m.style.maxHeight = '380px';
  const natural = m.scrollHeight, visible = m.clientHeight;
  const hidden = [...m.querySelectorAll('.menu-item')].filter((b) => b.getBoundingClientRect().bottom > m.getBoundingClientRect().bottom + 1);
  log(true, '菜单自然高度 ' + natural + 'px，但被限制为 ' + visible + 'px');
  log(natural > visible + 1, '修复前：菜单被截断（与用户截图一致）');
  log(true, '被藏在可视区之外的条目：' + hidden.map((b) => b.textContent.trim()).join(' / '));
  log(hidden.length > 0, '确有 ' + hidden.length + ' 项操作需要滚动才能看到，而滚动又会关闭菜单');
  finish();
} else if (CASE === 'inside') {
  const m = openMenu();
  m.style.maxHeight = '200px';
  const truncated = m.scrollHeight > m.clientHeight + 1;
  m.scrollTop = 70;
  setTimeout(function () {
    log(truncated, '菜单处于截断状态，内部确实可滚动（' + m.scrollHeight + ' > ' + m.clientHeight + '）');
    log(winScrolls > 0, '滚动产生了 scroll 事件并传到 window 捕获阶段（' + winScrolls + ' 次）');
    log(document.contains(m), '【核心】在菜单内部滚动后，菜单仍然存在');
    log(m.scrollTop > 0, '内部滚动真正生效（scrollTop=' + m.scrollTop + '）');
    finish();
  }, 500);
} else if (CASE === 'list') {
  const m = openMenu();
  listScroll.scrollTop = 60;
  setTimeout(function () {
    log(listScroll.scrollTop > 0, '文件列表确实滚动了（scrollTop=' + listScroll.scrollTop + '）');
    log(winScrolls > 0, '滚动产生了 scroll 事件（' + winScrolls + ' 次）');
    log(!document.contains(m), '文件列表滚动后菜单自动关闭（不与锚点错位）');
    finish();
  }, 500);
} else if (CASE === 'legacy') {
  const close = dropdown(buttons[0], buildItems(), { align: 'end', width: 226 });
  const m = lastMenu();
  m.style.maxHeight = '200px';
  // 修复前 ui.js 里就是这一行：直接把 close 挂到 window 的捕获阶段 scroll 上
  window.addEventListener('scroll', close, true);
  m.scrollTop = 70;
  setTimeout(function () {
    log(winScrolls > 0, '滚动产生了 scroll 事件（' + winScrolls + ' 次）');
    log(!document.contains(m), '【对照】旧写法：滚动菜单本身会把菜单关掉（复现用户遇到的 bug）');
    finish();
  }, 500);
} else if (CASE !== 'visual') {
  log(false, '未知用例：' + CASE);
  finish();
}
</script>
</body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(out);
