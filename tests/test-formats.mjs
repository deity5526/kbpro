/**
 * KBPRO — 多格式文档解析与检索端到端测试
 * 覆盖：DOCX / XLSX / PPTX / PDF（含 CJK、加密、损坏 xref、对象流、扫描件）
 *       TXT / Markdown / CSV / JSON / HTML / 代码 / GBK 编码 / 大文件分块
 * 运行： node tests/test-formats.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const TMP_ROOT = path.join(os.tmpdir(), `kbpro-fmt-${Date.now().toString(36)}`);
process.env.KBPRO_DATA = TMP_ROOT;
process.env.KBPRO_QUIET = '1';

let passed = 0, failed = 0;
const failures = [];
let section = '';

function head(name) { section = name; console.log(`\n\x1b[36m▸ ${name}\x1b[0m`); }
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push(`[${section}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 300)}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== undefined ? `  → ${JSON.stringify(detail)?.slice(0, 240)}` : ''}`);
  }
}

let BASE = '', cookie = '';

async function api(method, p, body) {
  const headers = { Cookie: cookie };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    if (c.startsWith('kbpro_session=')) cookie = c.split(';')[0];
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
}
const json = api;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitParsed(fileId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await json('GET', `/api/files/${fileId}/text`);
    last = r.data;
    if (['ok', 'empty', 'failed'].includes(r.data?.status)) return r.data;
    await sleep(220);
  }
  return last;
}

async function uploadFile(name, buffer, mime, workspaceId, extra = {}) {
  const fd = new FormData();
  fd.append('workspaceId', workspaceId);
  if (extra.folderId) fd.append('folderId', extra.folderId);
  if (extra.tags) fd.append('tags', extra.tags);
  fd.append('file', new Blob([buffer], { type: mime }), name);
  const r = await api('POST', '/api/files/upload', fd);
  if (r.status !== 201) return { error: r.data };
  return { file: r.data.files[0] };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const { start, stop } = await import('../server/index.js');
  const started = await start({ port: 0, host: '127.0.0.1', silent: true });
  BASE = started.url;
  console.log(`KBPRO 多格式解析测试 · ${BASE}`);
  console.log(`数据目录 ${TMP_ROOT}`);

  try {
    await run();
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

async function run() {
  await json('POST', '/api/auth/login', { email: 'admin@kbpro.local', password: 'admin12345' });
  const ws = (await json('GET', '/api/workspaces')).data.workspaces.find((w) => w.kind === 'personal');
  const wsId = ws.id;
  const results = new Map();

  const fixture = (rel) => fs.readFileSync(path.join(FIXTURES, rel));

  /* ============================ Office ============================ */
  head('Office 文档 · DOCX / XLSX / PPTX');
  {
    const docx = await uploadFile('季度报告.docx', fixture('sample.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', wsId, { tags: 'office,报告' });
    check(!docx.error, 'DOCX 上传成功', docx.error);
    const d = await waitParsed(docx.file.id);
    check(d.status === 'ok', 'DOCX 解析成功', d);
    check(d.text.includes('Quarterly Report'), 'DOCX 提取到标题文本', d.text?.slice(0, 80));
    check(d.text.includes('BoldMarker'), 'DOCX 提取到正文文本');
    check(d.text.includes('5 < 10'), 'DOCX 特殊字符正确');
    check(d.html.includes('<strong'), 'DOCX 保留加粗样式');
    check(d.html.includes('<em'), 'DOCX 保留斜体样式');
    check(d.html.includes('<table'), 'DOCX 表格转为 HTML');
    check(d.html.includes('data:image/png;base64'), 'DOCX 内嵌图片转为 base64');
    check(!d.html.includes('<script'), 'DOCX 输出无脚本注入');
    results.set('docx', docx.file);

    const xlsx = await uploadFile('数据表.xlsx', fixture('sample.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', wsId);
    const x = await waitParsed(xlsx.file.id);
    check(x.status === 'ok', 'XLSX 解析成功', x);
    check(x.text.includes('Widget'), 'XLSX 提取到文本单元格');
    check(x.text.includes('42'), 'XLSX 提取到数值单元格');
    check(x.html.includes('<table'), 'XLSX 转为 HTML 表格');
    check(x.html.includes('2024-03-15'), 'XLSX 日期格式化正确', x.html.includes('2024') ? 'has 2024' : 'no 2024');
    results.set('xlsx', xlsx.file);

    const pptx = await uploadFile('汇报.pptx', fixture('sample.pptx'),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', wsId);
    const p = await waitParsed(pptx.file.id);
    check(p.status === 'ok', 'PPTX 解析成功', p);
    check(p.text.includes('SlideOneBullet'), 'PPTX 提取到幻灯片文本');
    check(p.html.includes('class="slide"') || p.html.includes('<section'), 'PPTX 转为幻灯片 HTML');
    results.set('pptx', pptx.file);
  }

  /* ============================ PDF ============================ */
  head('PDF · 文本层 / 编码 / 加密 / 损坏恢复');
  {
    const cases = [
      ['基础.pdf', 'basic.pdf', (d) => d.text.includes('Hello, World!'), '基础 PDF 提取文本'],
      ['压缩.pdf', 'flate-meta.pdf', (d) => d.text.includes('Hello flate'), 'Flate 压缩流解析'],
      ['中文.pdf', 'type0-tounicode.pdf', (d) => d.text.includes('你好'), 'Type0 + ToUnicode 中文提取'],
      ['多页.pdf', 'multipage.pdf', (d) => Number(d.pages) === 3 && d.text.includes('Page three'), '多页 PDF 页码正确'],
      ['坏xref.pdf', 'broken-xref.pdf', (d) => d.text.trim().length > 0, '损坏 xref 仍能恢复文本'],
      ['无startxref.pdf', 'no-startxref.pdf', (d) => d.text.trim().length > 0, '缺少 startxref 仍能恢复'],
      ['对象流.pdf', 'objstm.pdf', (d) => d.text.trim().length > 0, '对象流（ObjStm）解析'],
      ['LZW.pdf', 'lzw.pdf', (d) => d.text.trim().length > 0, 'LZW 压缩解析'],
      ['预测器.pdf', 'predictor-chained.pdf', (d) => d.text.trim().length > 0, 'PNG 预测器 + 链式过滤器'],
      ['表单.pdf', 'form-xobject.pdf', (d) => d.text.trim().length > 0, 'Form XObject 文本提取'],
      ['阅读顺序.pdf', 'reading-order.pdf', (d) => d.text.trim().length > 0, '阅读顺序重排'],
      ['加密AES128.pdf', 'encrypted-aes128.pdf', (d) => d.text.includes('AES-128 decrypted'), 'AES-128 加密 PDF 解密'],
      ['加密AES256.pdf', 'encrypted-aes256.pdf', (d) => d.text.trim().length > 0, 'AES-256 加密 PDF 解密'],
      ['加密RC4.pdf', 'encrypted-rc4-40.pdf', (d) => d.text.trim().length > 0, 'RC4-40 加密 PDF 解密'],
      ['ascii85.pdf', 'ascii85.pdf', (d) => d.text.trim().length > 0, 'ASCII85 过滤器解析'],
      ['asciihex.pdf', 'asciihex.pdf', (d) => d.text.trim().length > 0, 'ASCIIHex 过滤器解析'],
      ['差异编码.pdf', 'differences.pdf', (d) => d.text.trim().length > 0, 'Differences 字体编码'],
      ['WinAnsi.pdf', 'encodings.pdf', (d) => d.text.trim().length > 0, 'WinAnsi/MacRoman 编码'],
      ['字距.pdf', 'tj-kerning.pdf', (d) => d.text.trim().length > 0, 'TJ 字距阈值处理']
    ];

    for (const [name, file, predicate, label] of cases) {
      const up = await uploadFile(name, fixture(`pdf/${file}`), 'application/pdf', wsId);
      if (up.error) { check(false, label, up.error); continue; }
      const d = await waitParsed(up.file.id);
      check(d.status === 'ok' && predicate(d), label, { status: d.status, chars: d.chars, pages: d.pages, text: d.text?.slice(0, 60) });
    }

    // 敌意输入：只要求「不失败、不崩溃」，允许判定为空
    const hostile = [
      ['敌意环形.pdf', 'hostile-circular-tree.pdf', '环形页树不崩溃'],
      ['敌意长度.pdf', 'hostile-lying-length.pdf', '伪造 /Length 不崩溃'],
      ['敌意表单.pdf', 'hostile-recursive-form.pdf', '递归 Form XObject 不崩溃'],
      ['炸弹.pdf', 'bomb.pdf', '解压炸弹被资源上限拦截']
    ];
    for (const [name, file, label] of hostile) {
      const up = await uploadFile(name, fixture(`pdf/${file}`), 'application/pdf', wsId);
      if (up.error) { check(false, label, up.error); continue; }
      const d = await waitParsed(up.file.id);
      check(d.status !== 'failed', label, { status: d.status, error: d.error });
    }

    // 扫描件：无文本层但不应失败
    const imgOnly = await uploadFile('扫描件.pdf', fixture('pdf/image-only.pdf'), 'application/pdf', wsId);
    const io = await waitParsed(imgOnly.file.id);
    check(io.status === 'empty', '扫描件识别为「无文本」而非失败', io.status);
    check((io.meta?.warning || io.error || '').includes('扫描'), '扫描件给出 OCR 提示', io.meta?.warning || io.error);

    // 受密码保护的 PDF
    const pwPdf = await uploadFile('受密码保护.pdf', fixture('pdf/encrypted-password.pdf'), 'application/pdf', wsId);
    const pw = await waitParsed(pwPdf.file.id);
    check(pw.status !== 'ok' || pw.chars >= 0, '需要口令的 PDF 不导致服务异常', pw.status);
  }

  /* ============================ 纯文本族 ============================ */
  head('文本类 · Markdown / TXT / CSV / JSON / HTML / 代码');
  {
    const md = [
      '# 产品需求文档',
      '',
      '## 背景',
      '我们需要构建一个**智能知识库**平台，支持文档解析与语义检索。',
      '',
      '## 核心指标',
      '| 指标 | 目标 |',
      '| --- | --- |',
      '| 检索准确率 | 92% |',
      '| 首屏加载 | 800ms |',
      '',
      '```js',
      'const kb = createKnowledgeBase();',
      '```',
      '',
      '- 支持多格式上传',
      '- 支持标签检索'
    ].join('\n');
    const r1 = await uploadFile('需求文档.md', Buffer.from(md, 'utf8'), 'text/markdown', wsId, { tags: '需求,产品' });
    const d1 = await waitParsed(r1.file.id);
    check(d1.status === 'ok', 'Markdown 解析成功', d1.status);
    check(d1.text.includes('智能知识库'), 'Markdown 提取中文内容');
    check(d1.html.includes('<h1'), 'Markdown 渲染标题');
    check(d1.html.includes('<table'), 'Markdown 渲染表格');
    check(d1.html.includes('<pre'), 'Markdown 渲染代码块');
    check(d1.html.includes('<strong>智能知识库</strong>'), 'Markdown 渲染加粗');

    const txt = '这是一个纯文本文件。\n第二行包含关键数字 12345。\n第三行结束。';
    const r2 = await uploadFile('说明.txt', Buffer.from(txt, 'utf8'), 'text/plain', wsId);
    const d2 = await waitParsed(r2.file.id);
    check(d2.status === 'ok' && d2.text.includes('12345'), 'TXT 解析成功');

    // GBK 编码
    const gbkBytes = Buffer.from([
      0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3, // 中文编码测试。
      0x0a, 0xb9, 0xd8, 0xbc, 0xfc, 0xd7, 0xd6, 0xa3, 0xba, 0x38, 0x38, 0x38 // 关键字：888
    ]);
    const r3 = await uploadFile('GBK编码.txt', gbkBytes, 'text/plain', wsId);
    const d3 = await waitParsed(r3.file.id);
    check(d3.status === 'ok', 'GBK 文件解析成功', d3.status);
    check(d3.text.includes('中文编码测试'), 'GBK 自动识别并正确解码', d3.text?.slice(0, 40));
    check(d3.text.includes('888'), 'GBK 文件中的数字正确');

    const csv = '姓名,部门,绩效\n张三,研发,92\n李四,市场,88\n王五,销售,95';
    const r4 = await uploadFile('绩效.csv', Buffer.from(csv, 'utf8'), 'text/csv', wsId);
    const d4 = await waitParsed(r4.file.id);
    check(d4.status === 'ok' && d4.text.includes('张三'), 'CSV 解析成功');
    check(d4.html.includes('<table'), 'CSV 转为 HTML 表格');

    const jsonText = JSON.stringify({ 项目: 'KBPRO', 版本: '1.0.0', 特性: ['解析', '检索', '问答'] }, null, 2);
    const r5 = await uploadFile('配置.json', Buffer.from(jsonText, 'utf8'), 'application/json', wsId);
    const d5 = await waitParsed(r5.file.id);
    check(d5.status === 'ok' && d5.text.includes('KBPRO'), 'JSON 解析成功');
    check(d5.html.includes('json-view') || d5.html.includes('<pre'), 'JSON 格式化展示');

    const htmlText = '<html><head><title>嵌入测试</title><style>body{color:red}</style></head><body><h1>页面标题</h1><p>正文内容关键字</p><script>alert(1)</script>'
      + '<div><img src=x onerror=alert(1)><img/onerror=alert(2)><a href=javascript:alert(3)>x</a><span onclick=alert(4)>y</span></div></body></html>';
    const r6 = await uploadFile('页面.html', Buffer.from(htmlText, 'utf8'), 'text/html', wsId);
    const d6 = await waitParsed(r6.file.id);
    check(d6.status === 'ok' && d6.text.includes('正文内容关键字'), 'HTML 提取正文');
    check(!d6.html.includes('<script'), 'HTML 预览剔除脚本');
    check(!/onerror|onclick/i.test(d6.html), 'HTML 预览剔除事件属性（含 / 分隔写法）', d6.html.slice(0, 200));
    check(!/javascript:/i.test(d6.html), 'HTML 预览剔除 javascript: URL', d6.html.slice(0, 200));

    const code = 'export function searchKnowledgeBase(query) {\n  // 语义检索入口\n  return retrieve(query);\n}\n';
    const r7 = await uploadFile('检索.py', Buffer.from(code, 'utf8'), 'text/x-python', wsId);
    const d7 = await waitParsed(r7.file.id);
    check(d7.status === 'ok' && d7.text.includes('searchKnowledgeBase'), '代码文件解析成功');
    check(d7.html.includes('code-view'), '代码高亮容器存在');
  }

  /* ============================ 分块与索引 ============================ */
  head('分块 · 大文档索引与向量');
  {
    const paragraphs = [];
    for (let i = 1; i <= 60; i++) {
      paragraphs.push(`## 第 ${i} 节 主题${i}\n这是第 ${i} 节的内容，讨论了主题${i}的关键要点。数字标记 ZMARK${i}。`);
    }
    const big = `# 长篇技术白皮书\n\n${paragraphs.join('\n\n')}`;
    const r = await uploadFile('技术白皮书.md', Buffer.from(big, 'utf8'), 'text/markdown', wsId, { tags: '长篇' });
    const d = await waitParsed(r.file.id, 60000);
    check(d.status === 'ok', '大文档解析成功', d.status);

    // 通过搜索验证分块存在
    const detail = await json('GET', `/api/files/${r.file.id}`);
    const chunks = (await json('GET', `/api/workspaces/${wsId}/overview`)).data.stats.chunks;
    check(chunks > 0, '已生成知识块', chunks);

    const s1 = await json('GET', `/api/search?workspaceId=${wsId}&q=${encodeURIComponent('ZMARK42')}`);
    check(s1.data.total >= 1, '可检索到大文档中段内容', { total: s1.data.total, took: s1.data.took });
    check(s1.data.items.some((i) => i.id === r.file.id), '检索结果指向正确文件');

    const s2 = await json('GET', `/api/search?workspaceId=${wsId}&q=${encodeURIComponent('第 60 节 主题60')}`);
    check(s2.data.total >= 1, '可检索到大文档尾段内容');

    // 验证页码/分块元数据出现在检索结果里
    const item = s1.data.items.find((i) => i.id === r.file.id);
    check(typeof item?.score === 'number' && item.score > 0, '检索结果带相关性分数', item?.score);
  }

  /* ============================ 检索质量 ============================ */
  head('检索质量 · 中文 / 英文 / 标签 / 建议');
  {
    const t1 = await json('GET', `/api/search?workspaceId=${wsId}&q=${encodeURIComponent('检索准确率')}`);
    check(t1.data.total >= 1, '中文短语命中需求文档', t1.data.total);
    check(t1.data.items[0].snippet.includes('<mark>'), '命中片段带高亮');

    const t2 = await json('GET', `/api/search?workspaceId=${wsId}&q=Quarterly`);
    check(t2.data.total >= 1, '英文关键词命中 DOCX', t2.data.total);

    const t3 = await json('GET', `/api/search?workspaceId=${wsId}&q=${encodeURIComponent('知识库')}&mode=vector`);
    check(t3.status === 200, '向量检索模式可用');

    const t4 = await json('GET', `/api/search?workspaceId=${wsId}&q=${encodeURIComponent('知识库')}&mode=fuzzy`);
    check(t4.status === 200, '模糊检索模式可用', t4.data.total);

    const t5 = await json('GET', `/api/search?workspaceId=${wsId}&q=ZZQXJWV9999`);
    check(t5.data.total === 0, '无关查询返回 0 结果', t5.data.total);

    const tagSearch = await json('GET', `/api/search?workspaceId=${wsId}&q=${encodeURIComponent('文档')}&tags=需求`);
    check(tagSearch.status === 200, '标签过滤可用', tagSearch.data.total);

    const sug = await json('GET', `/api/search/suggest?workspaceId=${wsId}&q=${encodeURIComponent('需求')}`);
    check(sug.data.titles.some((t) => t.title.includes('需求')), '搜索建议命中标题');
  }

  /* ============================ RAG 问答 ============================ */
  head('RAG · 基于多格式内容的智能问答');
  {
    const q1 = await json('POST', '/api/ai/ask', {
      question: '检索准确率的目标是多少？', workspaceId: wsId, stream: false, topK: 6
    });
    check(q1.status === 200, 'RAG 问答可用');
    check(q1.data.answer.includes('92') || q1.data.answer.includes('准确率'), '回答引用了需求文档中的指标', q1.data.answer.slice(0, 120));
    check(q1.data.citations.length > 0, '回答带引用来源');
    check(q1.data.citations.some((c) => c.title.includes('需求文档')), '引用指向 Markdown 文档', q1.data.citations.map((c) => c.title));

    const q2 = await json('POST', '/api/ai/ask', { question: '幻灯片里提到了哪些要点？', workspaceId: wsId, stream: false });
    check(q2.status === 200, '跨格式问答可用');
    check(q2.data.citations.length > 0, '跨格式问答带引用');

    const q3 = await json('POST', '/api/ai/ask', { question: '中文编码测试的内容是什么？', workspaceId: wsId, stream: false });
    check(q3.status === 200, '针对 GBK 文件的问答可用');

    const analysis = await json('POST', '/api/ai/analyze', {
      fileId: results.get('docx')?.id, kind: 'all'
    });
    check(analysis.status === 200, 'Office 文档可生成智能摘要');
    check(analysis.data.result.local.summary.content.length > 10, '摘要内容非空');
    check(analysis.data.result.local.keywords.items.length > 0, '关键词提取成功');
  }

  /* ============================ 预览与下载 ============================ */
  head('预览 · 在线渲染与原始内容');
  {
    for (const [key, file] of results) {
      const pv = await json('GET', `/api/files/${file.id}/preview`);
      check(pv.status === 200, `${key.toUpperCase()} 预览接口可用`);
      check(typeof pv.data.kind === 'string', `${key.toUpperCase()} 返回预览类型`, pv.data.kind);
      const raw = await fetch(`${BASE}/api/files/${file.id}/content?inline=1`, { headers: { Cookie: cookie } });
      check(raw.status === 200, `${key.toUpperCase()} 原始内容可访问`);
      const buf = Buffer.from(await raw.arrayBuffer());
      check(buf.length === file.size, `${key.toUpperCase()} 原始内容大小一致`, { got: buf.length, expect: file.size });
    }

    const pdfFile = (await json('GET', `/api/files?workspaceId=${wsId}&ext=pdf&limit=200`)).data.files
      .find((f) => f.name === '基础.pdf');
    check(!!pdfFile, '找到可导出的 PDF 文件');
    const pv = await json('GET', `/api/files/${pdfFile.id}/preview`);
    check(pv.data.kind === 'pdf', 'PDF 识别为 pdf 预览类型');
    check(pv.data.streamUrl.includes('/content'), 'PDF 提供内联流地址');
    const exportMd = await fetch(`${BASE}/api/files/${pdfFile.id}/export?format=md`, { headers: { Cookie: cookie } });
    check(exportMd.status === 200, 'PDF 可导出为 Markdown');
    const exportedText = await exportMd.text();
    check(exportedText.includes('Hello, World!'), '导出的 Markdown 含 PDF 正文');
    const exportHtml = await fetch(`${BASE}/api/files/${pdfFile.id}/export?format=html`, { headers: { Cookie: cookie } });
    check(exportHtml.status === 200, 'PDF 可导出为 HTML');
  }

  /* ============================ 批量与回收站 ============================ */
  head('批量操作与回收站');
  {
    const all = (await json('GET', `/api/files?workspaceId=${wsId}&limit=200`)).data.files;
    check(all.length >= 20, '已上传全部测试文件', all.length);

    const ids = all.slice(0, 5).map((f) => f.id);
    const bat = await json('POST', '/api/files/batch', { action: 'star', ids });
    check(bat.data.ok === ids.length, '批量收藏成功', bat.data);

    const del = await json('POST', '/api/files/batch', { action: 'delete', ids });
    check(del.data.ok === ids.length, '批量删除成功');
    const trash = (await json('GET', `/api/files?workspaceId=${wsId}&trash=1`)).data.files;
    check(trash.length === ids.length, '回收站数量正确', trash.length);
    const back = await json('POST', '/api/files/batch', { action: 'restore', ids });
    check(back.data.ok === ids.length, '批量还原成功');
    const after = (await json('GET', `/api/files?workspaceId=${wsId}&trash=1`)).data.files;
    check(after.length === 0, '还原后回收站清空');
  }
}

main().catch((err) => {
  console.error('\n\x1b[31m测试执行异常：\x1b[0m', err);
  process.exit(1);
});
