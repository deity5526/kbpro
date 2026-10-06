/**
 * KBPRO — 本地抽取式 AI 引擎（零依赖 / 离线可用）
 * 当未配置任何大模型（Ollama / OpenAI 兼容接口）时，本引擎保证知识库的
 * 摘要、提炼、问答、知识关联等能力依然可用：
 *   · 摘要 —— 基于 TextRank 风格句子图 + 词频 + 位置权重的抽取式摘要
 *   · 提炼 —— 要点/大纲/关键词/术语表/FAQ 结构化产出
 *   · 问答 —— 检索增强的抽取式作答，附来源引用
 *   · 拓展 —— 基于上下文的关键词扩展与相关问题生成
 */
import {
  splitSentences, tokenize, termFreq, extractKeywords, splitSections,
  normalizeWhitespace, truncate, makeSnippet, escapeHtml
} from './text.js';

/* ------------------------------------------------------------------ 句子打分 */

/**
 * TextRank-lite：句子相似度图 + 幂迭代，返回句子重要性。
 */
export function scoreSentences(sentences, { damping = 0.85, iterations = 24 } = {}) {
  const total = sentences.length;
  if (total === 0) return [];
  if (total === 1) return [1];

  // TextRank 使用稠密 n×n 相似度矩阵；超大文档会导致内存耗尽，
  // 因此仅对前 MAX_GRAPH_SENTENCES 句构图，其余句子按均值打分。
  const MAX_GRAPH_SENTENCES = 1200;
  const n = Math.min(total, MAX_GRAPH_SENTENCES);

  const tokenSets = sentences.map((s) => new Set(tokenize(s)));
  const sim = new Array(n);
  for (let i = 0; i < n; i++) sim[i] = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = tokenSets[i];
      const b = tokenSets[j];
      if (!a.size || !b.size) continue;
      let inter = 0;
      const [small, large] = a.size < b.size ? [a, b] : [b, a];
      for (const t of small) if (large.has(t)) inter++;
      if (!inter) continue;
      const denom = Math.log(a.size + 1) + Math.log(b.size + 1);
      const w = denom > 0 ? inter / denom : 0;
      sim[i][j] = w;
      sim[j][i] = w;
    }
  }

  // 位置权重：开头与结尾略高
  const posWeight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rel = i / Math.max(1, n - 1);
    posWeight[i] = 0.65 + 0.5 * Math.exp(-6 * rel) + 0.25 * Math.exp(-6 * (1 - rel));
  }

  let rank = new Float32Array(n).fill(1 / n);
  const outDeg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += sim[i][j];
    outDeg[i] = s;
  }

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (i === j || sim[j][i] === 0 || outDeg[j] === 0) continue;
        sum += (sim[j][i] / outDeg[j]) * rank[j];
      }
      next[i] = (1 - damping) / n + damping * sum;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - rank[i]);
    rank = next;
    if (diff < 1e-5) break;
  }

  const result = new Array(total);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    result[i] = rank[i] * posWeight[i] * 1000;
    sum += result[i];
  }
  const avg = n ? sum / n : 0;
  for (let i = n; i < total; i++) result[i] = avg;
  return result;
}

/** 选择信息量高且不冗余的句子 */
export function selectSentences(sentences, scores, maxSentences, { minLen = 12, maxLen = 320 } = {}) {
  const idx = sentences
    .map((s, i) => ({ i, s, score: scores[i] || 0 }))
    .filter((x) => x.s.length >= minLen)
    .sort((a, b) => b.score - a.score);

  const chosen = [];
  const chosenTokens = [];
  for (const cand of idx) {
    if (chosen.length >= maxSentences) break;
    const len = cand.s.length;
    if (len > maxLen) {
      const clipped = truncate(cand.s, maxLen);
      cand.s = clipped;
    }
    const toks = new Set(tokenize(cand.s));
    let dup = 0;
    for (const prev of chosenTokens) {
      let inter = 0;
      for (const t of toks) if (prev.has(t)) inter++;
      const ratio = inter / Math.max(1, Math.min(toks.size, prev.size));
      if (ratio > dup) dup = ratio;
    }
    if (dup > 0.72) continue;
    chosen.push(cand);
    chosenTokens.push(toks);
  }
  return chosen.sort((a, b) => a.i - b.i);
}

/* ------------------------------------------------------------------ 摘要 */

export function localSummarize(text, { maxSentences = 7, style = 'paragraph', title = '' } = {}) {
  const clean = normalizeWhitespace(text);
  if (!clean) return { content: '（无可用文本内容）', kind: 'empty' };
  const sentences = splitSentences(clean);
  if (sentences.length <= 2) return { content: clean.slice(0, 2000), kind: 'short' };

  const scores = scoreSentences(sentences);
  const picked = selectSentences(sentences, scores, maxSentences);

  if (style === 'bullets') {
    const lines = picked.map((p) => `- ${p.s.trim()}`).join('\n');
    return { content: lines, kind: 'bullets' };
  }
  const content = picked.map((p) => p.s.trim()).join('');
  const kw = extractKeywords(clean, 8);
  const head = title ? `**${title}**\n\n` : '';
  return {
    content: `${head}${content}\n\n> 关键词：${kw.join(' · ')}`,
    kind: 'paragraph',
    keywords: kw
  };
}

/* ------------------------------------------------------------------ 提炼 / 大纲 */

export function localOutline(text, { maxItems = 14 } = {}) {
  const clean = normalizeWhitespace(text);
  if (!clean) return { content: '', items: [] };
  const sections = splitSections(clean);

  const items = [];
  if (sections.length > 1) {
    for (const sec of sections) {
      const body = sec.text;
      if (!body && !sec.heading) continue;
      const sentences = splitSentences(body);
      const scores = scoreSentences(sentences);
      const picked = selectSentences(sentences, scores, 3).map((p) => p.s.trim());
      items.push({
        heading: sec.heading || truncate(sentences[0] || '正文', 40),
        points: picked.length ? picked : [truncate(body, 160)],
        keywords: extractKeywords(body || sec.heading, 5)
      });
      if (items.length >= maxItems) break;
    }
  }
  if (!items.length) {
    const sentences = splitSentences(clean);
    const scores = scoreSentences(sentences);
    const picked = selectSentences(sentences, scores, maxItems);
    for (const p of picked) {
      items.push({ heading: truncate(p.s, 60), points: [p.s.trim()], keywords: extractKeywords(p.s, 4) });
    }
  }

  const md = items
    .map((it, i) => `### ${i + 1}. ${it.heading}\n${it.points.map((p) => `- ${p}`).join('\n')}`)
    .join('\n\n');
  return { content: md, items };
}

export function localKeywordReport(text, { limit = 16 } = {}) {
  const clean = normalizeWhitespace(text);
  const kw = extractKeywords(clean, limit);
  const toks = tokenize(clean);
  const tf = termFreq(toks);
  const items = kw.map((k) => ({ term: k, weight: tf.get(k) || 0 }));
  const max = Math.max(1, ...items.map((i) => i.weight));
  return {
    items: items.map((i) => ({ ...i, ratio: Number((i.weight / max).toFixed(3)) })),
    content: items.map((i) => `${i.term} (${i.weight})`).join(' · ')
  };
}

/* ------------------------------------------------------------------ 问答（抽取式） */

/**
 * @param {string} question
 * @param {{id:string, fileId?:string, title:string, text:string, page?:number, heading?:string, score?:number}[]} contexts
 */
export function localAnswer(question, contexts, { maxSentences = 6, maxPerContext = 3 } = {}) {
  const qTerms = extractKeywords(question, 12);
  const qTokens = new Set(tokenize(question));
  if (!contexts.length) {
    return {
      answer: '未在知识库中检索到与该问题相关的内容。建议：\n1) 上传或补充相关文档；\n2) 换用其它关键词重试；\n3) 确认当前所处知识库（个人 / 团队）是否正确。',
      citations: [],
      confidence: 0
    };
  }

  const scored = [];
  for (const ctx of contexts) {
    const sentences = splitSentences(ctx.text);
    if (!sentences.length) continue;
    const graph = scoreSentences(sentences);
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const toks = new Set(tokenize(s));
      let overlap = 0;
      for (const t of toks) if (qTokens.has(t)) overlap++;
      const coverage = overlap / Math.max(1, qTokens.size);
      const kwHit = qTerms.filter((k) => s.toLowerCase().includes(k.toLowerCase())).length;
      const score = coverage * 3 + kwHit * 0.45 + (graph[i] / 1000) * 0.8 + (ctx.score || 0) * 0.25;
      scored.push({ s: s.trim(), score, ctx, sentIdx: i });
    }
  }

  if (!scored.length) {
    return { answer: truncate(contexts[0].text, 600), citations: [cite(contexts[0], 0)], confidence: 0.2 };
  }

  scored.sort((a, b) => b.score - a.score);
  const perCtx = new Map();
  const chosen = [];
  for (const item of scored) {
    const key = item.ctx.id;
    const used = perCtx.get(key) || 0;
    if (used >= maxPerContext) continue;
    if (chosen.some((c) => c.s === item.s)) continue;
    perCtx.set(key, used + 1);
    chosen.push(item);
    if (chosen.length >= maxSentences) break;
  }

  const top = scored[0].score || 1;
  const confidence = Math.max(0.15, Math.min(0.92, 0.35 + (top / 6) * 0.4 + Math.min(0.2, chosen.length * 0.03)));

  const lead = chosen.slice(0, 2).map((c) => c.s).join('');
  const rest = chosen.slice(2);
  let answer = `**依据知识库内容的回答：**\n\n${lead}\n`;
  if (rest.length) {
    answer += '\n**补充要点：**\n' + rest.map((c) => `- ${c.s}`).join('\n') + '\n';
  }
  const kws = extractKeywords(chosen.map((c) => c.s).join(' '), 8);
  if (kws.length) answer += `\n**关联关键词：** ${kws.join(' · ')}\n`;

  const citations = [];
  const seen = new Set();
  for (const c of chosen) {
    const key = `${c.ctx.fileId || c.ctx.id}#${c.s.slice(0, 24)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(cite(c.ctx, c.s));
    if (citations.length >= 6) break;
  }
  answer += `\n> 说明：以上内容由本地抽取式引擎从知识库原文中摘取并组织，未经过大模型改写。接入大模型后可获得生成式回答。`;
  return { answer, citations, confidence: Number(confidence.toFixed(2)) };
}

function cite(ctx, sentence) {
  return {
    id: ctx.id,
    fileId: ctx.fileId || ctx.id,
    title: ctx.title || '未命名',
    page: ctx.page || 0,
    heading: ctx.heading || '',
    snippet: typeof sentence === 'string' ? truncate(sentence, 240) : truncate(ctx.text || '', 240),
    score: Number((ctx.score || 0).toFixed(4))
  };
}

/* ------------------------------------------------------------------ 拓展 / 关联 */

export function localExpand(topic, contexts, { count = 5 } = {}) {
  const corpus = contexts.map((c) => c.text).join('\n');
  const kws = extractKeywords(`${topic} ${corpus}`, 18);
  const related = kws.filter((k) => !topic.toLowerCase().includes(k.toLowerCase())).slice(0, 10);

  const questions = [];
  const templates = [
    (k) => `${k} 的核心要点是什么？`,
    (k) => `${k} 在实际场景中如何应用？`,
    (k) => `${k} 与哪些概念存在关联？`,
    (k) => `关于 ${k} 还有哪些待确认的问题？`,
    (k) => `${k} 的最佳实践与常见误区分别是什么？`
  ];
  for (let i = 0; i < related.length && questions.length < count; i++) {
    questions.push(templates[i % templates.length](related[i]));
  }

  return {
    keywords: related,
    questions,
    content: `**知识拓展**\n\n**关联概念：** ${related.join(' · ') || '（暂无）'}\n\n**可继续追问：**\n${questions.map((q) => `- ${q}`).join('\n')}`
  };
}

export function localCompare(texts, { maxPoints = 8 } = {}) {
  const kwSets = texts.map((t) => new Set(extractKeywords(t.text || '', 20)));
  const common = [...kwSets[0] || []].filter((k) => kwSets.every((s) => s.has(k)));
  const diffs = texts.map((t, i) => ({
    title: t.title,
    unique: [...(kwSets[i] || [])].filter((k) => !kwSets.some((s, j) => j !== i && s.has(k))).slice(0, 8)
  }));
  return {
    common,
    unique: diffs,
    content: `**共有关键点：** ${common.join(' · ') || '（无）'}\n\n` +
      diffs.map((d) => `**${d.title} 独有：** ${d.unique.join(' · ') || '（无）'}`).join('\n\n')
  };
}

export { escapeHtml, makeSnippet };
