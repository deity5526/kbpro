/**
 * KBPRO — 示例知识库种子数据
 * 通过 HTTP API 向正在运行的服务导入一批示例文档（Markdown），用于体验检索与智能问答。
 *
 * 用法：
 *   先启动服务： node server/index.js
 *   另开终端：   node scripts/seed-demo.mjs
 *
 * 可用环境变量覆盖：
 *   KBPRO_SEED_BASE     默认 http://127.0.0.1:8787
 *   KBPRO_SEED_EMAIL    默认取 config.json 的 bootstrap.email
 *   KBPRO_SEED_PASSWORD 默认取 config.json 的 bootstrap.password
 *   KBPRO_SEED_WORKSPACE 指定目标知识库 id（默认导入到个人知识库）
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { loadConfig } from '../server/config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const cfg = loadConfig();
const BASE = (process.env.KBPRO_SEED_BASE || `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`).replace(/\/+$/, '');
const EMAIL = process.env.KBPRO_SEED_EMAIL || cfg.bootstrap.email;
const PASSWORD = process.env.KBPRO_SEED_PASSWORD || cfg.bootstrap.password;

const DOCS = [
  {
    name: '公司简介.md',
    tags: '示例,公司',
    content: `# 星澜科技 · 公司简介

## 一、基本信息
星澜科技（StellarWave）成立于 2018 年 3 月，总部位于杭州，是一家专注于企业级知识管理与人工智能应用的软件公司。
公司现有员工 186 人，其中研发人员 112 人，在成都与西安设有研发中心。

## 二、主营业务
- 智能知识库平台（KBPRO）：面向个人与团队的知识沉淀与智能问答。
- 企业文档中台：多格式解析、检索与权限治理。
- AI 应用咨询与落地实施。

## 三、服务理念
让散落的文档变成可对话的知识，帮助组织把经验沉淀为可复用的资产。

## 四、联系方式
- 官网：https://example.com
- 商务合作：bd@example.com
- 客服热线：400-000-1234（工作日 9:00–18:00）
`
  },
  {
    name: 'KBPRO产品手册.md',
    tags: '示例,产品',
    content: `# KBPRO 产品手册

KBPRO 是一套零外部依赖的智能知识库系统，覆盖“文档存储 → 智能解析 → 问答检索 → 知识沉淀”。

## 核心能力
1. 多格式解析：支持 PDF、Word（DOCX）、Excel（XLSX）、PPT（PPTX）、Markdown、TXT、CSV、JSON、HTML 与常见代码文件；自动识别 UTF-8 / GBK / UTF-16 编码。
2. 在线预览：PDF 内联渲染，Office 转结构化 HTML，无需下载。
3. 混合检索：BM25（中文二元组分词）+ 向量召回 + RRF 融合，结果关键词高亮。
4. RAG 问答：文档分块 → 向量化 → 混合召回 → 重排 → 生成，答案逐句标注引用来源（文件 + 页码 + 章节）。
5. 团队协作：个人与团队知识库双体系隔离，5 级角色权限，支持资源级共享与分享链接。

## 部署与运行
- 环境要求：Node.js 22.5 及以上。
- 启动命令：node server/index.js
- 默认访问地址：http://127.0.0.1:8787
- 数据默认存放于项目根目录的 data 目录。

## 能力边界
- 内置哈希嵌入为词面近似，非真正的语义嵌入；接入大模型 embedding 后可提升语义召回。
- 未接入大模型时，问答为抽取式，不做改写润色。
- 加密为服务端对称加密，非端到端零知识。
`
  },
  {
    name: '2026年第三季度经营报告.md',
    tags: '示例,财报',
    content: `# 2026 年第三季度经营报告

## 一、核心结论
本季度营业收入 1.27 亿元，同比增长 23.4%；其中企业服务业务收入 5,180 万元，同比增长 41.2%，是主要增长驱动力。
客户留存率达到 94.7%，较上季度提升 2.1 个百分点。
付费客户数达到 863 家，本季度净增 96 家。

## 二、风险提示
供应链成本上升 8.3%，预计下季度毛利率承压约 1.5 个百分点。
海外市场合规成本增加，需要在第四季度前完成数据合规审计。

## 三、下季度计划
1. 重点投入智能知识库产品的研发，目标是在十二月底前发布商用版本。
2. 计划新增 3 个行业解决方案：金融、医疗、制造业。
3. 团队规模扩充至 220 人，重点补充算法与实施岗位。
`
  },
  {
    name: '新员工入职指南.md',
    tags: '示例,HR',
    content: `# 新员工入职指南

## 一、入职第一天
1. 到前台领取工牌与办公设备。
2. 由 HR 引导完成劳动合同签署与信息登记。
3. 加入所在部门的企业微信群，认识导师与同事。

## 二、账号与权限
- 邮箱与办公账号由 IT 部门统一开通，通常当天完成。
- 内部知识库 KBPRO 账号由所在部门管理员邀请加入。
- 需要额外系统权限时，在工单系统提交申请，由直属主管审批。

## 三、试用期与转正
试用期一般为 3 个月，表现优异者可提前转正。
转正需提交试用期工作总结，并由主管进行转正评估。

## 四、常用资源
- 报销流程与标准见《财务报销制度》。
- 请假、调休通过 OA 系统提交，需提前一个工作日申请。
- 公司每月最后一周周五举办技术分享会。
`
  },
  {
    name: '常见问题FAQ.md',
    tags: '示例,FAQ',
    content: `# 常见问题 FAQ

**Q1：KBPRO 需要联网吗？**
不需要。系统仅使用 Node.js 内置模块，可完全离线运行。接入云端大模型时才需要外网。

**Q2：支持哪些大模型？**
支持 Ollama 本地模型、任意 OpenAI 兼容接口（如 DeepSeek、通义千问、Kimi、智谱），以及内置的本地抽取式引擎。

**Q3：上传的文件存在哪里？**
默认存放在项目根目录的 data/files 目录下，按知识库与月份分桶存储；私密文件会以 AES-256-GCM 加密落盘。

**Q4：如何备份数据？**
在「系统管理 → 备份」中创建 metadata（仅数据库）或 full（数据库 + 文件）备份，full 备份可选口令加密。

**Q5：忘记管理员密码怎么办？**
可删除 data 目录下的 kbpro.sqlite 重置（会清空数据），或在其他管理员账号的「系统管理」中重置。

**Q6：检索不到刚上传的文档？**
文档上传后需要后台解析完成才能被检索，可在文件库查看解析状态，或手动点击「重建索引」。
`
  }
];

async function main() {
  console.log(`KBPRO 示例数据导入 · 服务地址 ${BASE}`);

  let login;
  try {
    login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    });
  } catch (err) {
    console.error(`✗ 无法连接服务 ${BASE}，请先运行： node server/index.js`);
    process.exit(1);
  }
  if (!login.ok) {
    console.error(`✗ 登录失败（${login.status}）。请确认账号密码（可用 KBPRO_SEED_EMAIL / KBPRO_SEED_PASSWORD 覆盖）。`);
    process.exit(1);
  }
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  console.log(`✓ 登录成功：${EMAIL}`);

  const wsRes = await fetch(`${BASE}/api/workspaces`, { headers: { cookie } });
  const wsData = await wsRes.json();
  const list = wsData.workspaces || [];
  const target = process.env.KBPRO_SEED_WORKSPACE
    ? list.find((w) => w.id === process.env.KBPRO_SEED_WORKSPACE)
    : (list.find((w) => w.kind === 'personal') || list[0]);
  if (!target) {
    console.error('✗ 没有可导入的知识库，请先在应用中创建一个知识库。');
    process.exit(1);
  }
  console.log(`✓ 目标知识库：${target.name}（${target.id}）`);

  let ok = 0;
  for (const doc of DOCS) {
    const fd = new FormData();
    fd.append('workspaceId', target.id);
    fd.append('tags', doc.tags || '');
    fd.append('file', new Blob([doc.content], { type: 'text/markdown' }), doc.name);
    const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { cookie }, body: fd });
    const data = await up.json().catch(() => ({}));
    if (up.ok && data.ok) {
      ok++;
      console.log(`  ✓ 已导入 ${doc.name}`);
    } else {
      console.log(`  ✗ ${doc.name} 导入失败：${data.error || up.status}`);
    }
  }
  console.log(`\n完成：成功导入 ${ok}/${DOCS.length} 篇示例文档。`);
  console.log('等待后台解析完成后，即可在「全局检索」和「智能问答」中体验。');
}

main().catch((err) => {
  console.error('导入异常：', err?.message || err);
  process.exit(1);
});
