#!/usr/bin/env node
/**
 * 生成「图标尺寸修复」的视觉对照页（不依赖浏览器测试框架，也不需要服务在跑）。
 *
 * 用途：本地无头浏览器跑不了 HTTP 时，仍可以把 pages 里的真实 markup + 真实 app.css
 * 渲染成一张静态页，用于肉眼确认排版（例如 SVG 是否被撑成 300×150）。
 *
 * 用法：
 *   node tests/preview-icon-fix.mjs [输出路径]
 *   # 然后用 Chrome 截图：
 *   chrome --headless=new --no-sandbox --window-size=920,900 \
 *          --screenshot=preview.png "file:///<输出路径>"
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { icon } from '../web/js/icons.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const out = process.argv[2] || path.join(ROOT, 'demo-docs', 'icon-preview.html');

const css = fs.readFileSync(path.join(ROOT, 'web/css/app.css'), 'utf8');

/** 修复前的写法：不带尺寸的 svg（会按 300×150 渲染） */
const legacyIcon = (name, paths) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ALERT_PATHS = '<path d="M7.1 2.6 2 12.2a1 1 0 0 0 .9 1.5h10.2a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0z"/><path d="M8 6.3v3.1M8 11.6h.01"/>';

const notice = (iconHtml) => `<div class="general-notice">
  <span class="general-notice-ico">${iconHtml}</span>
  <div class="general-notice-body">
    <div class="general-notice-title">以下为通用回答 · 未引用你的知识库</div>
    <div class="general-notice-desc">知识库中没有检索到相关依据，该内容来自大模型的通用知识，请自行核实。</div>
  </div>
</div>`;

/** 用户截图里的那版原始 markup：没有专门的图标容器，也没有对应的 CSS 规则 */
const legacyNotice = (iconHtml) => `<div class="card" style="margin-bottom:10px;padding:9px 12px;border-color:var(--c-warn);background:var(--c-warn-bg)">
  <div class="text-xs" style="color:var(--c-warn);font-weight:600;display:flex;align-items:center;gap:6px">
    ${iconHtml} 以下为通用回答 · 未引用你的知识库
  </div>
  <div class="text-xs mt-1" style="color:var(--c-text-2);line-height:1.65">
    知识库中没有检索到相关依据，该内容来自大模型的通用知识，请自行核实。
  </div>
</div>`;

/** 其它受同一问题影响的位置：旧写法（未带尺寸） */
const legacyAffected = `
    <div class="flex items-center gap-4 mb-4">
      <div class="msg-avatar">${legacyIcon('sparkle', '<path d="M8 1.8 9.6 6 13.8 7.6 9.6 9.2 8 13.4 6.4 9.2 2.2 7.6 6.4 6z"/>')}</div>
      <div class="section-title">${legacyIcon('chart', '<path d="M2.4 13.6h11.2"/>')} 近 14 天沉淀趋势</div>
      <span class="badge">${legacyIcon('lock', '<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.4"/>')} 已加密</span>
    </div>
    <div class="search-box"><span class="sb-ico">${legacyIcon('search', '<circle cx="7.1" cy="7.1" r="4.6"/>')}</span><input class="input" placeholder="搜索文档、笔记、标签…"></div>`;

/** 其它受影响位置：修复后 */
const fixedAffected = `
    <div class="flex items-center gap-4 mb-4">
      <div class="msg-avatar">${icon('sparkle')}</div>
      <div class="section-title">${icon('chart')} 近 14 天沉淀趋势</div>
      <span class="badge">${icon('lock')} 已加密</span>
    </div>
    <div class="search-box"><span class="sb-ico">${icon('search')}</span><input class="input" placeholder="搜索文档、笔记、标签…"></div>
    <div class="flex items-center gap-3 mt-4">
      <span class="pin-ico">${icon('pinFill')}</span>
      <span class="star-ico">${icon('starFill')}</span>
      <div class="segmented"><button class="is-active">${icon('list')}</button><button>${icon('grid')}</button></div>
      <button class="btn btn-sm btn-default">${icon('sort')}<span>最近更新</span></button>
    </div>
    <div class="empty" style="padding:18px">
      <div class="empty-ico">${icon('file')}</div>
      <div class="empty-title">空状态图标（本就由 CSS 控制，仍正常）</div>
    </div>`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>图标尺寸修复对照</title>
<style>${css}
body { padding: 24px; background: var(--c-bg); }
.case { margin-bottom: 22px; }
.case-label { font: 600 12px/1.6 var(--font-sans); color: var(--c-text-3); margin-bottom: 8px; letter-spacing: .02em; }
.case-box { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px; max-width: 660px; }
</style></head><body>

<div class="case">
  <div class="case-label">① 修复前（你截图里的样子）· 原始 markup，icon('alert') 未带尺寸，且没有 svg 尺寸规则 → SVG 按 300×150 渲染</div>
  <div class="case-box">${legacyNotice(legacyIcon('alert', ALERT_PATHS))}</div>
</div>

<div class="case">
  <div class="case-label">② 只做根因修复 · 同样的原始 markup，但 icon() 现在总是带默认尺寸 16</div>
  <div class="case-box">${legacyNotice(icon('alert'))}</div>
</div>

<div class="case">
  <div class="case-label">③ 实际采用 · 新的 .general-notice 结构 + icon('alert', 14)</div>
  <div class="case-box">${notice(icon('alert', 14))}</div>
</div>

<div class="case">
  <div class="case-label">④ 同一问题影响过的其它位置 · 修复前（未带尺寸）</div>
  <div class="case-box">${legacyAffected}</div>
</div>

<div class="case">
  <div class="case-label">⑤ 同一问题影响过的其它位置 · 修复后</div>
  <div class="case-box">${fixedAffected}
  </div>
</div>

<div class="case">
  <div class="case-label">参考来源折叠（默认收起 / 展开）</div>
  <div class="case-box">
    ${notice(icon('alert', 14))}
    <div class="citations">
      <button type="button" class="citations-head" data-cites-toggle="1" aria-expanded="false">
        <span class="citations-head-ico">${icon('book')}</span>
        <span class="citations-head-text">参考来源</span>
        <span class="citations-count">2</span>
        <span class="citations-caret">${icon('chevronDown')}</span>
      </button>
      <div class="citations-list" hidden></div>
    </div>
    <div class="citations is-open" style="margin-top:14px">
      <button type="button" class="citations-head" aria-expanded="true">
        <span class="citations-head-ico">${icon('book')}</span>
        <span class="citations-head-text">参考来源</span>
        <span class="citations-count">1</span>
        <span class="citations-caret">${icon('chevronDown')}</span>
      </button>
      <div class="citations-list">
        <div class="cite-card"><span class="cite-num">1</span>
          <div class="cite-main">
            <div class="cite-title">季度经营复盘会议纪要.docx · 第 2 页 · 经营数据</div>
            <div class="cite-snippet">营业收入 3,280 万元，客户留存率 94.7%。</div>
          </div><span class="cite-score">3.739</span>
        </div>
      </div>
    </div>
  </div>
</div>

</body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(out);
