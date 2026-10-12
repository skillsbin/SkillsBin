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

/* S5 仓库搜索（30 次/分钟） */
for (const q of D.queries || []) {
  const query = q
    .replace('{minStars}', String(D.minStars ?? 150))
    .replace('{daysAgo}', new Date(Date.now() - (D.daysAgo ?? 60) * 86400000).toISOString().slice(0, 10));
  const r = await gh.search(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=50`);
  const items = r.data?.items || [];
  let kept = 0;
  for (const it of items) {
    if (it.fork || it.archived) continue;
    if ((it.stargazers_count || 0) < (D.minStars ?? 150)) continue;
    add(it.full_name, { source: 'repo-search', stars: it.stargazers_count, desc: it.description || '', pushedAt: it.pushed_at });
    kept++;
  }
  console.log(`  · repo  ${query}  → ${items.length} 命中，收 ${kept}`);
}

/* S4 代码搜索（独立配额 10 次/分钟，必须带 token）—— 每轮限次 */
if (WITH_CODE && D.codeQueries?.length) {
  let used = 0;
  for (const q of D.codeQueries) {
    if (used >= (D.codeSearchPerRun ?? 10)) break;
    const r = await gh.search(`/search/code?q=${encodeURIComponent(q)}&per_page=100`);
    if (r.status === 403 || r.status === 429) {
      console.log(`  · code  ${q}  → 限流，跳过`);
      continue;
    }
    used++;
    const items = r.data?.items || [];
    let kept = 0;
    for (const it of items) {
      const repo = it.repository;
      if (!repo || repo.fork || repo.archived) continue;
      add(repo.full_name, { source: 'code-search', stars: repo.stargazers_count, desc: repo.description || '', pushedAt: repo.pushed_at });
      kept++;
    }
    console.log(`  · code  ${q}  → ${r.data?.total_count ?? '?'} 命中，收 ${kept}`);
  }
}

/* 候选按星标排序，单轮上限 */
const candidates = [...found.values()]
  .filter((c) => (c.stars || 0) >= (D.minStars ?? 150))
  .sort((a, b) => (b.stars || 0) - (a.stars || 0))
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
