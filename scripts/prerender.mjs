#!/usr/bin/env node
/**
 * 预渲染：data/ → dist/**（真 HTML，不执行 JS 的采集器也能读到正文）
 * ------------------------------------------------------------
 * 生成：
 *   dist/index.html                              首页
 *   dist/skills/index.html + page/N              全量列表（路径式分页）
 *   dist/skills/<owner>/<repo>/index.html        仓库页
 *   dist/skills/<owner>/<repo>/<slug>/index.html skill 详情页（最重要）
 *   dist/c/<slug>/   dist/h/<slug>/   dist/tags/<tag>/
 *   dist/search/  dist/submit/  dist/about/  dist/404.html
 *   dist/llms.txt  llms-full.txt  sitemap*.xml  robots.txt  _headers
 *   dist/assets/js/data.js                       客户端索引（筛选/搜索用）
 *
 * 硬闸门（开发文档 §3.4）：页面数 ≤ prerender.maxPages、单文件 ≤ 25 MiB
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, readJson } from '../crawler/lib.mjs';
import { esc, attr, mdToHtml, layout, skillCard, repoCard, hostChip, catChip, tierBadge, timeAgo, fmtNum, licenseLabel, isSpdxLike } from './templates.mjs';
import { CATEGORIES, CATEGORY_ORDER, HOSTS, HOST_ORDER, hostMeta, catMeta } from './taxonomy.mjs';

const CONFIG = readJson(join(ROOT, 'crawler', 'config.json'), {});
const SITE = readJson(join(ROOT, 'data', 'site.json'), null);
if (!SITE) {
  console.error('✖ 缺少 data/site.json');
  process.exit(1);
}
const PR = CONFIG.prerender || {};
const MAX_PAGES = PR.maxPages ?? 18000;
const PAGE_SIZE = 24;
const NOW = Date.now();
const ORIGIN = `https://${SITE.domain}`;
const OUT = join(ROOT, 'dist');

/* ============================ 1. 三层合并 ============================ */
/* LIVE(采集) > CURATED(人工精品，config.curated) > SEED(data/seed.json)
   字段级合并，上层非空覆盖下层；上层显式写 null 表示删除该字段。 */
const index = readJson(join(ROOT, 'data', 'skills.index.json'), { items: [] });
const CURATED = readJson(join(ROOT, 'data', 'curated.json'), {});
const SEED = readJson(join(ROOT, 'data', 'seed.json'), {});

function mergeInto(base, upper) {
  if (!upper) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(upper)) {
    if (v === null) delete out[k];
    else if (v !== '' && v !== undefined) out[k] = v;
  }
  return out;
}

const items = (index.items || []).map((it) => {
  const key = `${it.owner}/${it.repo}`.toLowerCase();
  let m = mergeInto(it, SEED[key]);
  m = mergeInto(m, CURATED[key]);
  return m;
});

/* ============================ 2. 明细与实体 ============================ */
const DETAIL_DIR = join(ROOT, 'data', 'skills');
const details = new Map();
for (const it of items) {
  const f = join(DETAIL_DIR, `${it.id}.json`);
  if (existsSync(f)) details.set(it.id, readJson(f, { skills: [] }));
}

const SEED_SKILLS = SEED['__skills__'] || {};
const CURATED_SKILLS = CURATED['__skills__'] || {};

const repos = items
  .map((it) => {
    const d = details.get(it.id) || { skills: [], commit: null };
    const skills = (d.skills || []).map((s) => {
      const sk = `${it.owner}/${it.repo}/${s.slug}`.toLowerCase();
      const merged = mergeInto(s, SEED_SKILLS[sk]);
      return mergeInto(merged, CURATED_SKILLS[sk]);
    });
    // 仓库层中文摘要：取该仓库最好的一个中文摘要，供卡片复用
    const zhFromSkill = skills.find((s) => s.descZh)?.descZh || '';
    return { ...it, descZh: it.descZh || zhFromSkill, skills, commit: d.commit || null, branch: d.branch || null, parseFail: d.parseFail || 0 };
  })
  .sort((a, b) => b.quality.score - a.quality.score || b.stars - a.stars);

const byId = new Map(repos.map((r) => [r.id, r]));

// 扁平 skill 列表
const allSkills = [];
for (const r of repos) for (const s of r.skills) allSkills.push({ repo: r, skill: s });
allSkills.sort((a, b) => b.repo.quality.score - a.repo.quality.score || b.repo.stars - a.repo.stars);

const REPO_URL = (r) => `/skills/${r.owner}/${r.repo}/`;
const SKILL_URL = (r, s) => `/skills/${r.owner}/${r.repo}/${s.slug}/`;
const hasSkillPage = (r, s) =>
  r.quality.score >= (PR.independentPageScore ?? 5.0) && (PR.requireZhSummary === false ? true : !!s.descZh);

const withPages = allSkills.filter(({ repo, skill }) => hasSkillPage(repo, skill));

/* ============================ 3. 写页面 ============================ */
const pages = [];
function writePage(urlPath, html) {
  const file = urlPath.endsWith('/') ? join(OUT, urlPath, 'index.html') : join(OUT, urlPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html, 'utf8');
  pages.push({ url: urlPath.endsWith('/') ? urlPath : urlPath, file });
}

function crumbs(list) {
  return `<nav class="breadcrumb" aria-label="面包屑">${list
    .map((c, i) =>
      i === list.length - 1
        ? `<span>${esc(c.label)}</span>`
        : `<a href="${attr(c.href)}">${esc(c.label)}</a><span class="sep">/</span>`,
    )
    .join('')}</nav>`;
}

/** 列表页筛选栏（筛选在浏览器端完成，条件写进地址栏便于分享；不影响预渲染的 SEO 正文） */
function filterSidebar() {
  return `
  <div class="filter-group"><h4>宿主</h4>
    ${HOST_ORDER.filter((h) => hostCount[h])
      .map((h) => `<label><input type="checkbox" data-f="host" value="${h}"><span>${esc(hostMeta(h).label)}</span><span style="color:var(--c-text-3);margin-left:auto">${hostCount[h]}</span></label>`)
      .join('')}
  </div>
  <div class="filter-group"><h4>用途</h4>
    ${CATEGORY_ORDER.filter((c) => catCount[c])
      .map((c) => `<label><input type="checkbox" data-f="cat" value="${esc(c)}"><span>${esc(c)}</span><span style="color:var(--c-text-3);margin-left:auto">${catCount[c]}</span></label>`)
      .join('')}
  </div>
  <div class="filter-group"><h4>依赖</h4>
    <label><input type="checkbox" data-f="nokey" value="1"><span>跳过需要 API Key 的</span></label>
    <label><input type="checkbox" data-f="nonet" value="1"><span>跳过需要联网的</span></label>
  </div>
  <div class="filter-group"><h4>星标</h4>
    ${[['0', '不限'], ['500', '≥ 500'], ['2000', '≥ 2k'], ['10000', '≥ 1万']]
      .map(([v, l], i) => `<label><input type="radio" name="stars" data-f="stars" value="${v}"${i === 0 ? ' checked' : ''}><span>${l}</span></label>`)
      .join('')}
  </div>
  <div class="filter-group"><h4>新鲜度</h4>
    ${[['0', '不限'], ['90', '3 个月内有更新'], ['365', '1 年内有更新']]
      .map(([v, l], i) => `<label><input type="radio" name="fresh" data-f="fresh" value="${v}"${i === 0 ? ' checked' : ''}><span>${l}</span></label>`)
      .join('')}
  </div>
  <button class="btn sm" id="clear-filters" type="button">清空筛选</button>`;
}

/* ---------- 3.1 首页 ---------- */
const featured = withPages.filter(({ repo }) => repo.quality.tier === 'featured').slice(0, 12);
const heroSkills = featured.length >= 6 ? featured : withPages.slice(0, 12);
const latest = [...repos].sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt)).slice(0, 8);
const catCount = tally(repos, (r) => r.category);
const hostCount = tally(repos.flatMap((r) => r.hosts.map((h) => ({ h }))), (x) => x.h);

const homeContent = `
<section class="hero">
  <div class="container">
    <h1>GitHub 上的 Agent Skill，<em>一仓收齐</em></h1>
    <p class="lead">自动聚合 GitHub 上的 Skill / Skill Pack，按宿主与用途归类，一键复制安装方式。不托管代码、不代跑 skill，只做聚合、校验与呈现。</p>
    <div class="searchbox">
      <svg class="icon" aria-hidden="true"><use href="#i-search"></use></svg>
      <input id="hero-q" type="search" placeholder="试试「PDF」「代码审查」「Claude Code」…" aria-label="搜索 skill" autocomplete="off">
    </div>
    <div class="stats-bar">
      <div><b>${fmtNum(repos.length)}</b><span>收录仓库</span></div>
      <div><b>${fmtNum(allSkills.length)}</b><span>Skill 数</span></div>
      <div><b>${fmtNum(repos.filter((r) => r.quality.tier === 'featured').length)}</b><span>精选</span></div>
      <div><b>${esc(timeAgo(index.generatedAt || new Date().toISOString(), NOW))}</b><span>最近更新</span></div>
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head"><h2>按宿主挑选</h2><a class="more" href="/h/claude-code/">全部宿主 <svg class="icon" aria-hidden="true"><use href="#i-chevron-right"></use></svg></a></div>
    <div class="chip-row">
      ${HOST_ORDER.filter((h) => hostCount[h] || h === 'generic')
        .map((h) => `<a class="chip${h === 'claude-code' ? ' solid' : ''}" href="/h/${h}/"><svg class="icon" aria-hidden="true"><use href="#${HOSTS[h].icon}"></use></svg>${esc(HOSTS[h].label)} <span style="color:var(--c-text-3)">${hostCount[h] || 0}</span></a>`)
        .join('')}
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head"><h2>按用途浏览</h2></div>
    <div class="grid cols-4">
      ${CATEGORY_ORDER.map((c) => {
        const m = catMeta(c);
        return `<a class="tile" href="/c/${m.slug}/"><span class="t-ico"><svg class="icon" aria-hidden="true"><use href="#${m.icon}"></use></svg></span><b>${esc(c)}</b><span>${catCount[c] || 0} 个仓库</span></a>`;
      }).join('')}
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head"><h2>精选 Skill</h2><a class="more" href="/skills/">全部 Skill <svg class="icon" aria-hidden="true"><use href="#i-chevron-right"></use></svg></a></div>
    <div class="grid cols-4">${heroSkills.map(({ repo, skill }) => skillCard(repo, skill)).join('')}</div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head"><h2>最新收录</h2></div>
    <div class="grid cols-4">${latest.map((r) => repoCard(r)).join('')}</div>
  </div>
</section>`;

writePage('/index.html',
  layout({
    site: SITE, title: '', base: '',
    description: `聚合 GitHub 上的 Agent Skill：收录 ${repos.length} 个仓库、${allSkills.length} 个 skill，按 Claude Code / Cursor / Cline / Codex 等宿主与八大用途归类，一键复制安装方式。`,
    canonical: `${ORIGIN}/`, content: homeContent, active: '',
    jsonld: [
      { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE.name, alternateName: SITE.nameZh, url: `${ORIGIN}/`, inLanguage: 'zh-CN', description: SITE.tagline,
        potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${ORIGIN}/search/?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } },
      { '@context': 'https://schema.org', '@type': 'Organization', name: SITE.name, url: `${ORIGIN}/`, email: SITE.mail, sameAs: [`https://github.com/${SITE.repo}`] },
    ],
  }),
);

/* ---------- 3.2 列表页（路径式分页） ---------- */
const listPages = Math.max(1, Math.ceil(repos.length / PAGE_SIZE));
for (let p = 1; p <= listPages; p++) {
  const slice = repos.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const url = p === 1 ? '/skills/' : `/skills/page/${p}/`;
  const title = p === 1 ? '全部 Skill' : `全部 Skill — 第 ${p} 页`;
  const pager = `<nav class="pager">${Array.from({ length: listPages }, (_, i) => i + 1)
    .filter((n) => n === 1 || n === listPages || Math.abs(n - p) <= 2)
    .map((n, idx, arr) => {
      const prev = arr[idx - 1];
      const gap = prev && n - prev > 1 ? '<span class="disabled">…</span>' : '';
      const href = n === 1 ? '/skills/' : `/skills/page/${n}/`;
      return `${gap}${n === p ? `<span class="cur">${n}</span>` : `<a href="${href}">${n}</a>`}`;
    })
    .join('')}</nav>`;

  writePage(url,
    layout({
      site: SITE, title, base: '', active: 'skills',
      description: `SkillsBin 收录的全部 Agent Skill 仓库（第 ${p}/${listPages} 页），共 ${repos.length} 个仓库、${allSkills.length} 个 skill，可按宿主、用途、依赖与新鲜度筛选。`,
      canonical: `${ORIGIN}${url}`,
      content: `${crumbs([{ label: '首页', href: '/' }, { label: '全部 Skill' }])}
<div class="container">
  <div class="page-head"><h1>全部 Skill</h1><p class="sub">共 ${repos.length} 个仓库 · ${allSkills.length} 个 skill。筛选与排序在浏览器端完成，条件会写进地址栏便于分享。</p></div>
  <div class="layout">
    <aside class="sidebar">${filterSidebar()}</aside>
    <div>
      <div class="toolbar">
        <span class="count" data-count>${repos.length} 个结果</span>
        <span style="flex:1"></span>
        <select id="sort" aria-label="排序">
          <option value="quality">按质量分</option>
          <option value="stars">按星标</option>
          <option value="fresh">按最近更新</option>
          <option value="skills">按 skill 数量</option>
        </select>
      </div>
      <div class="grid cols-3" id="list">${slice.map((r) => repoCard(r)).join('')}</div>
      <div id="list-pager">${pager}</div>
    </div>
  </div>
</div>`,
      jsonld: {
        '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: `${ORIGIN}${url}`,
        isPartOf: { '@type': 'WebSite', name: SITE.name, url: `${ORIGIN}/` },
        mainEntity: { '@type': 'ItemList', numberOfItems: repos.length,
          itemListElement: slice.slice(0, 20).map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: `${r.owner}/${r.repo}`, url: `${ORIGIN}${REPO_URL(r)}` })) },
      },
    }),
  );
}

/* ---------- 3.3 仓库页 ---------- */
for (const r of repos) {
  const url = REPO_URL(r);
  const zh = r.descZh || '';
  const skillList = r.skills.length
    ? `<div class="grid cols-3">${r.skills.map((s) => skillCard(r, s)).join('')}</div>`
    : `<p class="notice">该仓库的文件树里没有解析到合法的 <code>SKILL.md</code>（可能结构不符规范，或 frontmatter 缺失必填字段）。可直接访问 GitHub 查看原始仓库。</p>`;

  writePage(url,
    layout({
      site: SITE, title: `${r.owner}/${r.repo}`, base: '', active: 'skills',
      description: (zh || r.desc || `${r.owner}/${r.repo}`).slice(0, 150),
      canonical: `${ORIGIN}${url}`,
      content: `${crumbs([{ label: '首页', href: '/' }, { label: '全部 Skill', href: '/skills/' }, { label: `${r.owner}/${r.repo}` }])}
<div class="container">
  <div class="detail-hero">
    <div class="repo-hero">
      <span class="repo-avatar"><img src="https://github.com/${attr(r.owner)}.png?size=104" alt="" loading="lazy" onerror="this.remove()"><svg class="icon" aria-hidden="true" style="position:absolute"><use href="#i-hexagons"></use></svg></span>
      <div style="flex:1;min-width:260px">
        <h1>${esc(r.owner)}/${esc(r.repo)}</h1>
        <p class="lead">${esc(zh || r.desc || '（仓库未填写描述）')}${zh && r.desc ? `<span class="en">${esc(r.desc)}</span>` : ''}</p>
        <div class="tagline">
          ${tierBadge(r.quality.tier)}
          ${catChip(r.category)}
          ${r.official ? '<span class="badge ok"><svg class="icon" aria-hidden="true"><use href="#i-shield"></use></svg>官方组织</span>' : ''}
          ${r.hosts.map((h) => hostChip(h)).join('')}
          ${r.license ? `<span class="badge">${esc(r.license)}</span>` : '<span class="badge warn">许可未声明</span>'}
        </div>
        <div class="actions">
          <a class="btn primary" href="https://github.com/${attr(r.owner)}/${attr(r.repo)}" target="_blank" rel="noopener noreferrer"><svg class="icon" aria-hidden="true"><use href="#i-git-branch"></use></svg>在 GitHub 打开<svg class="icon" aria-hidden="true"><use href="#i-external"></use></svg></a>
          <button class="btn" data-copy="${attr(`git clone --depth 1 https://github.com/${r.owner}/${r.repo}.git`)}"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>复制 clone 命令</button>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <h3><svg class="icon" aria-hidden="true"><use href="#i-info"></use></svg>仓库信息</h3>
    <dl class="kv">
      <dt>含 skill</dt><dd>${r.skillCount} 个${r.parseFail ? ` · ${r.parseFail} 个 frontmatter 解析失败` : ''}</dd>
      <dt>星标 / Fork</dt><dd>${fmtNum(r.stars)} / ${fmtNum(r.forks)}</dd>
      <dt>质量分</dt><dd>${r.quality.score}（${r.quality.tier}）</dd>
      <dt>最近更新</dt><dd>${esc(timeAgo(r.pushedAt, NOW))}</dd>
      <dt>许可</dt><dd>${r.license ? esc(r.license) : '未声明 —— 使用前请自行确认'}</dd>
      ${r.commit ? `<dt>采集 commit</dt><dd class="mono">${esc(r.commit.slice(0, 12))}</dd>` : ''}
    </dl>
  </div>

  <div class="panel">
    <h3><svg class="icon" aria-hidden="true"><use href="#i-box"></use></svg>该仓库的 Skill（${r.skills.length}）</h3>
    ${skillList}
  </div>
</div>`,
      jsonld: {
        '@context': 'https://schema.org', '@type': 'SoftwareSourceCode',
        name: `${r.owner}/${r.repo}`, description: zh || r.desc || '', codeRepository: `https://github.com/${r.owner}/${r.repo}`,
        license: r.license ? `https://spdx.org/licenses/${r.license}.html` : undefined,
        author: { '@type': 'Organization', name: r.owner },
        keywords: r.topics?.join(', '),
      },
    }),
  );
}

/* ---------- 3.4 Skill 详情页（最重要的一页） ---------- */
for (const { repo: r, skill: s } of withPages) {
  const url = SKILL_URL(r, s);
  const zh = s.descZh || '';
  const summary = zh || s.desc;
  const deps = s.requires || { apiKey: false, network: false, bins: [] };
  const raw = s.install?.raw || `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${s.commit || 'HEAD'}/${s.path}`;
  const tabs = [];
  if (s.install?.copy) tabs.push({ id: 'copy', label: '目录复制', cmd: s.install.copy, hint: '把该 skill 目录放进客户端 skills 目录。不同客户端的目录可能不同，Claude Code 默认是 ~/.claude/skills/' });
  if (s.install?.marketplace) tabs.push({ id: 'market', label: '插件市场', cmd: s.install.marketplace, hint: '⚠️ 该命令形态随客户端版本变化，仅在检测到 .claude-plugin/marketplace.json 时展示；不可用时请用「目录复制」。' });
  tabs.push({ id: 'raw', label: '原始文件', cmd: raw, hint: `下载后另存为 ${s.install?.saveAs || '~/.claude/skills/' + s.slug + '/SKILL.md'}。链接锁定采集时的 commit，内容与本站展示一致。` });

  const similar = withPages
    .filter(({ repo: x, skill: y }) => x.id !== r.id && x.category === r.category && y.slug !== s.slug)
    .slice(0, 6);
  const siblings = r.skills.filter((x) => x.slug !== s.slug).slice(0, 6);

  const body = s.bodyInline
    ? `<div class="origin-bar"><svg class="icon" aria-hidden="true"><use href="#i-shield"></use></svg>来源 <strong>${esc(r.owner)}/${esc(r.repo)}</strong>@${esc((s.commit || '').slice(0, 7))} · 许可 <strong>${esc(licenseLabel(s.license || r.license) || '未声明')}</strong> · 内容未修改</div><div class="prose">${mdToHtml(s.bodyMd || s.body || '')}</div>`
    : `<p class="notice">本站未内联该 skill 的正文（许可不在允许再分发的白名单内，或作者未声明许可）。下面是本站撰写的摘要，完整内容请查看原文。</p>
       <p class="prose">${esc(summary)}</p>
       <div class="actions"><a class="btn" href="https://github.com/${attr(r.owner)}/${attr(r.repo)}/blob/${attr(s.commit || s.branch || 'HEAD')}/${attr(s.path)}" target="_blank" rel="noopener noreferrer">查看原文（GitHub）<svg class="icon" aria-hidden="true"><use href="#i-external"></use></svg></a></div>`;

  // 「复制 SKILL.md」按钮要复制**原文逐字节**，不能从渲染后的 HTML 反推 Markdown。
  // 因此把原始正文另存一份纯文本（许可白名单内才输出），由 app.js 读取。
  const mdHolder = s.bodyInline
    ? `<script type="text/plain" id="skill-md">${String(s.body || '').replace(/<\/script/gi, '<\\/script')}</script>`
    : '';

  writePage(url,
    layout({
      site: SITE, title: `${s.name}`, base: '', active: '', ogType: 'article',
      description: `${summary.slice(0, 100)} — 宿主：${r.hosts.map((h) => hostMeta(h).label).join(' / ')} · 来自 ${r.owner}/${r.repo}`.slice(0, 155),
      canonical: `${ORIGIN}${url}`,
      content: `${crumbs([{ label: '首页', href: '/' }, { label: '全部 Skill', href: '/skills/' }, { label: r.category, href: `/c/${catMeta(r.category).slug}/` }, { label: s.name }])}
<div class="container">
  <div class="detail-hero">
    <h1>${esc(s.name)} ${tierBadge(r.quality.tier)}</h1>
    <p class="lead">${esc(summary)}${zh && s.desc ? `<span class="en">原文：${esc(s.desc)}</span>` : ''}</p>
    <div class="tagline">
      ${catChip(r.category)}
      ${r.hosts.map((h) => hostChip(h)).join('')}
      ${s.version ? `<span class="badge">v${esc(s.version)}</span>` : ''}
      ${s.license || r.license ? `<span class="badge">${esc(licenseLabel(s.license || r.license))}</span>` : '<span class="badge warn">许可未声明</span>'}
      <span class="badge"><svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg>${fmtNum(r.stars)}</span>
    </div>
    <div class="actions">
      <button class="btn primary" data-copy="${attr(tabs[0].cmd)}"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>复制安装命令</button>
      <button class="btn" data-copy-raw="${attr(raw)}" data-copy-raw-inline="${s.bodyInline ? '1' : '0'}"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>复制 SKILL.md</button>
      <a class="btn ghost" href="https://github.com/${attr(r.owner)}/${attr(r.repo)}" target="_blank" rel="noopener noreferrer">在 GitHub 打开<svg class="icon" aria-hidden="true"><use href="#i-external"></use></svg></a>
    </div>
  </div>

  <div class="panel">
    <h3><svg class="icon" aria-hidden="true"><use href="#i-terminal"></use></svg>安装方式</h3>
    <div class="tabs" role="tablist">
      ${tabs.map((t, i) => `<button class="tab" role="tab" aria-selected="${i === 0}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    ${tabs.map((t, i) => `<div class="tabpanel" data-panel="${t.id}"${i === 0 ? '' : ' hidden'}>
      <div class="cmd"><code>${esc(t.cmd)}</code><button class="btn sm" data-copy="${attr(t.cmd)}"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>复制</button></div>
      <p class="hint">${esc(t.hint)}</p>
    </div>`).join('')}
    <p class="hint" style="margin-top:12px">整仓一次性获取：<code>${esc(s.install?.clone || `git clone --depth 1 https://github.com/${r.owner}/${r.repo}.git`)}</code></p>
  </div>

  <div class="panel">
    <h3><svg class="icon" aria-hidden="true"><use href="#i-key"></use></svg>依赖与权限</h3>
    <ul class="dep-list">
      <li>${deps.apiKey ? '<svg class="icon" aria-hidden="true" style="color:var(--c-amber)"><use href="#i-alert"></use></svg><span>需要 API Key —— 使用前需配置相应的密钥环境变量</span>' : '<svg class="icon" aria-hidden="true" style="color:var(--c-accent)"><use href="#i-check"></use></svg><span class="no">无需 API Key</span>'}</li>
      <li>${deps.network ? '<svg class="icon" aria-hidden="true" style="color:var(--c-amber)"><use href="#i-globe"></use></svg><span>需要联网访问外部服务</span>' : '<svg class="icon" aria-hidden="true" style="color:var(--c-accent)"><use href="#i-check"></use></svg><span class="no">无需联网</span>'}</li>
      <li>${deps.bins?.length ? `<svg class="icon" aria-hidden="true" style="color:var(--c-amber)"><use href="#i-terminal"></use></svg><span>依赖外部命令：${deps.bins.map((b) => `<code>${esc(b)}</code>`).join(' ')}</span>` : '<svg class="icon" aria-hidden="true" style="color:var(--c-accent)"><use href="#i-check"></use></svg><span class="no">无外部命令依赖</span>'}</li>
      <li><svg class="icon" aria-hidden="true"><use href="#i-shield"></use></svg><span class="no">以上为按正文与 frontmatter 自动推断的信号，仅供参考；安装前建议先阅读原文。</span></li>
    </ul>
    ${s.triggers?.length ? `<div style="margin-top:14px"><div style="font-size:12px;color:var(--c-text-3);margin-bottom:7px">触发场景</div><div class="chip-row">${s.triggers.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>` : ''}
    ${s.allowedTools?.length ? `<dl class="kv" style="margin-top:14px"><dt>allowed-tools</dt><dd>${s.allowedTools.map((t) => `<code>${esc(t)}</code>`).join(' ')}</dd></dl>` : ''}
  </div>

  <div class="panel">
    <h3><svg class="icon" aria-hidden="true"><use href="#i-book"></use></svg>${s.bodyInline ? 'SKILL.md 正文' : '摘要与原文'}</h3>
    ${body}
  </div>

  <div class="panel">
    <h3><svg class="icon" aria-hidden="true"><use href="#i-info"></use></svg>质量与来源</h3>
    <dl class="kv">
      <dt>所属仓库</dt><dd><a href="${attr(REPO_URL(r))}">${esc(r.owner)}/${esc(r.repo)}</a></dd>
      <dt>仓库星标</dt><dd>${fmtNum(r.stars)}</dd>
      <dt>最近更新</dt><dd>${esc(timeAgo(r.pushedAt, NOW))}</dd>
      <dt>采集时间</dt><dd>${esc((s.commit ? '' : '') + timeAgo(r.verifiedAt, NOW))}</dd>
      <dt>commit</dt><dd class="mono">${esc((s.commit || '').slice(0, 12) || '—')}</dd>
      <dt>内容指纹</dt><dd class="mono">${esc((s.contentHash || '').slice(0, 22))}</dd>
      <dt>文件路径</dt><dd class="mono">${esc(s.path)}</dd>
    </dl>
  </div>

  ${siblings.length ? `<div class="section"><div class="section-head"><h2>同仓库其它 Skill</h2><a class="more" href="${attr(REPO_URL(r))}">查看全部 ${r.skills.length} 个</a></div><div class="grid cols-3">${siblings.map((x) => skillCard(r, x)).join('')}</div></div>` : ''}
  ${similar.length ? `<div class="section"><div class="section-head"><h2>相似 Skill</h2><a class="more" href="/c/${catMeta(r.category).slug}/">更多「${esc(r.category)}」</a></div><div class="grid cols-3">${similar.map(({ repo: x, skill: y }) => skillCard(x, y)).join('')}</div></div>` : ''}
</div>
${mdHolder}`,
      jsonld: [
        { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: s.name, description: summary,
          applicationCategory: 'DeveloperApplication', operatingSystem: r.hosts.map((h) => hostMeta(h).label).join(', '),
          softwareVersion: s.version || undefined,
          license: isSpdxLike(s.license || r.license) ? `https://spdx.org/licenses/${s.license || r.license}.html` : undefined,
          codeRepository: `https://github.com/${r.owner}/${r.repo}`,
          isBasedOn: `https://github.com/${r.owner}/${r.repo}/blob/${s.commit || s.branch || 'HEAD'}/${s.path}`,
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' } },
        { '@context': 'https://schema.org', '@type': 'HowTo', name: `安装 ${s.name}`, totalTime: 'PT1M',
          step: tabs.map((t, i) => ({ '@type': 'HowToStep', position: i + 1, name: t.label, text: t.cmd })) },
        { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: '首页', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: '全部 Skill', item: `${ORIGIN}/skills/` },
          { '@type': 'ListItem', position: 3, name: r.category, item: `${ORIGIN}/c/${catMeta(r.category).slug}/` },
          { '@type': 'ListItem', position: 4, name: s.name, item: `${ORIGIN}${url}` },
        ] },
      ],
    }),
  );
}

/* ---------- 3.5 分类页 / 宿主页 / 标签页 ---------- */
for (const [cat, m] of Object.entries(CATEGORIES)) {
  const list = repos.filter((r) => r.category === cat);
  if (!list.length) continue;
  writePage(`/c/${m.slug}/index.html`,
    layout({
      site: SITE, title: `${cat}类 Skill`, base: '', active: 'cat',
      description: `${cat}：${m.intro.slice(0, 90)}`,
      canonical: `${ORIGIN}/c/${m.slug}/`,
      content: `${crumbs([{ label: '首页', href: '/' }, { label: cat }])}
<div class="container">
  <div class="page-head"><h1>${esc(cat)}</h1><p class="sub">${esc(m.intro)}</p></div>
  <div class="grid cols-3">${list.map((r) => repoCard(r)).join('')}</div>
</div>`,
      jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${cat}类 Skill`, url: `${ORIGIN}/c/${m.slug}/`,
        mainEntity: { '@type': 'ItemList', numberOfItems: list.length, itemListElement: list.slice(0, 20).map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: `${r.owner}/${r.repo}`, url: `${ORIGIN}${REPO_URL(r)}` })) } },
    }),
  );
}

for (const [host, m] of Object.entries(HOSTS)) {
  const list = repos.filter((r) => r.hosts.includes(host));
  if (!list.length) continue;
  writePage(`/h/${host}/index.html`,
    layout({
      site: SITE, title: `${m.label} 可用的 Skill`, base: '', active: 'host',
      description: `${m.label} 宿主：${m.intro.slice(0, 90)}`,
      canonical: `${ORIGIN}/h/${host}/`,
      content: `${crumbs([{ label: '首页', href: '/' }, { label: m.label }])}
<div class="container">
  <div class="page-head"><h1>${esc(m.label)}</h1><p class="sub">${esc(m.intro)}</p></div>
  <div class="grid cols-3">${list.map((r) => repoCard(r)).join('')}</div>
</div>`,
      jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${m.label} 可用的 Skill`, url: `${ORIGIN}/h/${host}/` },
    }),
  );
}

const tagMap = new Map();
for (const r of repos) for (const t of r.topics || []) {
  const k = t.toLowerCase();
  if (k.length < 3 || k.length > 24) continue;
  if (!tagMap.has(k)) tagMap.set(k, []);
  tagMap.get(k).push(r);
}
const topTags = [...tagMap.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 40);
for (const [tag, list] of topTags) {
  writePage(`/tags/${tag}/index.html`,
    layout({
      site: SITE, title: `标签：${tag}`, base: '', active: '',
      description: `带 ${tag} 标签的 Agent Skill 仓库，共 ${list.length} 个。`,
      canonical: `${ORIGIN}/tags/${tag}/`,
      content: `${crumbs([{ label: '首页', href: '/' }, { label: `#${tag}` }])}
<div class="container">
  <div class="page-head"><h1>#${esc(tag)}</h1><p class="sub">共 ${list.length} 个仓库带此标签。</p></div>
  <div class="grid cols-3">${list.map((r) => repoCard(r)).join('')}</div>
</div>`,
    }),
  );
}

/* ---------- 3.6 搜索页 / 提交页 / 关于页 / 404 ---------- */
writePage('/search/index.html',
  layout({
    site: SITE, title: '搜索', base: '', active: '',
    description: '搜索 SkillsBin 收录的 Agent Skill：按名称、用途、触发场景匹配。',
    canonical: `${ORIGIN}/search/`,
    content: `${crumbs([{ label: '首页', href: '/' }, { label: '搜索' }])}
<div class="container">
  <div class="page-head"><h1>搜索</h1><p class="sub">在站内 ${allSkills.length} 个 skill 里按名称、用途、触发场景匹配。搜索页不被搜索引擎收录，仅作站内工具。</p></div>
  <div class="searchbox" style="max-width:520px"><svg class="icon" aria-hidden="true"><use href="#i-search"></use></svg><input id="q-page" type="search" placeholder="输入关键词…" aria-label="搜索"></div>
  <div class="toolbar" style="margin-top:20px"><span class="count" data-count>输入关键词开始搜索</span></div>
  <div class="grid cols-3" id="list"></div>
  <div class="notice" style="margin-top:24px">没找到想要的 skill？<a href="/submit/">提交一个仓库 →</a></div>
</div>`,
    jsonld: null,
  }),
);

writePage('/submit/index.html',
  layout({
    site: SITE, title: '提交收录', base: '', active: '',
    description: '把符合规范的 Agent Skill 仓库提交到 SkillsBin。也可以通过 Pull Request 或邮件投稿。',
    canonical: `${ORIGIN}/submit/`,
    content: `${crumbs([{ label: '首页', href: '/' }, { label: '提交收录' }])}
<div class="container">
  <div class="page-head"><h1>提交收录</h1><p class="sub">SkillsBin 收录的是「符合 SKILL.md 规范、且确实能被 agent 加载」的能力包。提交即表示你确认该仓库公开可读。</p></div>
  <div class="layout">
    <aside class="sidebar">
      <div class="filter-group">
        <h4>收录标准</h4>
        <ul class="dep-list" style="font-size:13px">
          <li><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg><span>仓库公开可读</span></li>
          <li><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg><span>含至少 1 个合法 <code>SKILL.md</code></span></li>
          <li><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg><span>frontmatter 有 <code>name</code> 与 <code>description</code></span></li>
          <li><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg><span>星标 ≥ ${CONFIG.review?.minStars ?? 150}</span></li>
          <li><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg><span>最近 ${CONFIG.review?.maxInactiveMonths ?? 24} 个月内有更新</span></li>
          <li><svg class="icon" aria-hidden="true"><use href="#i-alert"></use></svg><span>不含赌博 / 色情 / 违法引导内容</span></li>
        </ul>
      </div>
      <div class="notice warn" style="font-size:12.5px">本站不托管 skill 代码，收录只是把它「编进目录」并生成一个可被搜索到的页面。</div>
    </aside>
    <div>
      <div class="panel">
        <h3><svg class="icon" aria-hidden="true"><use href="#i-git-branch"></use></svg>方式一：在 GitHub 提交（推荐）</h3>
        <p style="font-size:13.5px;color:var(--c-text-2)">会在仓库里创建 <code>submissions/&lt;owner&gt;__&lt;repo&gt;.json</code> 的 Pull Request，自动校验后由维护者合并。合并即收录，无需注册账号。</p>
        <div class="field-row" style="margin-top:14px">
          <label class="field"><span>仓库地址</span>
            <input id="sub-repo" type="text" placeholder="owner/repo 或完整 GitHub 链接" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <div class="cmd" style="margin-top:12px"><code id="sub-preview">submissions/owner__repo.json</code><button class="btn sm" id="sub-copy" data-copy="https://github.com/${attr(SITE.repo)}/new/main?filename=submissions/owner__repo.json" data-copy-label="复制提交链接"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>复制提交链接</button></div>
        <div class="actions" style="margin-top:14px">
          <a class="btn primary" id="sub-link" href="https://github.com/${attr(SITE.repo)}" target="_blank" rel="noopener noreferrer"><svg class="icon" aria-hidden="true"><use href="#i-upload"></use></svg>去 GitHub 提交</a>
        </div>
      </div>
      <div class="panel">
        <h3><svg class="icon" aria-hidden="true"><use href="#i-mail"></use></svg>方式二：邮件提交（兜底）</h3>
        <p style="font-size:13.5px;color:var(--c-text-2)">如果 GitHub 通道不可用（例如仓库暂为私有），把仓库地址直接发邮件即可，由维护者代收录。</p>
        <div class="cmd" style="margin-top:12px"><code>${esc(SITE.mail)}</code><button class="btn sm" data-copy="${attr(SITE.mail)}"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>复制邮箱</button></div>
      </div>
      <div class="panel">
        <h3><svg class="icon" aria-hidden="true"><use href="#i-alert"></use></svg>要求下架</h3>
        <p style="font-size:13.5px;color:var(--c-text-2)">若你是权利人且不希望自己的仓库被收录，邮件至 <a href="mailto:${attr(SITE.mail)}?subject=%E4%B8%8B%E6%9E%B6%E7%94%B3%E8%AF%B7">${esc(SITE.mail)}</a> 并附仓库地址，我们承诺 72 小时内移除，且加入不再收录名单。</p>
      </div>
    </div>
  </div>
</div>`,
    jsonld: null,
  }),
);

writePage('/about/index.html',
  layout({
    site: SITE, title: '关于', base: '', active: 'about',
    description: `关于 ${SITE.name}（${SITE.nameZh}）：数据来源、收录标准、更新频率、版权声明与联系方式。`,
    canonical: `${ORIGIN}/about/`,
    content: `${crumbs([{ label: '首页', href: '/' }, { label: '关于' }])}
<div class="container">
  <div class="page-head"><h1>关于 ${esc(SITE.name)}</h1><p class="sub">${esc(SITE.tagline)}</p></div>
  <div class="panel prose">
    <h3>本站做什么</h3>
    <p>SkillsBin 是一个 Agent Skill 的聚合目录。它自动扫描 GitHub 上符合 <code>SKILL.md</code> 规范的仓库，解析 frontmatter、推断宿主兼容性与用途分类、计算质量分，然后为每个仓库与每个达标的 skill 生成一个可被搜索引擎与 AI 采集器读取的静态页面。</p>
    <p><strong>不做什么：</strong>不托管 skill 代码、不代运行 skill、不提供在线执行环境；没有账号体系，因此也没有评分与评论。</p>
    <h3>数据从哪来</h3>
    <ul>
      <li><strong>自动采集</strong>：GitHub Search 与代码搜索发现仓库，再逐个读取仓库元数据与文件树定位 <code>SKILL.md</code>。正文通过 <code>raw.githubusercontent.com</code> 读取，不额外消耗 API 配额。</li>
      <li><strong>人工提交</strong>：通过 Pull Request 或邮件投稿，经校验后收录。</li>
      <li>每 12 小时同步一次，页面底部显示最近一次采集时间。</li>
    </ul>
    <h3>质量分怎么算</h3>
    <p>满分 10 分，由五项加权：星标热度（对数封顶）3.0、新鲜度（6 个月内满分，2 年内线性归零）2.5、frontmatter 完整度 2.5、skill 数量合理性 1.5、官方组织 0.5。分数 ≥ 7.5 记为精选，≥ 5.0 记为标准，低于 5.0 仅在列表中可见。</p>
    <h3>版权与许可</h3>
    <p>本站仅做数据聚合，所有 Skill 的版权与许可归原仓库作者所有。默认<strong>不内联</strong> <code>SKILL.md</code> 正文，只展示本站撰写的摘要并给出锁定 commit 的外链；仅当许可属于 MIT / Apache-2.0 / BSD / ISC / Unlicense / CC0-1.0 / 0BSD 等允许再分发的白名单时，才在页面内展示正文，并固定标注来源、许可与 commit。</p>
    <p>权利人若要求下架，请邮件至 <a href="mailto:${attr(SITE.mail)}?subject=%E4%B8%8B%E6%9E%B6%E7%94%B3%E8%AF%B7">${esc(SITE.mail)}</a>，我们承诺 72 小时内处理。</p>
    <h3>给 AI 采集器的索引</h3>
    <p>本站提供 <a href="/llms.txt">llms.txt</a>（分类目录，300 行内）与 <a href="/llms-full.txt">llms-full.txt</a>（全量清单，一行一条）两份结构化摘要。</p>
    <h3>联系</h3>
    <p>邮箱：<a href="mailto:${attr(SITE.mail)}">${esc(SITE.mail)}</a>　·　代码与数据仓库：<a href="https://github.com/${attr(SITE.repo)}" target="_blank" rel="noopener noreferrer">${esc(SITE.repo)}</a></p>
  </div>
</div>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'AboutPage', name: `关于 ${SITE.name}`, url: `${ORIGIN}/about/` },
  }),
);

writePage('/404.html',
  layout({
    site: SITE, title: '页面不存在', base: '', active: '',
    description: '页面不存在。', canonical: `${ORIGIN}/404.html`,
    content: `<div class="container"><div class="page-head" style="text-align:center;padding:80px 0">
      <h1>404</h1><p class="sub" style="margin:12px auto 0">这个页面不存在，可能 skill 已被移除或链接大小写不符。</p>
      <div class="actions" style="justify-content:center;margin-top:24px"><a class="btn primary" href="/skills/">浏览全部 Skill</a><a class="btn" href="/">回到首页</a></div>
    </div></div>`,
  }),
);

/* ============================ 4. 客户端索引与 SEO 产物 ============================ */
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).replace(/[\s,，.。]+$/, '') + '…' : t;
};
const clientIndex = {
  site: { name: SITE.name, nameZh: SITE.nameZh, domain: SITE.domain, repo: SITE.repo, mail: SITE.mail },
  generatedAt: index.generatedAt,
  counts: { repos: repos.length, skills: allSkills.length, featured: repos.filter((r) => r.quality.tier === 'featured').length },
  categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, { slug: v.slug, icon: v.icon, intro: v.intro }])),
  hosts: Object.fromEntries(Object.entries(HOSTS).map(([k, v]) => [k, { label: v.label, icon: v.icon, intro: v.intro }])),
  repos: repos.map((r) => ({
    id: r.id, o: r.owner, n: r.repo, d: clip(r.desc, 200), dz: clip(r.descZh, 200), st: r.stars, cat: r.category,
    hosts: r.hosts, sc: r.skillCount, q: r.quality.score, tier: r.quality.tier, at: r.pushedAt, u: REPO_URL(r),
    key: r.skills.some((s) => s.requires?.apiKey) ? 1 : 0,
    net: r.skills.some((s) => s.requires?.network) ? 1 : 0,
  })),
  // data.js 每个页面都会加载：长描述在这里截断（完整版在 HTML 与明细层里）。
  // 1707 条全量描述会把索引撑到 1 MB；截到 220 字符后约减半，搜索命中几乎不受影响。
  skills: allSkills.map(({ repo: r, skill: s }) => ({
    name: s.name, slug: s.slug, o: r.owner, n: r.repo, d: clip(s.desc, 220), dz: clip(s.descZh, 220),
    tg: (s.triggers || []).slice(0, 6), hosts: r.hosts, cat: r.category, u: SKILL_URL(r, s),
    q: r.quality.score, tier: r.quality.tier, st: r.stars, key: s.requires?.apiKey ? 1 : 0, net: s.requires?.network ? 1 : 0,
  })),
};
mkdirSync(join(OUT, 'assets', 'js'), { recursive: true });
writeFileSync(join(OUT, 'assets', 'js', 'data.js'), `window.__SB__=${JSON.stringify(clientIndex)};\n`, 'utf8');

/* ---------- 4.1 静态资源拷贝（assets/ → dist/assets/，data.js 由上面生成，跳过） ---------- */
const missingAssets = [];
(function copyAssets(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { copyAssets(join(dir, e.name), r); continue; }
    if (r === 'js/data.js') continue;
    const dst = join(OUT, 'assets', r);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(join(dir, e.name)));
    if (e.name === 'og.png' && statSync(join(dir, e.name)).size < 1024) missingAssets.push(`assets/${r} 体积过小，可能是占位图`);
  }
})(join(ROOT, 'assets'), '');
for (const need of ['css/style.css', 'js/app.js', 'img/favicon.svg', 'img/og.png']) {
  if (!existsSync(join(OUT, 'assets', need))) missingAssets.push(`assets/${need} 未拷贝`);
}

// llms.txt：分类目录，控制在 300 行内，每分类最多 30 条
const LL = [];
const LLMAX = PR.llmsMaxLines ?? 300;
const LLCAT = PR.llmsPerCategory ?? 30;
LL.push(`# ${SITE.name}（${SITE.nameZh}）`, '', `> ${SITE.tagline}`, `> 自动采集、校验并归类 GitHub 上的 Agent Skill（SKILL.md 规范），按用途分类与宿主兼容筛选，`, `> 提供一键复制安装方式。数据每 12 小时更新，仅做数据聚合，所有 Skill 版权归原仓库作者所有。`, '');
LL.push(`收录 ${repos.length} 个仓库 / ${allSkills.length} 个 skill。最近更新：${(index.generatedAt || '').slice(0, 10)}`, '');
LL.push('## 目录');
for (const c of CATEGORY_ORDER) if (catCount[c]) LL.push(`- ${c}：${ORIGIN}/c/${catMeta(c).slug}/ — ${catMeta(c).intro.slice(0, 42)}`);
LL.push('');
for (const c of CATEGORY_ORDER) {
  const list = withPages.filter(({ repo }) => repo.category === c).slice(0, LLCAT);
  if (!list.length) continue;
  LL.push(`## ${c}`);
  for (const { repo: r, skill: s } of list) LL.push(`- [${s.name}](${ORIGIN}${SKILL_URL(r, s)}) — ${(s.descZh || s.desc).slice(0, 80)} · host: ${r.hosts.join(', ')} · ${licenseLabel(s.license || r.license) || 'license unknown'}`);
  LL.push('');
}
LL.push('## 使用方式');
LL.push(`- 站点索引：${ORIGIN}/skills/`);
LL.push(`- 全量数据：${ORIGIN}/llms-full.txt`);
LL.push(`- 提交收录：${ORIGIN}/submit/`);
LL.push(`- 联系：${SITE.mail}`);
writeFileSync(join(OUT, 'llms.txt'), LL.slice(0, LLMAX).join('\n') + '\n', 'utf8');

writeFileSync(
  join(OUT, 'llms-full.txt'),
  [`# ${SITE.name} 全量清单（${allSkills.length} 条）`, `# 格式：skill | 仓库 | 分类 | 宿主 | 许可 | 一句话 | URL`, '',
    ...allSkills.map(({ repo: r, skill: s }) => `${s.name} | ${r.owner}/${r.repo} | ${r.category} | ${r.hosts.join(',')} | ${s.license || r.license || 'unknown'} | ${(s.descZh || s.desc).replace(/\s+/g, ' ').slice(0, 100)} | ${ORIGIN}${SKILL_URL(r, s)}`)].join('\n') + '\n',
  'utf8',
);

// sitemap 分片
const CHUNK = PR.sitemapChunkSize ?? 5000;
const coreUrls = [
  { loc: `${ORIGIN}/`, pri: '1.0' },
  { loc: `${ORIGIN}/skills/`, pri: '0.9' },
  { loc: `${ORIGIN}/about/`, pri: '0.5' },
  { loc: `${ORIGIN}/submit/`, pri: '0.4' },
  ...Object.entries(CATEGORIES).filter(([c]) => catCount[c]).map(([, m]) => ({ loc: `${ORIGIN}/c/${m.slug}/`, pri: '0.7' })),
  ...Object.entries(HOSTS).filter(([h]) => hostCount[h]).map(([h]) => ({ loc: `${ORIGIN}/h/${h}/`, pri: '0.7' })),
];
const repoUrls = repos.map((r) => ({ loc: `${ORIGIN}${REPO_URL(r)}`, pri: r.quality.tier === 'featured' ? '0.8' : '0.6' }));
const skillUrls = withPages.map(({ repo: r, skill: s }) => ({ loc: `${ORIGIN}${SKILL_URL(r, s)}`, pri: r.quality.tier === 'featured' ? '0.8' : '0.6' }));
const allUrls = [...coreUrls, ...repoUrls, ...skillUrls];

const urlset = (list) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${list.map((u) => `<url><loc>${u.loc}</loc><lastmod>${(index.generatedAt || new Date().toISOString()).slice(0, 10)}</lastmod><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>`;

const chunks = [];
chunks.push({ name: 'sitemap-core.xml', body: urlset(coreUrls) });
for (let i = 0; i < repoUrls.length; i += CHUNK) chunks.push({ name: `sitemap-repos-${i / CHUNK + 1}.xml`, body: urlset(repoUrls.slice(i, i + CHUNK)) });
for (let i = 0; i < skillUrls.length; i += CHUNK) chunks.push({ name: `sitemap-skills-${i / CHUNK + 1}.xml`, body: urlset(skillUrls.slice(i, i + CHUNK)) });
for (const c of chunks) writeFileSync(join(OUT, c.name), c.body, 'utf8');

writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${chunks.map((c) => `<sitemap><loc>${ORIGIN}/${c.name}</loc><lastmod>${(index.generatedAt || new Date().toISOString()).slice(0, 10)}</lastmod></sitemap>`).join('\n')}
</sitemapindex>
`, 'utf8');

writeFileSync(join(OUT, 'robots.txt'), `User-agent: *
Allow: /
Disallow: /search/
Disallow: /*?q=

User-agent: GPTBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Bytespider
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`, 'utf8');

// 缓存治理：
//   · HTML 不在这里设 Cache-Control —— Cloudflare Pages 默认给 HTML 的
//     就是 `public, max-age=0, must-revalidate`，符合"每次回源校验"的要求。
//     这一条必须留白：_headers 里多个规则同时匹配时，同名 header 会被**拼接**
//     （实测 `/` 拿到 "max-age=0, must-revalidate, max-age=31536000, immutable"，
//      浏览器取第一个 → assets 白拿一年缓存）。所以 `/*` 只放安全头，不碰缓存。
//   · CSS/JS 由 build-dist.sh 注入内容指纹（style.css?v=<hash>），
//     内容一变 URL 就变 → 可以放心用一年 immutable。
//   · 图片没有指纹（og.png / favicon.svg 不参与哈希注入），一年 immutable
//     会让改图后社交平台长期吃旧图，单独压到 1 天。
writeFileSync(join(OUT, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN

/assets/css/*
  Cache-Control: public, max-age=31536000, immutable

/assets/js/*
  Cache-Control: public, max-age=31536000, immutable

/assets/img/*
  Cache-Control: public, max-age=86400

/sitemap.xml
  Cache-Control: public, max-age=3600

/llms.txt
  Cache-Control: public, max-age=3600
`, 'utf8');

// 说明：曾用 _redirects 做 www 301，但 Pages 的 _redirects 只按路径匹配，
// source 带域名永不命中（实测 www 仍返回 200）。承载方式改为独立 Pages 项目
// deploy/www-redirect/（自定义域 www.skillsbin.cn，全路径 301 到主域）。
// 这里主动清掉遗留文件（CI 上是全新 checkout，本可不做；本地增量构建需要）。
// 备选：zone 级 Single Redirect Rule（http.host eq "www.skillsbin.cn"），
// 但需要 CF 令牌具备 Zone→Rulesets 权限，当前令牌没有。见 docs/上线记录.md。
try {
  if (existsSync(join(OUT, '_redirects'))) rmSync(join(OUT, '_redirects'));
} catch {
  /* 受限沙箱会拒绝删除，CI 上正常执行 */
}

/* ============================ 5. 守卫与报告 ============================ */
const files = walk(OUT);
const pageFiles = files.filter((f) => f.endsWith('.html'));
const oversize = files.map((f) => ({ f, size: statSync(f).size })).filter((x) => x.size > 25 * 1024 * 1024);

if (pageFiles.length > MAX_PAGES) {
  console.error(`✖ 页面数 ${pageFiles.length} 超过硬闸门 ${MAX_PAGES}，请收紧 skill 独立页门槛`);
  process.exit(1);
}
if (oversize.length) {
  console.error('✖ 以下文件超过 25 MiB：', oversize.map((x) => x.f).join(', '));
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
function tally(list, pick) {
  const m = {};
  for (const x of list) { const k = pick(x) || '未知'; m[k] = (m[k] || 0) + 1; }
  return m;
}

console.log(`\n✅ 预渲染完成`);
console.log(`   仓库页 ${repos.length} · skill 页 ${withPages.length}（可生成 ${allSkills.length}）· 分类页 ${Object.keys(CATEGORIES).filter((c) => catCount[c]).length} · 宿主页 ${Object.keys(HOSTS).filter((h) => hostCount[h]).length} · 标签页 ${topTags.length}`);
console.log(`   dist 页面 ${pageFiles.length} / 上限 ${MAX_PAGES} · 全部文件 ${files.length} · 体积 ${(files.reduce((a, f) => a + statSync(f).size, 0) / 1048576).toFixed(1)} MB`);
console.log(`   sitemap 分片 ${chunks.length} · llms.txt ${LL.length} 行 · 客户端索引 ${clientIndex.skills.length} skill\n`);
