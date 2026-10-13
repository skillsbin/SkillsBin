#!/usr/bin/env node
/**
 * 发现层：GitHub Search 主动找 skill 仓库 → 待审候选队列
 * ------------------------------------------------------------
 * 用法：node crawler/discover.mjs [--code] [--dry-run]
 *
 * 输出：
 *   crawler/candidates/pending.json   待审候选（派生数据，不进站点产物）
 *   crawler/candidates/rejected.json  已拒名单（rejectRetryDays 内不再重复消耗请求）
 *
 * 纪律：本脚本**不写** config.json.watchlist —— 那是 consume-approved.mjs 的唯一职责。
 */
import { join } from 'node:path';
import { ROOT, loadEnv, readJson, writeJson } from './lib.mjs';
import { GhClient } from './github.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const WITH_CODE = !args.includes('--no-code');

const CONFIG = readJson(join(ROOT, 'crawler', 'config.json'), {});
const ENV = loadEnv();
const TOKEN = process.env.GITHUB_TOKEN || ENV.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('✖ 缺少 GITHUB_TOKEN');
  process.exit(1);
}

const D = CONFIG.discover || {};
const gh = new GhClient({ token: TOKEN, ...CONFIG.limits });
const CAND_DIR = join(ROOT, 'crawler', 'candidates');
const PENDING = join(CAND_DIR, 'pending.json');
const REJECTED = join(CAND_DIR, 'rejected.json');

const inWatchlist = new Set((CONFIG.watchlist || []).map((k) => k.toLowerCase()));
const rejected = readJson(REJECTED, { items: [] });
const rejectedMap = new Map((rejected.items || []).map((r) => [r.key.toLowerCase(), r]));
const retryMs = (D.rejectRetryDays ?? 60) * 86400000;

const found = new Map(); // lower(full_name) -> candidate
const add = (full, extra) => {
  const key = full.toLowerCase();
  if (inWatchlist.has(key)) return;
  const rej = rejectedMap.get(key);
  if (rej && Date.now() - Date.parse(rej.rejectedAt) < retryMs) return;
  if (!found.has(key)) found.set(key, { key: full, owner: full.split('/')[0], repo: full.split('/')[1], ...extra });
};

console.log('\n▶ 发现层');

/* S5 仓库搜索（30 次/分钟）—— 支持分页，否则每轮只看到各 topic 的前 50 个（永远是同一批） */
const repoPages = Math.max(1, D.queryPages ?? 1);
for (const q of D.queries || []) {
  const query = q
    .replace('{minStars}', String(D.minStars ?? 150))
    .replace('{daysAgo}', new Date(Date.now() - (D.daysAgo ?? 60) * 86400000).toISOString().slice(0, 10));
  let kept = 0;
  for (let page = 1; page <= repoPages; page++) {
    const r = await gh.search(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=50&page=${page}`);
    const items = r.data?.items || [];
    if (!items.length) break;
    for (const it of items) {
      if (it.fork || it.archived) continue;
      if ((it.stargazers_count || 0) < (D.minStars ?? 150)) continue;
      add(it.full_name, { source: 'repo-search', stars: it.stargazers_count, desc: it.description || '', pushedAt: it.pushed_at });
      kept++;
    }
  }
  console.log(`  · repo  ${query}  → 收 ${kept}（${repoPages} 页）`);
}

/* S4 代码搜索（独立配额 10 次/分钟，必须带 token）—— 每轮限次
   命中的仓库按定义**含 SKILL.md / marketplace.json / .clinerules**，是最靠谱的候选来源。
   ⚠️ 坑：/search/code 返回的 repository 对象**不含 stargazers_count / pushed_at**
   （GitHub 只给 id/name/full_name/owner/description/fork/...），若直接入库，
   后面的 stars>=minStars 过滤会把它们全部筛掉（表现为「候选清一色高星通用仓库」）。
   因此先收集去重，再对前 codeEnrichLimit 个补查 /repos/:owner/:repo 拿真实星标。 */
if (WITH_CODE && D.codeQueries?.length) {
  const codePages = Math.max(1, D.codeQueryPages ?? 1);
  const limit = D.codeSearchPerRun ?? 10;
  const codeFound = new Map();
  let used = 0;
  outer: for (const q of D.codeQueries) {
    let kept = 0;
    for (let page = 1; page <= codePages; page++) {
      if (used >= limit) break outer;
      const r = await gh.search(`/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      if (r.status === 403 || r.status === 429) {
        console.log(`  · code  ${q}  → 限流，跳过（第 ${page} 页）`);
        continue outer;
      }
      used++;
      const items = r.data?.items || [];
      if (!items.length) break;
      for (const it of items) {
        const repo = it.repository;
        if (!repo || repo.fork || repo.archived) continue;
        const key = repo.full_name.toLowerCase();
        if (inWatchlist.has(key)) continue;
        if (!codeFound.has(key)) codeFound.set(key, { key: repo.full_name, desc: repo.description || '' });
        kept++;
      }
    }
    console.log(`  · code  ${q}  → 收 ${kept}`);
  }

  // 补查星标（有上限，避免刷爆核心配额）
  const enrichLimit = D.codeEnrichLimit ?? 200;
  const toEnrich = [...codeFound.values()].slice(0, enrichLimit);
  let enriched = 0;
  for (const c of toEnrich) {
    const r = await gh.get(`/repos/${c.key}`);
    const it = r.data;
    if (!it || it.fork || it.archived) continue;
    add(c.key, { source: 'code-search', stars: it.stargazers_count, desc: it.description || c.desc || '', pushedAt: it.pushed_at });
    enriched++;
  }
  console.log(`  · code  补查星标 ${enriched}/${toEnrich.length} 个（去重后代码搜索候选 ${codeFound.size}）`);
}

/* 候选截断：**代码搜索优先**（已证明含 skill 文件），再按星标排。
   原实现纯按星标截断，会把几万星的通用 AI 仓库（AutoGPT / prompts.chat 之类，
   往往不含 SKILL.md）塞满配额，真正含 skill 的低星仓库全被挤掉。 */
const srcDist = {};
for (const c of found.values()) srcDist[c.source] = (srcDist[c.source] || 0) + 1;
console.log(`\n  去重后汇总：${JSON.stringify(srcDist)}（共 ${found.size}）`);

const SRC_RANK = { 'code-search': 0, 'repo-search': 1 };
const candidates = [...found.values()]
  .filter((c) => (c.stars || 0) >= (D.minStars ?? 150))
  .sort((a, b) => (SRC_RANK[a.source] ?? 2) - (SRC_RANK[b.source] ?? 2) || (b.stars || 0) - (a.stars || 0))
  .slice(0, D.maxNewPerRun ?? 25)
  .map((c) => ({ ...c, discoveredAt: new Date().toISOString() }));

console.log(`\n  本轮候选 ${candidates.length} 个（上限 ${D.maxNewPerRun}）`);

if (!DRY) {
  const prev = readJson(PENDING, { candidates: [] });
  const prevMap = new Map((prev.candidates || []).map((c) => [c.key.toLowerCase(), c]));
  for (const c of candidates) if (!prevMap.has(c.key.toLowerCase())) prevMap.set(c.key.toLowerCase(), c);
  const merged = [...prevMap.values()]
    .filter((c) => !inWatchlist.has(c.key.toLowerCase()))
    .filter((c) => {
      const rej = rejectedMap.get(c.key.toLowerCase());
      return !(rej && Date.now() - Date.parse(rej.rejectedAt) < retryMs);
    });
  writeJson(PENDING, { generatedAt: new Date().toISOString(), candidates: merged });
  console.log(`  → crawler/candidates/pending.json（累计待审 ${merged.length}）`);
} else {
  for (const c of candidates) console.log(`    ${c.key}  ★${c.stars}  [${c.source}]`);
  console.log('  （dry-run 未写盘）');
}
console.log(`  请求数 ${gh.requests} · 核心配额剩余 ${gh.coreRemaining ?? '?'}\n`);
