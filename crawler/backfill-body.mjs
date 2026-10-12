#!/usr/bin/env node
/**
 * 回填 SKILL.md 正文到明细层
 * ------------------------------------------------------------
 * 用途：明细层此前只存了 frontmatter 派生字段、没存正文时（老数据），
 *       或者正文抓取失败需要补抓时使用。
 *
 * 为什么不直接重跑 crawl.mjs：正文走 raw.githubusercontent.com，**不计 API 配额**，
 * 所以回填可以并发拉取，1~2 分钟完成，而全量重采要重新消耗 core 配额并耗时十倍以上。
 *
 * 用法：node crawler/backfill-body.mjs [--concurrency 6] [--dry-run]
 */
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { ROOT, readJson, writeJson } from './lib.mjs';
import { fetchRaw } from './github.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ci = args.indexOf('--concurrency');
const CONC = ci >= 0 ? Number(args[ci + 1]) : 6;

const DETAIL_DIR = join(ROOT, 'data', 'skills');
const files = existsSync(DETAIL_DIR) ? readdirSync(DETAIL_DIR).filter((f) => f.endsWith('.json')) : [];
if (!files.length) {
  console.log('data/skills/ 为空，无需回填。');
  process.exit(0);
}

let filled = 0;
let skipped = 0;
let failed = 0;
let bytes = 0;

const queue = [];
for (const f of files) {
  const d = readJson(join(DETAIL_DIR, f), null);
  if (!d?.skills?.length) continue;
  for (const s of d.skills) {
    if (s.body) {
      skipped++;
      continue;
    }
    queue.push({ file: f, detail: d, skill: s });
  }
}

console.log(`\n▶ 回填正文：待补 ${queue.length} · 已有 ${skipped} 条 · 文件 ${files.length} 个`);

async function worker(list) {
  for (const job of list) {
    const { detail, skill } = job;
    const ref = skill.commit || detail.commit || detail.branch || 'main';
    const r = await fetchRaw(detail.repo.split('/')[0], detail.repo.split('/')[1], ref, skill.path);
    if (!r.ok || !r.text) {
      failed++;
      continue;
    }
    skill.body = r.text.length > 24000 ? r.text.slice(0, 24000) : r.text;
    filled++;
    bytes += Buffer.byteLength(skill.body, 'utf8');
  }
}

const shards = Array.from({ length: CONC }, () => []);
queue.forEach((q, i) => shards[i % CONC].push(q));
await Promise.all(shards.map(worker));

if (!DRY && filled) {
  const touched = new Map();
  for (const job of queue) if (job.skill.body) touched.set(job.file, job.detail);
  for (const [f, d] of touched) writeJson(join(DETAIL_DIR, f), d);
}

console.log(`   补入 ${filled} 条（${(bytes / 1024).toFixed(0)} KB）· 失败 ${failed} · 跳过 ${skipped}${DRY ? '（dry-run 未写盘）' : ''}\n`);
