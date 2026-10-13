/**
 * 采集器共用工具：环境读取、JSON 读写、键名规则、宿主推断
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 读 .deploy.env（KEY=VALUE，忽略注释与引号） */
export function loadEnv(file = join(ROOT, '.deploy.env')) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 仓库 id 规则：小写 + 斜杠换双下划线（三个脚本必须完全一致） */
export const idOf = (owner, repo) => `${owner}__${repo}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
export const watchKey = (owner, repo) => `${owner}/${repo}`;

/** 从文件树路径推断宿主（规则表在 config.hostRules，改规则不改代码） */
export function inferHosts(treePaths, repoMeta = {}, hostRules = {}) {
  const hosts = new Set();
  const lower = treePaths.map((p) => p.toLowerCase());
  const blob = lower.join('\n');

  for (const [host, signals] of Object.entries(hostRules)) {
    for (const sig of signals) {
      const s = sig.toLowerCase();
      if (s.endsWith('/')) {
        if (lower.some((p) => p.startsWith(s) || p.includes('/' + s))) {
          hosts.add(host);
          break;
        }
      } else if (blob.includes(s)) {
        hosts.add(host);
        break;
      }
    }
  }

  const topics = (repoMeta.topics || []).map((t) => t.toLowerCase());
  const desc = `${repoMeta.description || ''} ${topics.join(' ')}`.toLowerCase();
  if (/claude[\s-]?code|claude[\s-]?skills/.test(desc)) hosts.add('claude-code');
  if (/cursor/.test(desc)) hosts.add('cursor');
  if (/cline/.test(desc)) hosts.add('cline');
  if (/mcp/.test(desc)) hosts.add('mcp');
  if (/codex/.test(desc)) hosts.add('codex');

  if (!hosts.size) hosts.add('generic');
  return [...hosts].sort();
}

/**
 * 用途分类：按关键词命中数取最高者（不是先命中先归属）。
 * 理由：单纯「先命中先归属」会让「编码」吃掉一切 —— 几乎所有 skill 描述里都有 code 一词。
 * ASCII 关键词用词边界匹配（避免 claude-code 里的 code 误命中），CJK 用子串匹配。
 *
 * 权重（categoryWeights，config 可配，默认 1）：「编码」的关键词（code/test/api…）
 * 在所有技术类仓库描述里都高频出现，纯计数会让它压过领域类。降权后按「命中数 × 权重」
 * 比较，编码仍能在只有技术词的仓库上胜出，但遇到明确的领域词时让位。
 */
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function inferCategory(repoMeta, skills, categoryRules, categoryWeights = {}) {
  const hay = [
    repoMeta.description || '',
    ...skills.map((s) => `${s.name} ${s.desc} ${(s.triggers || []).join(' ')}`),
  ].join(' ');

  const scores = {};
  for (const [cat, keywords] of Object.entries(categoryRules)) {
    let n = 0;
    for (const kw of keywords) {
      if (/^[\x20-\x7E]+$/.test(kw)) {
        const re = new RegExp(`(^|[^A-Za-z0-9])${escRe(kw)}([^A-Za-z0-9]|$)`, 'i');
        if (re.test(hay)) n++;
      } else if (hay.includes(kw)) {
        n++;
      }
    }
    if (n) scores[cat] = n * (categoryWeights[cat] ?? 1);
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : '未分类';
}

/** 许可归一：GitHub 的 spdx_id 优先，其次 SKILL.md frontmatter */
export function normLicense(spdxId) {
  if (!spdxId || spdxId === 'NOASSERTION') return '';
  return spdxId;
}
