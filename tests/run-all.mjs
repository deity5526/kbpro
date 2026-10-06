/**
 * KBPRO — 全量测试入口
 *   node tests/run-all.mjs           运行全部（除耗时的第三方模块单测外）
 *   node tests/run-all.mjs --full    连同文档解析 / PDF / Office 单测一起跑
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FULL = process.argv.includes('--full');

const SUITES = [
  { file: 'tests/test-frontend.mjs', label: '前端契约审计', desc: '语法 / 导入 / 图标 / API / 路由 / 样式' },
  { file: 'tests/test-api.mjs', label: '后端 API 端到端', desc: '认证、权限、文件、笔记、检索、RAG、备份' },
  { file: 'tests/test-formats.mjs', label: '多格式解析与检索', desc: 'PDF/Word/Excel/PPT/文本 全链路' }
];

const EXTRA = [
  { file: 'tests/test-officedoc.mjs', label: 'Office 解析单测', desc: 'zip.js + officedoc.js' },
  { file: 'tests/test-pdf.mjs', label: 'PDF 解析单测', desc: 'pdf.js 过滤器 / 编码 / 加密 / 容错' },
  { file: 'tests/test-browser.mjs', label: '无头浏览器渲染', desc: '真实 Chromium 渲染全部路由（环境不支持时自动跳过）' }
];

const suites = FULL ? [...SUITES, ...EXTRA] : SUITES;
const results = [];

console.log('\n\x1b[1mKBPRO 全量测试\x1b[0m');
console.log('═'.repeat(68));
if (!FULL) {
  console.log('提示：使用 --full 可一并运行 Office / PDF 解析器单测\n');
}

for (const suite of suites) {
  const full = path.join(ROOT, suite.file);
  if (!fs.existsSync(full)) {
    results.push({ ...suite, status: 'skip', code: null, output: '文件不存在' });
    console.log(`\x1b[33m⊘ 跳过\x1b[0m ${suite.label}（${suite.file} 不存在）`);
    continue;
  }
  console.log(`\n\x1b[1m▸ ${suite.label}\x1b[0m  \x1b[2m${suite.desc}\x1b[0m`);
  const started = Date.now();
  const res = spawnSync(process.execPath, [suite.file], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env }
  });
  const ms = Date.now() - started;
  const code = res.status ?? 1;
  results.push({ ...suite, status: code === 0 ? 'pass' : 'fail', code, ms });
  console.log(`\x1b[2m  └ ${suite.label} 用时 ${(ms / 1000).toFixed(1)}s\x1b[0m`);
}

console.log('\n' + '═'.repeat(68));
console.log('\x1b[1m汇总\x1b[0m');
for (const r of results) {
  const mark = r.status === 'pass' ? '\x1b[32m✓ 通过\x1b[0m'
    : r.status === 'fail' ? '\x1b[31m✗ 失败\x1b[0m'
      : '\x1b[33m⊘ 跳过\x1b[0m';
  const time = r.ms ? ` \x1b[2m${(r.ms / 1000).toFixed(1)}s\x1b[0m` : '';
  console.log(`  ${mark}  ${r.label}${time}`);
}
const failedCount = results.filter((r) => r.status === 'fail').length;
console.log('═'.repeat(68));
console.log(failedCount === 0
  ? `\x1b[32m全部 ${results.filter((r) => r.status === 'pass').length} 个测试套件通过\x1b[0m`
  : `\x1b[31m${failedCount} 个测试套件失败\x1b[0m`);
process.exit(failedCount === 0 ? 0 : 1);
