#!/usr/bin/env node
/**
 * 中文摘要覆盖层套用
 * ------------------------------------------------------------
 * 背景：descZh 是「本站撰写的中文简介」。采集器每轮重建 data/skills/<id>.json，
 *  **skill 级 descZh 会被重置为空**（仓库级 descZh 由 crawl 从旧索引继承）。
 *  因此中文摘要不能只写进 data/，必须有一份独立的来源文件，每轮采集后重新套用。
 *
 * 唯一来源：data/desczh.json
 *   {
 *     "repos":  { "owner/repo": "中文简介" },
 *     "skills": { "owner/repo/skill-slug": "中文简介" }
 *   }
 *
 * 用法：node scripts/apply-desczh.mjs [--dry-run]
 * 幂等：重复执行结果一致；键不存在（仓库/ skill 已下线）只告警不报错。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');

const OVERLAY = join(ROOT, 'data/desczh.json');
const INDEX = join(ROOT, 'data/skills.index.json');
const DETAIL_DIR = join(ROOT, 'data/skills');

if (!existsSync(OVERLAY)) {
  console.log('· 无 data/desczh.json，跳过');
  process.exit(0);
}

const overlay = JSON.parse(readFileSync(OVERLAY, 'utf8'));
const repoZh = overlay.repos || {};
const skillZh = overlay.skills || {};

/* ---------- 1. 仓库级：写进索引（索引是页面与 data.js 的数据源） ---------- */
const index = JSON.parse(readFileSync(INDEX, 'utf8'));
let repoHit = 0;
for (const item of index.items || []) {
  const zh = repoZh[`${item.owner}/${item.repo}`];
  if (zh && item.descZh !== zh) {
    item.descZh = zh;
    repoHit++;
  }
}

/* ---------- 2. skill 级：写进明细文件 ---------- */
const skillKey = (ownerRepo, slug) => `${ownerRepo}/${slug}`;
const usedSkillKeys = new Set();
let skillHit = 0;
const files = existsSync(DETAIL_DIR) ? readdirSync(DETAIL_DIR).filter((f) => f.endsWith('.json')) : [];
for (const f of files) {
  const p = join(DETAIL_DIR, f);
  const det = JSON.parse(readFileSync(p, 'utf8'));
  const ownerRepo = det.repo; // "owner/repo"
  let touched = false;
  for (const s of det.skills || []) {
    const key = skillKey(ownerRepo, s.slug);
    const zh = skillZh[key];
    if (!zh) continue;
    usedSkillKeys.add(key);
    if (s.descZh !== zh) {
      s.descZh = zh;
      touched = true;
      skillHit++;
    }
  }
  if (touched && !DRY) writeFileSync(p, JSON.stringify(det, null, 2) + '\n');
}

/* ---------- 3. 失效键告警（仓库/ skill 已不在数据里 → 覆盖层该清理） ---------- */
const indexRepoKeys = new Set((index.items || []).map((i) => `${i.owner}/${i.repo}`));
const staleRepos = Object.keys(repoZh).filter((k) => !indexRepoKeys.has(k));
const staleSkills = Object.keys(skillZh).filter((k) => !usedSkillKeys.has(k));

console.log(`· 仓库摘要 ${Object.keys(repoZh).length} 条 → 命中 ${repoHit}（索引共 ${index.items.length} 个仓库）`);
console.log(`· skill 摘要 ${Object.keys(skillZh).length} 条 → 命中 ${skillHit}（明细 ${files.length} 个文件）`);
if (staleRepos.length) console.log(`⚠ 覆盖层里有 ${staleRepos.length} 个仓库键在数据中找不到：${staleRepos.slice(0, 5).join(', ')}${staleRepos.length > 5 ? ' …' : ''}`);
if (staleSkills.length) console.log(`⚠ 覆盖层里有 ${staleSkills.length} 个 skill 键在数据中找不到：${staleSkills.slice(0, 5).join(', ')}${staleSkills.length > 5 ? ' …' : ''}`);

if (DRY) {
  console.log('（dry-run 未写盘）');
} else {
  writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
  console.log('✅ 已套用');
}
