/**
 * KBPRO — 分享链接访问页（无需登录）
 * 路由：#/share/<token>
 */
import {
  qs, qsa, el, on, applyIcons, icon, notify, esc, emptyState, skeleton, copyText,
  timeAgo, formatBytes, formatDateTime, fileIconHtml, downloadUrl
} from '../ui.js';
import { renderChatMarkdown } from '../md.js';

export const meta = { title: '分享的内容', icon: 'share' };

let cleanup = [];

export async function mount(container, ctx) {
  const token = ctx.params?.[0];
  container.innerHTML = `<div class="page" style="max-width:960px">${skeleton(4)}</div>`;

  if (!token) {
    container.innerHTML = `<div class="page" style="max-width:960px">${emptyState({ iconName: 'link', title: '分享链接无效', desc: '链接地址不完整。' })}</div>`;
    return;
  }

  let data;
  try {
    data = await ctx.api.shareByToken(token);
  } catch (err) {
    container.innerHTML = `<div class="page" style="max-width:960px">${emptyState({
      iconName: err.status === 404 ? 'link' : 'alert',
      title: err.status === 404 ? '链接不存在或已过期' : '无法打开分享内容',
      desc: err.status === 404
        ? '分享链接可能已被移除，或已超过有效期。请联系分享者重新生成。'
        : esc(err.message),
      actions: '<a class="btn btn-default" href="#/dashboard">返回首页</a>'
    })}</div>`;
    return;
  }

  const { resource, resourceType, owner, permission } = data;
  const isFile = resourceType === 'file';

  container.innerHTML = `<div class="page" style="max-width:960px">
    <div class="card card-pad mb-5" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div class="brand-mark">K</div>
      <div style="flex:1;min-width:200px">
        <div class="text-sm text-muted">${esc(owner?.name || '某位用户')} 通过 KBPRO 向你分享了${isFile ? '一份文档' : '一篇笔记'}</div>
        <div class="section-title" style="font-size:var(--fs-lg);margin-top:4px">
          ${isFile ? '' : `${esc(resource.emoji || '')} `}${esc(isFile ? resource.name : resource.title)}
        </div>
        <div class="text-xs text-muted mt-1">
          权限：${esc(permissionLabel(permission))} · 更新于 ${esc(timeAgo(resource.updatedAt))}
        </div>
      </div>
      <div class="flex gap-2">
        ${isFile
          ? `<button class="btn btn-default" data-dl>${icon('download')}下载原文</button>`
          : ''}
        <a class="btn btn-primary" href="#/dashboard">${icon('home')}进入我的知识库</a>
      </div>
    </div>

    <div class="card">
      <div class="card-pad">
        <div id="share-content">${skeleton(4)}</div>
      </div>
    </div>
  </div>`;

  applyIcons(container);
  renderContent(container, ctx, data, token);

  const off = on(container, 'click', '[data-dl]', () => {
    if (isFile) downloadUrl(`/api/files/${resource.id}/content?download=1&token=${encodeURIComponent(token)}`, resource.name);
  });
  cleanup.push(off);
  void copyText;
}

function permissionLabel(p) {
  return { view: '只读', comment: '可评论', edit: '可编辑', manage: '可管理' }[p] || p;
}

async function renderContent(container, ctx, data, token) {
  const host = qs('#share-content', container);
  const { resource, resourceType } = data;
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';

  try {
    if (resourceType === 'note') {
      host.innerHTML = `<div class="preview-doc" style="padding:0;max-width:none">${resource.html || `<pre class="text-view">${esc(resource.text || '')}</pre>`}</div>`;
      return;
    }
    if (resource.previewKind === 'image') {
      host.innerHTML = `<div class="text-center"><img src="/api/files/${esc(resource.id)}/content?inline=1${tokenParam}" alt="" style="max-width:100%;border-radius:var(--r-md)"></div>`;
      return;
    }
    if (resource.previewKind === 'pdf') {
      host.innerHTML = `<iframe src="/api/files/${esc(resource.id)}/content?inline=1${tokenParam}" style="width:100%;height:70vh;border:0;border-radius:var(--r-md);background:var(--c-ink-50)" title="${esc(resource.name)}"></iframe>`;
      return;
    }
    if (resource.text?.status !== 'ok') {
      host.innerHTML = emptyState({
        iconName: 'file',
        title: '该文件暂不支持在线预览',
        desc: esc(resource.text?.warning || '可下载原文后查看，或请分享者确认文件已解析完成。')
      });
      return;
    }
    const pv = await ctx.api.filePreview(resource.id, token);
    host.innerHTML = pv.html
      ? `<div class="preview-doc" style="padding:0;max-width:none">${pv.html}</div>`
      : `<pre class="text-view">${esc((pv.text || '').slice(0, 300000))}</pre>`;
  } catch (err) {
    host.innerHTML = emptyState({ iconName: 'alert', title: '内容加载失败', desc: esc(err.message) });
  }
  void formatBytes;
  void formatDateTime;
  void fileIconHtml;
  void renderChatMarkdown;
  void el;
  void qsa;
  void notify;
}

export function unmount() {
  for (const off of cleanup) { try { typeof off === 'function' && off(); } catch { /* */ } }
  cleanup = [];
}

export default { meta, mount, unmount };
