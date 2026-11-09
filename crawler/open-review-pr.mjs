#!/usr/bin/env node
/* ============================================================
 * SkillsBin — 把「发现层的待审候选」整理成一个 Pull Request
 * ------------------------------------------------------------
 * 发现层（crawler/discover.mjs）主动搜索 GitHub，把命中 skill 规范的仓库
 * 写进 crawler/candidates/pending.json（待审队列），**不上线**。
 * 本脚本：
 *   1) 过滤掉已收录 / 已拒收的候选，取出真正待审的部分；
 *   2) 把它们追加进 crawler/config.json 的 watchlist —— 这一处 diff
 *      就是「采纳」这个动作本身；
 *   3) 生成带证据表（星标 / 来源 / 描述）的 PR 正文。
 * 之后由 .github/workflows/sync.yml 负责 git 提交与 PR 创建/更新。
 *
 * 审核语义：**Merge = 采纳收录**（watchlist 生效，下轮采集上线）；
 *          **Close = 拒收**（candidate-review.yml 写入 rejected.json，60 天内不再出现）。
 *
 * ⚠️ 纪律：watchlist 只能由本脚本 + consume-approved.mjs 写，
 *    禁止手改、禁止其它脚本直改（开发文档 §6.5）。
 *
 * 用法：
 *   node crawler/open-review-pr.mjs                    # 改写 config.json 并输出 PR 正文
 *   node crawler/open-review-pr.mjs --dry-run          # 只输出，不落盘
 *   node crawler/open-review-pr.mjs --body-out a.md
 * ============================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PENDING_FILE = path.join(__dirname, 'candidates', 'pending.json');
const REJECTED_FILE = path.join(__dirname, 'candidates', 'rejected.json');

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);
const DRY = has('--dry-run');

const MARKER = '<!-- skillsbin-crawl-candidates -->';
const log = (...a) => console.log('[candidates]', ...a);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function setOutput(kv) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  return fs.appendFile(out, text);
}

async function main() {
  const cfg = await readJson(CONFIG_FILE, null);
  if (!cfg) throw new Error('读不到 crawler/config.json');
  const pending = await readJson(PENDING_FILE, { candidates: [] });
  const rejected = await readJson(REJECTED_FILE, { items: [] });

  const watchlist = new Set((cfg.watchlist || []).map((k) => k.toLowerCase()));
  const rejectedIds = new Set((rejected.items || []).map((r) => String(r.key).toLowerCase()));
  const all = (pending.candidates || []).filter((c) => c && c.key);

  const fresh = all.filter((c) => !watchlist.has(c.key.toLowerCase()) && !rejectedIds.has(c.key.toLowerCase()));
  const already = all.length - fresh.length;

  log(`待审队列 ${all.length} 条 → 可提交审核 ${fresh.length} 条（已收录/已拒绝 ${already} 条）`);

  if (!fresh.length) {
    log('没有新的待审候选，跳过开 PR');
    await setOutput({ changed: 'false', count: '0' });
    return;
  }

  fresh.sort((a, b) => (b.stars || 0) - (a.stars || 0));

  /* 追加进 watchlist —— 这就是 PR 的 diff，也是「采纳」本身 */
  for (const c of fresh) cfg.watchlist.push(c.key);
  if (!DRY) await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');

  const now = new Date().toISOString().slice(0, 10);
  const rows = fresh.map((c) => {
    const src = c.source === 'code-search' ? '代码搜索（含 SKILL.md）' : '仓库搜索';
    const desc = (c.desc || '').replace(/\s+/g, ' ').slice(0, 60) || '—';
    return `| \`${c.key}\` | ${c.stars || '—'} | ${src} | ${desc} |`;
  }).join('\n');

  const body = `${MARKER}
## 发现层 · 待审候选（${fresh.length} 个）

这是 \`crawler/discover.mjs\` 主动搜索 GitHub 命中、并已通过星标门槛的仓库。
**它们目前没有上线**，本 PR 的 diff（\`crawler/config.json\` 的 watchlist 追加 ${fresh.length} 行）就是审核对象。

| 仓库 | Stars | 来源 | 描述 |
| --- | --- | --- | --- |
${rows}

### 怎么审

- **Merge pull request** = 采纳：这批仓库进入采集队列，合并后自动触发一次同步，下一轮即可在站内搜到。
- **Close pull request** = 拒收：工作流会把它们写入 \`crawler/candidates/rejected.json\`，${cfg.discover?.rejectRetryDays ?? 60} 天内不会再次出现在待审队列。
- 想只采纳其中几个？直接在 PR 里勾掉不想要的几行再合并即可（改的就是 watchlist）。

### 入选门槛（发现层自动执行的硬条件）

- 星标 ≥ \`crawler/config.json → discover.minStars\`（${cfg.discover?.minStars ?? 150}）
- 非 fork、非归档
- 命中「代码搜索」的候选按定义含 \`SKILL.md\` / \`marketplace.json\` 等 skill 文件

<sub>由 crawler/open-review-pr.mjs 生成 · ${now} · 待审队列累计 ${all.length} 条</sub>
`;

  const bodyOut = argVal('--body-out') || path.join(__dirname, 'candidates', 'pr-body.md');
  if (!DRY) await fs.writeFile(bodyOut, body);
  else console.log('\n' + body + '\n');

  await setOutput({ changed: 'true', count: String(fresh.length), body: bodyOut, title: `chore(discover): ${fresh.length} 个候选待审（${now}）` });
  log(`已写入 ${fresh.length} 个候选 → watchlist（${DRY ? 'dry-run 未落盘' : CONFIG_FILE}）`);
}

main().catch((e) => { console.error('[candidates FATAL]', e); process.exit(1); });
