/**
 * KBPRO — UI 组件库
 * 纯 DOM 操作，无框架依赖。所有组件返回 DOM 节点或 HTML 字符串。
 */
import { icon, hasIcon } from './icons.js';
import { escapeHtml, fileKind, fileKindLabel, extBadge, initials, colorFor } from './format.js';

export const esc = escapeHtml;

/* ------------------------------------------------------------------ DOM */

/** 从 HTML 字符串创建元素（返回第一个元素） */
export function el(htmlStr) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(htmlStr).trim();
  return tpl.content.firstElementChild;
}

/** 从 HTML 字符串创建 DocumentFragment */
export function frag(htmlStr) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(htmlStr).trim();
  return tpl.content;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

/** 事件委托 */
export function on(root, type, selector, handler, opts) {
  const listener = (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(type, listener, opts);
  return () => root.removeEventListener(type, listener, opts);
}

/** 填充 [data-icon] 占位 */
export function applyIcons(root = document) {
  qsa('[data-icon]', root).forEach((node) => {
    const name = node.getAttribute('data-icon');
    if (!name) return;
    if (hasIcon(name)) node.innerHTML = icon(name);
    node.removeAttribute('data-icon');
  });
}

export function setIcon(node, name) {
  if (node && hasIcon(name)) node.innerHTML = icon(name);
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/* ------------------------------------------------------------------ 图标 / 头像 */

export function fileIconHtml(ext, { large = false } = {}) {
  const kind = fileKind(ext);
  const label = fileKindLabel(ext);
  return `<span class="file-ico f-${kind}${large ? ' lg' : ''}" title="${esc(ext || '')}">${esc(label)}</span>`;
}

export function avatarHtml(user, size = '') {
  const name = typeof user === 'string' ? user : (user?.name || user?.email || '?');
  const avatar = typeof user === 'object' ? user?.avatar : '';
  const cls = `avatar ${size}`.trim();
  if (avatar && /^(https?:|data:image\/)/i.test(avatar)) {
    return `<span class="${cls}"><img src="${esc(avatar)}" alt="${esc(name)}" loading="lazy"></span>`;
  }
  return `<span class="${cls}" style="background:${colorFor(name)}">${esc(initials(name))}</span>`;
}

/* ------------------------------------------------------------------ 状态片段 */

export function emptyState({ iconName = 'inbox', title = '暂无内容', desc = '', actions = '' } = {}) {
  return `<div class="empty">
    <div class="empty-ico">${icon(iconName)}</div>
    <div class="empty-title">${esc(title)}</div>
    ${desc ? `<div class="empty-desc">${desc}</div>` : ''}
    ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
  </div>`;
}

export function spinner(size = 16) {
  return `<span class="spin" style="display:inline-flex;width:${size}px;height:${size}px;color:var(--c-ink-400)">${icon('loader', size)}</span>`;
}

export function skeleton(rows = 4) {
  return `<div class="flex-col gap-3" style="padding:8px 0">${
    Array.from({ length: rows }, (_, i) => `<div class="skel skel-line" style="width:${92 - i * 9}%;height:${i === 0 ? 18 : 12}px"></div>`).join('')
  }</div>`;
}

export function badge(text, kind = '') {
  return `<span class="badge${kind ? ` badge-${kind}` : ''}">${esc(text)}</span>`;
}

export function tagHtml(name, { active = false, removable = false, color = '' } = {}) {
  const style = color ? ` style="background:${color}1a;color:${color}"` : '';
  return `<span class="tag${active ? ' is-active' : ''}" data-tag="${esc(name)}"${style}>${esc(name)}${removable ? '<span class="tag-close" data-remove-tag="1">×</span>' : ''}</span>`;
}

export function progressHtml(percent, { status = '' } = {}) {
  return `<div class="progress${status ? ` is-${status}` : ''}"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>`;
}

/* ------------------------------------------------------------------ Toast */

export function toast(message, { type = 'info', duration = 2600, action = null, onAction = null } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return () => {};
  const iconName = { success: 'success', error: 'error', warn: 'alert', info: 'info' }[type] || 'info';
  const node = el(`<div class="toast toast-${type}">
    <span class="toast-ico">${icon(iconName)}</span>
    <span class="toast-msg">${esc(message)}</span>
    ${action ? `<span class="toast-action">${esc(action)}</span>` : ''}
  </div>`);
  root.appendChild(node);

  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 220);
  };
  if (action && onAction) {
    qs('.toast-action', node).addEventListener('click', () => { onAction(); remove(); });
  }
  if (duration > 0) timer = setTimeout(remove, duration);
  return remove;
}

export const notify = {
  success: (m, o) => toast(m, { type: 'success', ...o }),
  error: (m, o) => toast(m, { type: 'error', duration: 4200, ...o }),
  warn: (m, o) => toast(m, { type: 'warn', ...o }),
  info: (m, o) => toast(m, { type: 'info', ...o })
};

/* ------------------------------------------------------------------ 模态框 */

let modalSeq = 0;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.sub]
 * @param {string|Node} opts.body
 * @param {Array<{label:string, kind?:string, value?:any, primary?:boolean, onClick?:Function, close?:boolean}>} [opts.actions]
 * @param {'sm'|'md'|'lg'|'xl'} [opts.size]
 * @param {boolean} [opts.dismissible]
 */
export function modal(opts = {}) {
  const id = `modal-${++modalSeq}`;
  const sizeCls = { lg: ' modal-lg', xl: ' modal-xl' }[opts.size] || '';
  const overlay = el(`<div class="overlay" id="${id}" role="dialog" aria-modal="true">
    <div class="modal${sizeCls}">
      <div class="modal-head">
        <div>
          <div class="modal-title">${esc(opts.title || '')}</div>
          ${opts.sub ? `<div class="modal-sub">${esc(opts.sub)}</div>` : ''}
        </div>
        <button class="icon-btn sm" data-close aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot" ${opts.actions?.length ? '' : 'hidden'}></div>
    </div>
  </div>`);

  const bodyHost = qs('.modal-body', overlay);
  const footHost = qs('.modal-foot', overlay);

  if (typeof opts.body === 'string') bodyHost.innerHTML = opts.body;
  else if (opts.body instanceof Node) bodyHost.appendChild(opts.body);

  const dismissible = opts.dismissible !== false;
  const close = (value) => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.(value);
  };

  for (const action of opts.actions || []) {
    const btn = el(`<button class="btn ${action.primary ? 'btn-primary' : action.kind === 'danger' ? 'btn-danger' : 'btn-default'}">${esc(action.label)}</button>`);
    btn.addEventListener('click', async () => {
      if (action.keepOpen) { action.onClick?.(close, btn); return; }
      const keep = await action.onClick?.(close, btn);
      if (keep === false) return;
      if (action.close !== false) close(action.value);
    });
    footHost.appendChild(btn);
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(null); }
  };
  document.addEventListener('keydown', onKey);

  if (dismissible) {
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    qs('[data-close]', overlay).addEventListener('click', () => close(null));
  } else {
    qs('[data-close]', overlay).hidden = true;
  }

  document.getElementById('modal-root').appendChild(overlay);
  applyIcons(overlay);
  setTimeout(() => {
    const focusTarget = qs('input:not([type=hidden]), textarea, select, button.btn-primary', bodyHost) || qs('button', footHost);
    focusTarget?.focus();
  }, 30);

  return { el: overlay, body: bodyHost, foot: footHost, close };
}

export function confirmDialog({ title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const m = modal({
      title,
      body: `<p class="text-2" style="line-height:1.75">${message}</p>`,
      size: 'sm',
      actions: [
        { label: cancelText, onClick: () => { settled = true; resolve(false); } },
        { label: confirmText, primary: !danger, kind: danger ? 'danger' : '', onClick: () => { settled = true; resolve(true); } }
      ],
      onClose: () => { if (!settled) resolve(false); }
    });
    const buttons = qsa('.modal-foot .btn', m.el);
    if (danger && buttons[1]) buttons[1].classList.add('btn-danger-solid');
  });
}

export function promptDialog({ title = '输入', label = '', value = '', placeholder = '', confirmText = '确定', multiline = false, hint = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const inputHtml = multiline
      ? `<textarea class="textarea" data-input placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" data-input value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const m = modal({
      title,
      size: 'sm',
      body: `<div class="field" style="margin-bottom:0">
        ${label ? `<label>${esc(label)}</label>` : ''}
        ${inputHtml}
        ${hint ? `<div class="field-hint">${esc(hint)}</div>` : ''}
      </div>`,
      actions: [
        { label: '取消', onClick: () => { settled = true; resolve(null); } },
        {
          label: confirmText,
          primary: true,
          onClick: () => {
            settled = true;
            resolve(qs('[data-input]', m.body).value.trim());
          }
        }
      ],
      onClose: () => { if (!settled) resolve(null); }
    });
    const input = qs('[data-input]', m.body);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        settled = true;
        resolve(input.value.trim());
        m.close();
      }
    });
    setTimeout(() => { input.focus(); input.select?.(); }, 40);
  });
}

/* ------------------------------------------------------------------ 抽屉 */

export function drawer({ title = '', sub = '', body = '', footer = '', wide = false, onClose = null } = {}) {
  const overlay = el(`<div class="drawer-overlay"></div>`);
  const panel = el(`<aside class="drawer${wide ? ' drawer-wide' : ''}" role="dialog" aria-modal="true">
    <div class="drawer-head">
      <div class="flex-1" style="min-width:0">${title}</div>
      <button class="icon-btn sm" data-close aria-label="关闭">${icon('close')}</button>
    </div>
    <div class="drawer-body"></div>
    ${footer ? '<div class="drawer-foot"></div>' : ''}
  </aside>`);

  const bodyHost = qs('.drawer-body', panel);
  if (typeof body === 'string') bodyHost.innerHTML = body;
  else if (body instanceof Node) bodyHost.appendChild(body);
  if (footer) qs('.drawer-foot', panel).innerHTML = footer;

  const close = () => {
    panel.style.animation = 'none';
    overlay.style.animation = 'none';
    panel.remove();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', close);
  qs('[data-close]', panel).addEventListener('click', close);

  document.body.appendChild(overlay);
  document.body.appendChild(panel);
  applyIcons(panel);
  return { el: panel, body: bodyHost, foot: footer ? qs('.drawer-foot', panel) : null, close };
}

/* ------------------------------------------------------------------ 菜单 */

/**
 * 在锚点旁弹出菜单。
 * @param {HTMLElement} anchor
 * @param {{label?:string, sep?:boolean, icon?:string, danger?:boolean, hint?:string, active?:boolean, onClick?:Function, disabled?:boolean}[]} items
 */
export function dropdown(anchor, items, { align = 'end', width = null } = {}) {
  closeAllDropdowns();
  const menu = el(`<div class="dropdown" role="menu"></div>`);
  if (width) menu.style.minWidth = `${width}px`;

  for (const item of items) {
    if (item.sep) { menu.appendChild(el('<div class="menu-sep"></div>')); continue; }
    if (item.label && item.header) { menu.appendChild(el(`<div class="menu-label">${esc(item.label)}</div>`)); continue; }
    const btn = el(`<button class="menu-item${item.danger ? ' is-danger' : ''}${item.active ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}" role="menuitem" ${item.disabled ? 'disabled' : ''}>
      ${item.icon ? icon(item.icon) : ''}
      <span class="mi-label">${esc(item.label)}</span>
      ${item.hint ? `<span class="mi-hint">${esc(item.hint)}</span>` : ''}
    </button>`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      close();
      item.onClick?.(e);
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'end' ? rect.right - mw : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) {
    top = Math.max(8, rect.top - mh - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    activeDropdown = null;
  };
  const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  }, 0);

  activeDropdown = close;
  applyIcons(menu);
  return close;
}

let activeDropdown = null;
export function closeAllDropdowns() {
  if (activeDropdown) { activeDropdown(); activeDropdown = null; }
}

export function contextMenu(event, items) {
  event.preventDefault();
  const anchor = document.createElement('div');
  anchor.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;width:1px;height:1px;pointer-events:none`;
  document.body.appendChild(anchor);
  const close = dropdown(anchor, items, { align: 'start' });
  anchor.remove();
  return close;
}

/* ------------------------------------------------------------------ 交互辅助 */

export async function copyText(text, successMessage = '已复制') {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
    } else {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    notify.success(successMessage);
    return true;
  } catch {
    notify.error('复制失败，请手动选择文本');
    return false;
  }
}

/** 触发文件选择 */
export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.getElementById('hidden-file-input') || document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.value = '';
    input.onchange = () => resolve([...(input.files || [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** 触发下载 */
export function downloadUrl(url, filename = '') {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 100);
}

/** 表单序列化 */
export function formValues(root) {
  const out = {};
  qsa('[data-field]', root).forEach((node) => {
    const key = node.getAttribute('data-field');
    if (node.type === 'checkbox') out[key] = node.checked;
    else if (node.type === 'number') out[key] = node.value === '' ? null : Number(node.value);
    else out[key] = node.value;
  });
  return out;
}

/** 按钮加载态 */
export function withLoading(button, fn) {
  return async (...args) => {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `${spinner(13)}<span>处理中…</span>`;
    try {
      return await fn(...args);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
      applyIcons(button);
    }
  };
}

/** 高亮匹配文本（纯文本输入） */
export function highlightText(text, terms) {
  const s = String(text ?? '');
  if (!s) return '';
  const list = (terms || []).filter(Boolean).map(String).filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
  if (!list.length) return esc(s);
  const pattern = list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  try {
    return esc(s).replace(new RegExp(escRegExpInEscaped(pattern), 'gi'), (m) => `<mark>${m}</mark>`);
  } catch {
    // 回退：在原文上做替换再转义
    try {
      return s.replace(new RegExp(pattern, 'gi'), (m) => `\u0000${m}\u0001`)
        .split('\u0000').map((chunk, i) => (i === 0 ? esc(chunk) : (() => {
          const end = chunk.indexOf('\u0001');
          return `<mark>${esc(chunk.slice(0, end))}</mark>${esc(chunk.slice(end + 1))}`;
        })())).join('');
    } catch {
      return esc(s);
    }
  }
}

function escRegExpInEscaped(p) { return p; }

/** 简易标签输入（返回元素 + getValue） */
export function tagInput({ value = [], placeholder = '输入标签后回车', workspaceId = null, suggestions = [] } = {}) {
  const wrap = el(`<div class="tag-input-wrap" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:34px;padding:5px 8px;border:1px solid var(--c-border-2);border-radius:var(--r-md);background:var(--c-surface)">
    <input class="tag-input-field" style="border:0;outline:none;flex:1;min-width:110px;font-size:var(--fs-base);background:transparent" placeholder="${esc(placeholder)}">
  </div>`);
  const input = qs('.tag-input-field', wrap);
  let tags = [...value];

  const render = () => {
    qsa('.tag', wrap).forEach((n) => n.remove());
    for (const t of tags) {
      const chip = el(`<span class="tag">${esc(t)}<span class="tag-close">×</span></span>`);
      qs('.tag-close', chip).addEventListener('click', () => {
        tags = tags.filter((x) => x !== t);
        render();
      });
      wrap.insertBefore(chip, input);
    }
  };

  const add = (raw) => {
    for (const part of String(raw).split(/[,，\s]+/)) {
      const t = part.replace(/^#+/, '').trim().slice(0, 32);
      if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase()) && tags.length < 20) tags.push(t);
    }
    render();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      if (input.value.trim()) { add(input.value); input.value = ''; }
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      render();
    }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });

  if (suggestions.length) {
    const d = el(`<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">${
      suggestions.slice(0, 12).map((s) => `<span class="chip chip-btn" data-sug="${esc(s.name || s)}">${esc(s.name || s)}</span>`).join('')
    }</div>`);
    on(d, 'click', '[data-sug]', (e, target) => {
      add(target.getAttribute('data-sug'));
      target.remove();
    });
    wrap.after(d);
    wrap._suggestHost = d;
  }

  render();
  return {
    el: wrap,
    get value() { return [...tags]; },
    set value(v) { tags = [...(v || [])]; render(); },
    focus: () => input.focus()
  };
}

/* ------------------------------------------------------------------ 其他 */

export function relTimeNode(iso) {
  const span = el(`<span title="${esc(iso || '')}"></span>`);
  return span;
}

export function scrollIntoViewIfNeeded(node, container) {
  if (!node || !container) return;
  const nb = node.getBoundingClientRect();
  const cb = container.getBoundingClientRect();
  if (nb.top < cb.top || nb.bottom > cb.bottom) {
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

export function focusFirst(root) {
  const target = qs('input:not([type=hidden]), textarea, select, button', root);
  target?.focus();
}

export function trapTab(root) {
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusables = qsa('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', root)
      .filter((n) => n.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener('keydown', handler);
  return () => root.removeEventListener('keydown', handler);
}

export { icon, hasIcon };
export * from './format.js';
