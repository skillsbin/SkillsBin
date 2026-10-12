#!/usr/bin/env node
/**
 * 队列唯一写入点
 * ------------------------------------------------------------
 * 把「审核通过」的候选并入 config.json.watchlist。
 * ⚠️ 纪律（开发文档 §6.5）：watchlist **只能由本脚本写**，禁止手改、禁止其它脚本直改。
 *    任何绕过它的写入都会导致「审核通过但没上线」的幽灵问题。
 *
 * 用法：
 *   node crawler/consume-approved.mjs --all                  把 pending.json 全部并入
 *   node crawler/consume-approved.mjs owner/repo owner2/repo2 指定并入
 *   node crawler/consume-approved.mjs --dry-run --all
 *
 * 特性：
 *   · 幂等 —— 判重后才追加，同一 PR 重跑不会重复入队
 *   · 无损往返 —— JSON.stringify(o, null, 2) + '\n'，与原文逐字节相同，
 *     于是候选 PR 的 diff 只有追加的那几行，diff 本身就是「采纳」
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson, writeJson } from './lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');
const keys = args.filter((a) => !a.startsWith('--'));

const CONFIG_PATH = join(ROOT, 'crawler', 'config.json');
const PENDING = join(ROOT, 'crawler', 'candidates', 'pending.json');

const raw = readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(raw);
const existing = new Set((config.watchlist || []).map((k) => k.toLowerCase()));

let incoming = keys;
if (ALL) {
  const pending = readJson(PENDING, { candidates: [] });
  incoming = (pending.candidates || []).map((c) => c.key);
}

if (!incoming.length) {
  console.log('没有要并入的条目。用 --all 并入 pending.json，或显式给 owner/repo。');
  process.exit(0);
}

const added = [];
const skipped = [];
for (const k of incoming) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(k)) {
    skipped.push(`${k} (格式不合法)`);
    continue;
  }
  if (existing.has(k.toLowerCase())) {
    skipped.push(`${k} (已在 watchlist)`);
    continue;
  }
  existing.add(k.toLowerCase());
  added.push(k);
}

console.log(`\n▶ consume-approved：待并入 ${incoming.length} · 新增 ${added.length} · 跳过 ${skipped.length}`);
for (const k of added) console.log(`  + ${k}`);
for (const k of skipped.slice(0, 10)) console.log(`  · ${k}`);

if (!added.length) {
  console.log('无变化。\n');
  process.exit(0);
}

config.watchlist = [...(config.watchlist || []), ...added];

const out = JSON.stringify(config, null, 2) + '\n';
if (DRY) {
  console.log('\n（dry-run：未写盘，下面是与原文的差异预览）');
  console.log(out.split('\n').filter((l) => added.some((a) => l.includes(`"${a}"`))).join('\n'));
  process.exit(0);
}

writeFileSync(CONFIG_PATH, out, 'utf8');

// 已并入的从 pending 里摘掉，保持队列是「派生数据」而非人工维护
const pending = readJson(PENDING, null);
if (pending) {
  const set = new Set(added.map((k) => k.toLowerCase()));
  pending.candidates = (pending.candidates || []).filter((c) => !set.has(c.key.toLowerCase()));
  pending.updatedAt = new Date().toISOString();
  writeJson(PENDING, pending);
}

console.log(`\n✅ watchlist 现 ${config.watchlist.length} 条 → crawler/config.json\n`);
