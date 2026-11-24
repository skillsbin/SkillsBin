#!/usr/bin/env node
/**
 * 发现层：GitHub Search 主动找 skill 仓库 → 待审候选队列 / 自动收录
 * ------------------------------------------------------------
 * 用法：node crawler/discover.mjs [--code] [--dry-run]
 *
 * 两种模式（由 config.discover.mode 决定）：
 *   review（默认）—— 候选写入 crawler/candidates/pending.json 待审队列，
 *                    由 open-review-pr.mjs 开审核 PR，人工 Merge 才收录。
 *   auto           —— 候选先验证是否真含 skill 文件，通过的直接并入
 *                    config.watchlist（即刻上线），不通过的记入拒收名单。
 *
 * 输出：
 *   crawler/config.json              auto 模式下会被写入 watchlist
 *   crawler/candidates/pending.json   待审候选（review 模式，派生数据）
 *   crawler/candidates/rejected.json  已拒名单（rejectRetryDays 内不再重复消耗请求）
 *
 * 纪律：review 模式下本脚本**不写** config.json.watchlist ——
 *      那是 consume-approved.mjs 的唯一职责。auto 模式下由本脚本直接写入，
 *      因为没有人工介入环节，且收录前已验证候选确实含 skill 文件。
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

/* ------------------------------------------------------------------
 * auto 模式：自动收录，不进待审队列
 * ------------------------------------------------------------------
 * 关键闸门：**必须先验证候选真的含 skill 文件**才能收录。
 *   repo-search 来源的候选是按 topic 标签搜来的，命中率并不高 ——
 *   实测 gogs/gogs（Git 服务）、dolthub/dolt（数据库）这类大项目也带
 *   topic:skills 之类的标签，但它们根本不是 skill 仓库。
 *   验证方式：拉文件树，看有没有 SKILL.md / marketplace.json /
 *   .clinerules / AGENTS.md —— 与采集器判定 skill 仓库的口径一致。
 *
 *   验证不通过的直接写入 rejected.json（rejectRetryDays 天内不再出现），
 *   避免每轮都重复消耗配额去搜同样的误匹配。
 * ------------------------------------------------------------------ */
const MODE = (D.mode || 'review');
const AUTO = MODE === 'auto';

if (AUTO) {
  const checkLimit = D.autoVerifyLimit ?? 120;
  const toCheck = candidates.slice(0, checkLimit);
  const verified = [];
  const failed = [];

  console.log(`\n  ▶ auto 模式：验证 ${toCheck.length} 个候选是否真含 skill 文件…`);

  for (const c of toCheck) {
    /* code-search 来源本身就证明了含 SKILL.md（搜索的是文件路径），不必再查 */
    if (c.source === 'code-search') { verified.push(c); continue; }
    const r = await gh.get(`/repos/${c.key}/git/trees/HEAD?recursive=1`, { allow404: true });
    const paths = (r.data && r.data.tree ? r.data.tree : [])
      .filter((e) => e.type === 'blob')
      .map((e) => e.path);
    const hit = paths.find((p) =>
      p.endsWith('SKILL.md') ||
      p.endsWith('.clinerules') ||
      /(^|\/)\.claude-plugin\/marketplace\.json$/.test(p) ||
      /(^|\/)AGENTS\.md$/.test(p)
    );
    if (hit) verified.push({ ...c, verifiedBy: hit });
    else failed.push(c);
  }

  console.log(`  验证通过 ${verified.length} 个 · 未含 skill 文件 ${failed.length} 个`);

  if (!DRY) {
    /* 通过验证的 → 并入 watchlist（这是队列的唯一写入点） */
    const cfgPath = join(ROOT, 'crawler', 'config.json');
    const cfg = readJson(cfgPath, {});
    const wl = new Set((cfg.watchlist || []).map((k) => k.toLowerCase()));
    const added = [];
    for (const c of verified) {
      const key = c.key.toLowerCase();
      if (wl.has(key)) continue;
      wl.add(key);
      added.push(c.key);
    }
    if (added.length) {
      cfg.watchlist = [...(cfg.watchlist || []), ...added];
      writeJson(cfgPath, cfg);
      console.log(`  ✅ 自动收录 ${added.length} 个 → crawler/config.json watchlist（现 ${cfg.watchlist.length} 条）`);
    } else {
      console.log('  （候选均已在 watchlist，无需改动）');
    }

    /* 验证不通过的 → 记入拒收名单，短期内不再出现 */
    if (failed.length) {
      const rej = readJson(REJECTED, { items: [] });
      const seen = new Set((rej.items || []).map((r) => String(r.key).toLowerCase()));
      const at = new Date().toISOString();
      let n = 0;
      for (const c of failed) {
        const key = c.key.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rej.items.push({ key: c.key, rejectedAt: at, reason: 'no-skill-file' });
        n++;
      }
      rej.updatedAt = at;
      writeJson(REJECTED, rej);
      console.log(`  🚫 记录拒收 ${n} 个（不含 skill 文件，${D.rejectRetryDays ?? 60} 天内不再出现）`);
    }

    /* 待审队列清空：auto 模式不再走人工审核 */
    writeJson(PENDING, { generatedAt: new Date().toISOString(), candidates: [] });
  } else {
    for (const c of verified) console.log(`    ✓ ${c.key}  ★${c.stars}  [${c.source}]${c.verifiedBy ? '  ← ' + c.verifiedBy : ''}`);
    for (const c of failed) console.log(`    ✗ ${c.key}  ★${c.stars}  [${c.source}] 无 skill 文件`);
    console.log('  （dry-run 未写盘）');
  }
} else if (!DRY) {
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
