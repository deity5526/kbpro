/**
 * KBPRO — 轻量 Markdown → HTML 渲染器（零依赖）
 * 支持：标题、粗体、斜体、删除线、行内代码、围栏代码块、有序/无序列表、
 *       引用、分割线、链接、图片、表格、任务列表、自动换行。
 */
import { escapeHtml } from './text.js';

export function markdownToHtml(md) {
  const src = String(md ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const inline = (s) => renderInline(s);

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre class="md-code" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 标题
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let html = '<table class="md-table"><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>' + header.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push(m[2]);
        } else if (items.length) {
          items[items.length - 1] += '\n' + lines[i].trim();
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      const html = items.map((it) => {
        const task = /^\[([ xX])\]\s*(.*)$/.exec(it);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          return `<li class="md-task"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${inline(task[2])}</li>`;
        }
        return `<li>${inline(it)}</li>`;
      }).join('');
      out.push(`<${tag}>${html}</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|([-*+]|\d+[.)])\s|```|~~~)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join('\n').replace(/\n/g, '<br>'))}</p>`);
  }

  return out.join('\n');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderInline(text) {
  let s = escapeHtml(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src, title) =>
    `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''}>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, txt, href, title) => {
    const safe = /^(https?:|mailto:|tel:|#|\/|\.\/)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${txt}</a>`;
  });
  s = s.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>');
  s = s.replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => `<code>${codes[Number(idx)]}</code>`);
  return s;
}

/** 提取 Markdown 的纯文本（用于检索索引） */
export function markdownToText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
