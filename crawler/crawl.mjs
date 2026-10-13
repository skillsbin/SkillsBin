#!/usr/bin/env node
/**
 * SkillsBin 采集主入口
 * ------------------------------------------------------------
 * 用法：
 *   node crawler/crawl.mjs [--dry-run] [--limit 50] [--only owner/repo] [--no-discover] [--force]
 *
 * 数据源（开发文档 §6.1）：
 *   S1 GET /repos/:o/:r                        仓库元数据           1 次 core
 *   S2 GET /git/trees/:branch?recursive=1      文件树（定位 SKILL.md） 1 次 core
 *   S3 raw.githubusercontent.com               取正文与 frontmatter  0（不计配额）
 *   S4 GET /git/ref/heads/:branch              锁 commit（仅有 skill 时）1 次 core
 *
 * 写入（唯一性约束，开发文档 §6.5）：
 *   data/skills.index.json      元数据层（首屏）
 *   data/skills/<id>.json       明细层（懒加载）
 *   data/sync-state.json        断点与统计
 *   data/stats.json             聚合统计
 *   ⚠️ crawler/config.json.watchlist 不由本脚本写 —— 只有 consume-approved.mjs 能写
 */
import { join } from 'node:path';
import { readdirSync, unlinkSync } from 'node:fs';
import { ROOT, loadEnv, readJson, writeJson, idOf, watchKey, inferHosts, inferCategory, normLicense } from './lib.mjs';
import { GhClient, ContentFetcher, mapPool } from './github.mjs';
import { normalizeSkill, isSkillPath, splitFrontmatter } from './parse-skill.mjs';
import { computeQuality } from './score.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = flag('--dry-run');
const FORCE = flag('--force');
const NO_DISCOVER = flag('--no-discover');
const LIMIT = Number(val('--limit', 0)) || 0;
const ONLY = val('--only');
const MAX_WAIT = Number(val('--max-wait', 0)) || 0; // 覆盖 config 的墙钟上限（本机长跑用）
const CONTENT_VIA = val('--content-via'); // raw | api，留空则自动探测
const CONCURRENCY_FLAG = Number(val('--concurrency', 0)) || 0;

const CONFIG = readJson(join(ROOT, 'crawler', 'config.json'), {});
/** 校验口径单点来自 config.review —— 与 add-repo.mjs / review-submission.mjs 共用 */
const DESC_LIMITS = {
  descMinLen: CONFIG.review?.descMinLen ?? 20,
  descMaxLen: CONFIG.review?.descMaxLen ?? 1024,
  nameMaxLen: CONFIG.review?.nameMaxLen ?? 64,
};
const ENV = loadEnv();
const TOKEN = process.env.GITHUB_TOKEN || ENV.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('✖ 缺少 GITHUB_TOKEN（.deploy.env 里没填，或环境变量未导出）');
  process.exit(1);
}

const gh = new GhClient({ token: TOKEN, ...CONFIG.limits, log: () => {} });
if (MAX_WAIT) gh.setMaxWait(MAX_WAIT);
const CONCURRENCY = CONCURRENCY_FLAG || CONFIG.limits?.concurrency || 5;
const fetcher = new ContentFetcher({
  gh,
  token: TOKEN,
  rawTimeoutMs: CONFIG.limits?.rawTimeoutMs ?? 8000,
  failThreshold: CONFIG.limits?.rawFailThreshold ?? 3,
  log: (m) => console.log(m),
});
if (CONTENT_VIA) fetcher.force(CONTENT_VIA);
const now = Date.now();
const startedAtISO = new Date(now).toISOString();

const INDEX_PATH = join(ROOT, 'data', 'skills.index.json');
const DETAIL_DIR = join(ROOT, 'data', 'skills');
const STATE_PATH = join(ROOT, 'data', 'sync-state.json');
const STATS_PATH = join(ROOT, 'data', 'stats.json');

const state = readJson(STATE_PATH, { cursor: 0, lastRunAt: null, quota: {}, perRepo: {}, stats: {} });
const index = readJson(INDEX_PATH, { generatedAt: null, count: 0, items: [] });
const byId = new Map((index.items || []).map((it) => [it.id, it]));

const stats = { ok: 0, skipFresh: 0, parseFail: 0, parsedOk: 0, noSkill: 0, missing: 0, err: 0, requests: 0 };
const failReasons = {};

/* ------------------------------- 待采队列 ------------------------------- */
let queue = [];
if (ONLY) {
  queue = [{ key: ONLY, owner: ONLY.split('/')[0], repo: ONLY.split('/')[1] }];
} else {
  const wl = CONFIG.watchlist || [];
  const start = Number.isFinite(state.cursor) && state.cursor < wl.length ? state.cursor : 0;
  const rotated = wl.slice(start).concat(wl.slice(0, start));
  queue = rotated.map((k) => ({ key: k, owner: k.split('/')[0], repo: k.split('/')[1] }));
  if (LIMIT) queue = queue.slice(0, LIMIT);
}

console.log(`\n▶ SkillsBin 采集：队列 ${queue.length} 个仓库${DRY ? '（dry-run，不写盘）' : ''}`);
if (!queue.length) {
  console.log('  队列为空 —— 先跑 node crawler/discover.mjs 找候选，或用 scripts/add-repo.mjs 收录。\n');
  process.exit(0);
}

const refreshMs = (CONFIG.limits?.refreshHours ?? 20) * 3600 * 1000;

/* ------------------------------- 主循环 ------------------------------- */
for (let i = 0; i < queue.length; i++) {
  const stop = gh.stopReason();
  if (stop) {
    console.log(`\n⏸ 主动刹车：${stop} —— 落盘退出（exit 0），下轮从断点继续`);
    if (!ONLY) state.cursor = (Number.isFinite(state.cursor) ? state.cursor : 0) + i;
    break;
  }

  const { key, owner, repo } = queue[i];
  const rid = idOf(owner, repo);
  const prev = state.perRepo?.[key];
  const fresh =
    prev?.verifiedAt && now - Date.parse(prev.verifiedAt) < refreshMs && !FORCE && !ONLY;

  if (fresh) {
    stats.skipFresh++;
    continue;
  }

  process.stdout.write(`  [${i + 1}/${queue.length}] ${key} … `);

  const r1 = await gh.get(`/repos/${owner}/${repo}`, { allow404: true });
  if (r1.status === 404) {
    console.log('404 不存在/已私有 → 跳过');
    stats.missing++;
    continue;
  }
  if (!r1.data) {
    console.log(`失败 (${r1.error || r1.status})`);
    stats.err++;
    continue;
  }
  const meta = r1.data;
  const branch = meta.default_branch || 'main';

  // 文件树用更长的超时：大仓库（如 35k 条 ≈ 9 MB）按默认 20s 会被截断，导致误判「无 SKILL.md」
  const r2 = await gh.get(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
    timeoutMs: CONFIG.limits?.treeTimeoutMs ?? 60000,
  });
  // 关键区分：请求失败 ≠ 仓库没有 SKILL.md。前者不写 perRepo，下轮还会重试；
  // 后者才缓存成 skillCount=0，避免把网络抖动固化成「此仓无 skill」的错误结论。
  if (!r2.data || !Array.isArray(r2.data.tree)) {
    console.log(`失败 (文件树 ${r2.error || r2.status}) → 不缓存，下轮重试`);
    stats.err++;
    continue;
  }
  const tree = (r2.data.tree || []).filter((n) => n.type === 'blob');
  const paths = tree.map((n) => n.path);
  const truncated = !!r2.data?.truncated;

  const skillPaths = paths.filter(isSkillPath).slice(0, CONFIG.limits?.maxSkillsPerRepo ?? 50);
  const hasMarketplace = paths.some((p) => /^\.claude-plugin\/marketplace\.json$/i.test(p));
  const hasReadme = paths.some((p) => /^README(\.md|\.rst)?$/i.test(p));

  if (!skillPaths.length) {
    console.log(`无 SKILL.md（文件树 ${paths.length} 项${truncated ? '，已截断' : ''}）`);
    stats.noSkill++;
    state.perRepo[key] = { verifiedAt: new Date().toISOString(), commit: null, skillCount: 0 };
    continue;
  }

  // 锁 commit：仅当确实有 skill 时才多花这 1 次请求，保证 raw 外链与页面展示一致
  let commit = null;
  const r3 = await gh.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  commit = r3.data?.object?.sha || null;

  const hosts = inferHosts(paths, meta, CONFIG.hostRules || {});
  const ref = commit || branch;

  // 有界并发取正文：raw 走 CDN 可放心并发；Contents API 由 GhClient 统一节流与配额记账
  const fetched = await mapPool(skillPaths, CONCURRENCY, async (p) => {
    const r = await fetcher.fetch(owner, repo, ref, p);
    if (!r.ok) return { ok: false, path: p, reason: `fetch:${r.status || r.error}` };
    const res = normalizeSkill({ owner, repo, path: p, text: r.text, hosts, limits: DESC_LIMITS });
    if (!res.ok) return { ok: false, path: p, reason: res.error };
    return { ok: true, path: p, via: r.via, skill: res.skill, text: r.text };
  });

  const skills = [];
  let fail = 0;
  // 按内容去重：同一个 SKILL.md 常被整份复制进 experiments/、examples/、各版本快照目录，
  // 采集器会把它们当成 N 个不同 skill —— 既灌水页面，又白占 maxSkillsPerRepo 名额
  //（adrianco/retort 页面上的 50 个「beads」、mem0ai/mem0 的 6 个同句 skill 都是这么来的）。
  // 同内容只保留**路径最浅**的那份作正主（最可能是原件，而不是某次实验跑出来的副本），
  // 这样安装命令里的目录也指向更有意义的位置。
  const depthOf = (p) => (p.match(/\//g) || []).length;
  const byHash = new Map();
  for (const f of fetched) {
    if (!f.ok) continue;
    const prev = byHash.get(f.skill.contentHash);
    if (!prev) {
      byHash.set(f.skill.contentHash, f);
    } else if (depthOf(f.path) < depthOf(prev.path) || (depthOf(f.path) === depthOf(prev.path) && f.path.length < prev.path.length)) {
      byHash.set(f.skill.contentHash, f);
    }
  }
  const canonical = new Set(byHash.values());

  /* 近似去重（第二层）：一个 skill 常为不同宿主/发布通道各存一份 —— `.agents/` 与
     `.cursor/`、`integrations/*-plugin/`、`.kimi/` 与 `.qwen/`，以及 `skills/x` 与
     `public/.well-known/agent-skills/x` —— 正文只差几行 frontmatter 或宿主配置，
     contentHash 不同，精确去重抓不到，页面就出现 `bun-runtime` 与 `bun-runtime-2`
     两份几乎逐字相同的条目（koala73/worldmonitor 48 条里 17 条是这种）。
     判据（同基础 slug 分组内，组内先按路径深浅排序，最浅者为「正主」）：
       A. 家族式：组内**其余成员与最浅者**的正文行集合 Jaccard 全部 ≥ 0.70 → 只留最浅者。
          专收 `integrations/*-plugin/skills/pause` 这类「一份逻辑 skill、N 个宿主各存一份」
          （实测 0.73 ~ 0.87）。
       B. 否则退化为两两比较：Jaccard ≥ 0.85 → 丢其中较深的那份。
     刻意不把 A 的门槛继续下调：**语言版本必须保住**。`translations/de|ar|cs|bg/…` 与原文
     实测只有 0.12 ~ 0.18，连「正文几乎全是代码、几乎没有散文」的希腊语版本也只有 0.72
     —— 只要组里混入任意一门真翻译，A 条的条件就会失败并自动退回更保守的 B 条。 */
  const NEAR_DUP_FAMILY = 0.7;
  const NEAR_DUP_PAIR = 0.85;
  const lineSet = (t) => new Set(String(t || '').split('\n').map((x) => x.trim()).filter((x) => x.length > 4));
  const jaccard = (a, b) => {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / (a.size + b.size - n || 1);
  };
  const byBase = new Map();
  for (const f of canonical) {
    const k = String(f.skill.slug || '').toLowerCase();
    if (!byBase.has(k)) byBase.set(k, []);
    byBase.get(k).push(f);
  }
  const nearDrop = new Set();
  for (const arr of byBase.values()) {
    if (arr.length < 2) continue;
    const sorted = arr
      .slice()
      .sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.length - b.path.length);
    const sets = sorted.map((f) => lineSet(splitFrontmatter(f.text).body));
    if (sets.slice(1).every((s) => jaccard(sets[0], s) >= NEAR_DUP_FAMILY)) {
      for (let k = 1; k < sorted.length; k++) nearDrop.add(sorted[k]);
      continue;
    }
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (nearDrop.has(sorted[i]) || nearDrop.has(sorted[j])) continue;
        if (jaccard(sets[i], sets[j]) < NEAR_DUP_PAIR) continue;
        nearDrop.add(sorted[j]); // sorted 已按深浅升序，j 恒为更深的一份
      }
    }
  }
  for (const d of nearDrop) canonical.delete(d);
  let dupDropped = nearDrop.size;
  const seenSlugs = new Set(); // 同仓库可能出现重名目录（如 .claude/skills/x 与 harness/x），URL 必须唯一
  for (const f of fetched) {
    if (!f.ok) {
      fail++;
      const rk = f.reason.split(':')[0];
      failReasons[rk] = (failReasons[rk] || 0) + 1;
      continue;
    }
    if (!canonical.has(f)) {
      dupDropped++;
      continue;
    }
    const s = f.skill;
    let slug = s.slug;
    for (let n = 2; seenSlugs.has(slug); n++) slug = `${s.slug}-${n}`;
    seenSlugs.add(slug);
    s.slug = slug;
    const license = normLicense(meta.license?.spdx_id) || s.license || '';
    s.license = license;
    s.repoLicense = normLicense(meta.license?.spdx_id);
    s.install = buildInstall({ owner, repo, commit, dir: s.dir, slug: s.slug, path: f.path, hasMarketplace });
    s.bodyInline = (CONFIG.allowedInlineLicenses || []).includes(license);
    s.excerpt = '';
    s.commit = commit;
    s.branch = branch;
    // 正文留档：仅用于「许可白名单内」的站内渲染与「复制 SKILL.md」。
    // 单条上限 24 KB，防止个别巨型 SKILL.md 把明细层撑爆（单文件目标 ≤ 60 KB）。
    // 正文留档，两个用途分开：
    //   s.body   = 完整原文（含 frontmatter）—— 给「复制 SKILL.md」，必须逐字节一致
    //   s.bodyMd = 去掉 frontmatter 的正文 —— 给站内渲染，YAML 头不该出现在页面上
    // 各自上限 24 KB，防个别巨型文件把明细层撑爆。
    const raw1 = f.text.length > 24000 ? f.text.slice(0, 24000) : f.text;
    const bodyOnly = splitFrontmatter(f.text).body;
    s.body = raw1;
    s.bodyMd = bodyOnly.length > 24000 ? bodyOnly.slice(0, 24000) : bodyOnly;
    skills.push(s);
    stats.parsedOk++;
  }

  stats.parseFail += fail;
  if (dupDropped) {
    stats.dupDropped = (stats.dupDropped || 0) + dupDropped;
    console.log(`去重：丢弃 ${dupDropped} 份重复 SKILL.md（其中 ${nearDrop.size} 份为多宿主近似副本，保留路径最浅的那份）`);
  }

  // 一个 skill 都没解析出来时，两种成因必须分开处理 —— 合在一起会把好仓库误删：
  //   a) 正文压根没取到（网络 / 配额）→ 不能据此判定仓库失效，保留索引里的旧记录，下轮重试
  //   b) 正文取到了但全部解析失败（典型：frontmatter 只有嵌套的 description、没有顶层 description）
  //      → 这种仓库页是空壳，留在索引里就是幽灵页面，与「无 SKILL.md」同等处理，摘出索引
  if (!skills.length) {
    const fetchFails = fetched.filter((f) => !f.ok && String(f.reason).startsWith('fetch:')).length;
    if (fetchFails) {
      console.log(`0 个 skill，但 ${fetchFails} 个正文获取失败 → 保留旧记录，下轮重试`);
      state.perRepo[key] = {
        verifiedAt: prev?.verifiedAt || null,
        commit: prev?.commit || null,
        skillCount: prev?.skillCount || 0,
      };
      continue;
    }
    stats.noSkill++;
    byId.delete(rid);
    // 状态仍记 verifiedAt：否则每轮都会重采这个注定失败的仓库，白白消耗配额
    state.perRepo[key] = { verifiedAt: new Date().toISOString(), commit, skillCount: 0 };
    console.log(`0 个 skill（${fail} 个解析失败）→ 移出索引`);
    continue;
  }

  const official = (CONFIG.officialOrgs || []).some((o) => o.toLowerCase() === owner.toLowerCase());
  const quality = computeQuality({
    stars: meta.stargazers_count,
    pushedAt: meta.pushed_at,
    skills,
    hasReadme,
    official,
    weights: CONFIG.scoreWeights,
    tiers: CONFIG.tiers,
    now,
  });
  const category = inferCategory(meta, skills, CONFIG.categoryRules || {}, CONFIG.categoryWeights || {});

  const item = {
    id: rid,
    owner: meta.owner?.login || owner,
    repo: meta.name || repo,
    desc: meta.description || '',
    descZh: byId.get(rid)?.descZh || '',
    stars: meta.stargazers_count || 0,
    forks: meta.forks_count || 0,
    pushedAt: meta.pushed_at || null,
    license: normLicense(meta.license?.spdx_id),
    topics: meta.topics || [],
    category,
    official,
    hosts,
    skillCount: skills.length,
    quality,
    verifiedAt: new Date().toISOString(),
  };

  byId.set(rid, item);
  state.perRepo[key] = { verifiedAt: item.verifiedAt, commit, skillCount: skills.length };

  if (!DRY) {
    writeJson(join(DETAIL_DIR, `${rid}.json`), {
      repo: `${meta.owner?.login || owner}/${meta.name || repo}`,
      commit,
      branch,
      fetchedAt: item.verifiedAt,
      parseFail: fail,
      skills,
    });
  }

  stats.ok++;
  console.log(`${skills.length} 个 skill${fail ? `（${fail} 个解析失败）` : ''} · ${quality.tier} ${quality.score} · ${category}`);
}

/* ------------------------------- 落盘 ------------------------------- */
stats.requests = gh.requests;

if (!DRY) {
  // 索引里不允许出现 0 skill 的仓库：空壳仓库页对用户没有价值，对 SEO 是薄内容。
  // 主循环已把「本轮采到 0 个」的摘出 byId，这里再兜住历史遗留与半途中止留下的记录。
  const items = [...byId.values()]
    .filter((x) => x.skillCount > 0)
    .sort((a, b) => b.quality.score - a.quality.score);
  // 顺带清掉被摘掉仓库的明细文件：预渲染只写不删，留着虽不会上站，但会让 data/ 长期堆积幽灵文件。
  // 个别受限环境会拒绝批量删除，失败不阻塞（与 build-dist.sh 的 rm -rf dist 同一处理）。
  const alive = new Set(items.map((x) => x.id));
  for (const f of readdirSync(DETAIL_DIR)) {
    if (f.endsWith('.json') && !alive.has(f.replace(/\.json$/, ''))) {
      try {
        unlinkSync(join(DETAIL_DIR, f));
        console.log(`清理明细：${f}（该仓库已不在索引中）`);
      } catch {
        console.log(`⚠ 未能删除明细 ${f}（环境限制），跳过`);
      }
    }
  }
  writeJson(INDEX_PATH, {
    generatedAt: new Date().toISOString(),
    count: items.length,
    skillTotal: items.reduce((a, x) => a + x.skillCount, 0),
    items,
  });

  writeJson(STATE_PATH, {
    ...state,
    lastRunAt: startedAtISO,
    quota: { remaining: gh.coreRemaining, limit: gh.coreLimit, resetAt: gh.resetAt },
    stats,
  });

  const prevStats = readJson(STATS_PATH, {});
  writeJson(STATS_PATH, {
    updatedAt: new Date().toISOString(),
    repositories: items.length,
    skills: items.reduce((a, x) => a + x.skillCount, 0),
    byCategory: tally(items, (x) => x.category),
    byHost: tally(items.flatMap((x) => x.hosts.map((h) => ({ h }))), (x) => x.h),
    byTier: tally(items, (x) => x.quality.tier),
    // ⚠️ 分母必须是「本轮解析的文件数」而不是「本轮更新的仓库数」——
    //    前者是文件级，后者是仓库级，混算会把 2% 的真实失败率放大成 34%。
    parseFailRate: stats.parsedOk + stats.parseFail ? +(stats.parseFail / (stats.parsedOk + stats.parseFail)).toFixed(3) : 0,
    lastRun: stats,
    history: [...(prevStats.history || []).slice(-29), { at: new Date().toISOString(), ok: stats.ok, requests: gh.requests }],
  });
}

function tally(list, pick) {
  const m = {};
  for (const x of list) {
    const k = pick(x) || '未知';
    m[k] = (m[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

function buildInstall({ owner, repo, commit, dir, slug, path, hasMarketplace }) {
  const ref = commit || 'HEAD';
  const out = {
    clone: `git clone --depth 1 https://github.com/${owner}/${repo}.git`,
    copy: dir ? `cp -r ${dir} ~/.claude/skills/${slug}` : '',
    raw: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
    saveAs: `~/.claude/skills/${slug}/SKILL.md`,
    marketplace: hasMarketplace ? `/plugin marketplace add ${owner}/${repo}` : '',
  };
  return out;
}

console.log(
  `\n✅ 完成：更新 ${stats.ok} · 跳过(新鲜) ${stats.skipFresh} · 无 skill ${stats.noSkill} · 解析失败 ${stats.parseFail}/${stats.parsedOk + stats.parseFail}（${((100 * stats.parseFail) / Math.max(1, stats.parsedOk + stats.parseFail)).toFixed(1)}%，红线 30%）· 失效 ${stats.missing} · 错误 ${stats.err}`,
);
console.log(`   正文字段来源：raw ${fetcher.via.raw} · Contents API ${fetcher.via['contents-api']}（策略 ${fetcher.strategy || '未探测'}）`);
if (Object.keys(failReasons).length) {
  console.log(`   失败原因：${Object.entries(failReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' · ')}`);
}
console.log(`   请求数 ${gh.requests}${gh.coreRemaining != null ? ` · 核心配额剩余 ${gh.coreRemaining}/${gh.coreLimit}` : ''}`);
console.log(`   索引共 ${byId.size} 个仓库${DRY ? '（dry-run 未写盘）' : ' → data/skills.index.json'}\n`);
