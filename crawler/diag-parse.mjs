#!/usr/bin/env node
/**
 * 解析诊断（只读，不改数据）
 *   node crawler/diag-parse.mjs [--via api|raw] [--max-wait 15] <owner/repo> [...]
 *
 * 目的：把 normalizeSkill 的失败原因按类别聚合，并打印失败样本的头部，
 *       用来判断「该修解析器 / 放宽口径」还是「该收紧 isSkillPath 的匹配」。
 */
import { readJson } from './lib.mjs';
import { ROOT, loadEnv } from './lib.mjs';
import { join } from 'node:path';
import { GhClient, ContentFetcher } from './github.mjs';
import { normalizeSkill, isSkillPath } from './parse-skill.mjs';

const args = process.argv.slice(2);
const val = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX_WAIT = Number(val('--max-wait', 0)) || 30;
const VIA = val('--via');
const targets = args.filter((a) => !a.startsWith('--') && a.includes('/') && !a.startsWith('api') && !a.startsWith('raw'));

const CONFIG = readJson(join(ROOT, 'crawler', 'config.json'), {});
const ENV = loadEnv();
const TOKEN = process.env.GITHUB_TOKEN || ENV.GITHUB_TOKEN;
if (!TOKEN) { console.error('✖ 缺少 GITHUB_TOKEN'); process.exit(1); }

const gh = new GhClient({ token: TOKEN, ...CONFIG.limits, log: () => {} });
gh.setMaxWait(MAX_WAIT);
const fetcher = new ContentFetcher({ gh, token: TOKEN, rawTimeoutMs: CONFIG.limits?.rawTimeoutMs ?? 6000, failThreshold: CONFIG.limits?.rawFailThreshold ?? 2, log: () => {} });
if (VIA) fetcher.force(VIA);

const LIMITS = {
  descMinLen: CONFIG.review?.descMinLen ?? 20,
  descMaxLen: CONFIG.review?.descMaxLen ?? 1024,
  nameMaxLen: CONFIG.review?.nameMaxLen ?? 64,
};

if (!targets.length) { console.error('用法: node crawler/diag-parse.mjs [--via api] owner/repo [...]'); process.exit(1); }

const globalReasons = {};
for (const t of targets) {
  const [owner, repo] = t.split('/');
  console.log(`\n══ ${t} ══`);
  const r1 = await gh.get(`/repos/${owner}/${repo}`, { allow404: true });
  if (!r1.data) { console.log(`  仓库不可读（${r1.status} ${r1.error || ''}）`); continue; }
  const branch = r1.data.default_branch || 'main';
  const r2 = await gh.get(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const paths = (r2.data?.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
  const skillPaths = paths.filter(isSkillPath);
  console.log(`  文件树 ${paths.length} 项（truncated=${!!r2.data?.truncated}）· SKILL.md 命中 ${skillPaths.length}`);

  const reasons = {};
  const samples = {};
  let ok = 0;
  const cap = Math.min(skillPaths.length, 80);
  for (const p of skillPaths.slice(0, cap)) {
    const raw = await fetcher.fetch(owner, repo, branch, p);
    if (!raw.ok) {
      const k = `fetch:${raw.status || raw.error}`;
      reasons[k] = (reasons[k] || 0) + 1;
      globalReasons[k] = (globalReasons[k] || 0) + 1;
      continue;
    }
    const res = normalizeSkill({ owner, repo, path: p, text: raw.text, hosts: ['generic'], limits: LIMITS });
    if (res.ok) { ok++; continue; }
    const key = res.error.split(':')[0];
    reasons[key] = (reasons[key] || 0) + 1;
    globalReasons[key] = (globalReasons[key] || 0) + 1;
    if (!samples[key]) samples[key] = { path: p, len: String(res.error).split(':')[1] || '', head: raw.text.slice(0, 200).replace(/\n/g, '\\n') };
  }
  console.log(`  成功 ${ok} · 失败 ${cap - ok}`);
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`   · ${k} × ${v}`);
    const s = samples[k];
    if (s) console.log(`       e.g. ${s.path} ${s.len}\n            ${s.head}`);
  }
}

console.log('\n══ 全量失败原因汇总 ══');
for (const [k, v] of Object.entries(globalReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`\n请求数 ${gh.requests} · 剩余 ${gh.coreRemaining}/${gh.coreLimit} · 正文来源 ${JSON.stringify(fetcher.via)}\n`);
