#!/usr/bin/env node
/* ============================================================
 * SkillsBin — 候选 PR 被关闭（未合并）时记录「拒收」
 * ------------------------------------------------------------
 * 审核人在候选 PR 上点 Close 就是「不收录」这个决定的表达。
 * 本脚本把该 PR 想新增、但最终没被采纳的仓库写进
 * crawler/candidates/rejected.json，让发现层不再重复把它们丢进待审队列。
 *
 * 判断方式：对比 PR 目标分支（base）与 PR 分支（head）的 config.json
 *          watchlist 差集 —— 差集就是这份 PR 想采纳的仓库。
 *
 * 用法（CI）：
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=12 \
 *     node crawler/mark-candidates-rejected.mjs
 * 本地：
 *   node crawler/mark-candidates-rejected.mjs --ids a/b,c/d --reason manual
 * ============================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REJECTED_FILE = path.join(__dirname, 'candidates', 'rejected.json');

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || argVal('--repo') || '';
const PR = process.env.PR_NUMBER || argVal('--pr') || '';
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const MARKER = '<!-- skillsbin-crawl-candidates -->';

const log = (...a) => console.log('[reject]', ...a);
const warn = (...a) => console.warn('[reject WARN]', ...a);

async function api(endpoint) {
  const res = await fetch(endpoint.startsWith('http') ? endpoint : API + endpoint, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'skillsbin-candidate-review',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${endpoint} → ${res.status}`);
  return res.json();
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function setOutput(kv) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  return fs.appendFile(out, Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

async function main() {
  let ids = [];
  let reason = argVal('--reason') || 'review-rejected';
  let branch = '';

  const manual = argVal('--ids');
  if (manual) {
    ids = manual.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    if (!REPO || !PR) throw new Error('缺少 GITHUB_REPOSITORY / PR_NUMBER（或用 --ids 手动模式）');
    const pr = await api(`/repos/${REPO}/pulls/${PR}`);
    branch = pr.head?.ref || '';
    const body = pr.body || '';
    if (!body.includes(MARKER)) {
      log('这不是候选审核 PR（缺少标记），无需记录拒收');
      await setOutput({ changed: 'false', count: '0' });
      return;
    }
    if (pr.merged) {
      log('PR 已合并 = 采纳，不需要记录拒收');
      await setOutput({ changed: 'false', count: '0', branch });
      return;
    }
    /* 差集：PR 分支比目标分支多出来的 watchlist 条目 = 这份 PR 想采纳的仓库 */
    const headCfg = await api(`/repos/${REPO}/contents/crawler/config.json?ref=${pr.head.sha}`);
    const headList = new Set((JSON.parse(Buffer.from(headCfg.content, 'base64').toString('utf8')).watchlist || []).map((k) => k.toLowerCase()));
    const baseList = new Set((((await readJson(path.join(__dirname, 'config.json'), { watchlist: [] })).watchlist) || []).map((k) => k.toLowerCase()));
    ids = [...headList].filter((id) => !baseList.has(id));
    reason = `review-rejected (PR #${PR})`;
  }

  if (!ids.length) {
    log('没有需要记录拒收的仓库');
    await setOutput({ changed: 'false', count: '0', branch });
    return;
  }

  const state = await readJson(REJECTED_FILE, { items: [] });
  state.items = state.items || [];
  const seen = new Set(state.items.map((r) => String(r.key).toLowerCase()));
  const at = new Date().toISOString();
  let added = 0;
  for (const id of ids) {
    if (seen.has(id.toLowerCase())) continue;
    state.items.push({ key: id, rejectedAt: at, reason });
    seen.add(id.toLowerCase());
    added++;
  }
  state.updatedAt = at;
  await fs.writeFile(REJECTED_FILE, JSON.stringify(state, null, 2) + '\n');

  log(`记录拒收 ${added} 个（本次涉及 ${ids.length} 个）：${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ' …' : ''}`);
  warn(`这些仓库在 rejectRetryDays 内不会再次进入待审队列：${ids.length} 个`);
  await setOutput({ changed: added ? 'true' : 'false', count: String(added), branch });
}

main().catch((e) => { console.error('[reject FATAL]', e); process.exit(1); });
