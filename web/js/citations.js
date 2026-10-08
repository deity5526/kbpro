/**
 * KBPRO — 参考来源（引用）渲染
 *
 * 单独成模块的原因：这两个函数是**纯字符串构建**，不碰 DOM，
 * 因此可以在 Node 里直接单元测试（见 tests/test-frontend.mjs 的引用折叠断言），
 * 而不必依赖浏览器。聊天页只管把它们塞进消息里。
 */
import { icon, esc } from './ui.js';

/**
 * 参考来源区块，默认折叠。
 *
 * 为什么折叠：一次问答通常带回 8 条来源，全部展开会把回答挤下去，
 * 长会话滚动时噪声很大。收起态只占一行（图标 + 条数 + 箭头），点一下展开。
 * 展开状态记在消息对象上（m.citesOpen），重新渲染不会丢。
 */
export function citationsHtml(m) {
  const list = Array.isArray(m?.citations) ? m.citations.filter(Boolean) : [];
  if (!list.length) return '';
  const open = m.citesOpen === true;
  return `<div class="citations${open ? ' is-open' : ''}">
    <button type="button" class="citations-head" data-cites-toggle="1" aria-expanded="${open}">
      <span class="citations-head-ico">${icon('book')}</span>
      <span class="citations-head-text">参考来源</span>
      <span class="citations-count">${list.length}</span>
      <span class="citations-caret">${icon('chevronDown')}</span>
    </button>
    <div class="citations-list"${open ? '' : ' hidden'}>
      ${list.map(citeCardHtml).join('')}
    </div>
  </div>`;
}

export function citeCardHtml(c, i) {
  const num = Number(c.index) || i + 1;
  const fileId = c.fileId || c.file_id || '';
  const score = Number(c.score);
  const meta = [c.page ? `第 ${c.page} 页` : '', c.heading || ''].filter(Boolean).join(' · ');
  return `<div class="cite-card" data-cite-card="${num}" data-cite-file="${esc(fileId)}" title="点击打开原文">
    <span class="cite-num">${num}</span>
    <div class="cite-main">
      <div class="cite-title">${esc(c.title || '未命名文档')}${meta ? ` · ${esc(meta)}` : ''}</div>
      <div class="cite-snippet">${esc(c.snippet || '')}</div>
    </div>
    ${Number.isFinite(score) && score > 0 ? `<span class="cite-score">${score.toFixed(3)}</span>` : ''}
  </div>`;
}

export default { citationsHtml, citeCardHtml };
