#!/usr/bin/env node
/**
 * SkillsBin 开工前置凭据自检
 * ------------------------------------------------------------
 * 读取根目录 .deploy.env，逐项实测 GitHub / Cloudflare 凭据是否齐备可用。
 *
 * 设计约束：
 *   1. 只读 —— 不创建、不修改任何远端资源（唯一例外是 --fix-workflow-perms 显式开启）；
 *   2. 不打印任何密钥明文（只显示掩码与长度）；
 *   3. 每条检查独立容错，一项失败不影响其余项继续跑。
 *
 * 用法：
 *   node scripts/check-credentials.mjs
 *   node scripts/check-credentials.mjs --fix-workflow-perms   # 顺手把仓库两个开关设好
 *
 * 退出码：全部关键项通过 = 0，否则 = 1
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : join(ROOT, '.deploy.env');
const FIX_WORKFLOW = process.argv.includes('--fix-workflow-perms');

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m' };
const rows = [];
const rec = (level, item, detail = '') => rows.push({ level, item, detail });

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const mask = (v) => (!v ? '(空)' : v.length <= 10 ? `${v[0]}***` : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} 字符)`);

async function api(url, { token, tokenType = 'bearer', headers = {} } = {}) {
  const h = {
    'User-Agent': 'skillsbin-credential-check',
    Accept: 'application/vnd.github+json',
    ...headers,
  };
  if (token) h.Authorization = tokenType === 'bearer' ? `Bearer ${token}` : `token ${token}`;
  try {
    const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(20000) });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

/* ------------------------------ 前置：读文件 ------------------------------ */
console.log(`\n${C.b}SkillsBin 开工前置凭据自检${C.r}`);
console.log(`${C.dim}凭据文件：${ENV_FILE}${C.r}\n`);

if (!existsSync(ENV_FILE)) {
  console.log(`${C.bad}✖ 找不到 .deploy.env${C.r} —— 请先复制模板并填写（申请指南见 docs/开工前置-凭据与权限清单.md）\n`);
  process.exit(1);
}

const env = parseEnv(readFileSync(ENV_FILE, 'utf8'));
const REQUIRED = [
  ['GH_OWNER', '新 GitHub 账号用户名'],
  ['GH_REPO', '仓库名'],
  ['GH_VISIBILITY', 'public 或 private'],
  ['GITHUB_TOKEN', 'fine-grained / classic 令牌'],
  ['CLOUDFLARE_ACCOUNT_ID', '新 CF 账号 ID'],
  ['CLOUDFLARE_API_TOKEN', 'CF API 令牌'],
  ['SITE_DOMAIN', '主域名'],
  ['SITE_MAIL', '邮件兜底地址'],
];

const missing = REQUIRED.filter(([k]) => !env[k]).map(([k, d]) => `${k} (${d})`);
if (missing.length) {
  console.log(`${C.warn}⚠ 以下必填项还没填，先补完再跑自检：${C.r}`);
  for (const m of missing) console.log(`   · ${m}`);
  console.log(`\n${C.dim}填写规则：不要加引号、不要留空格、不要换行。${C.r}\n`);
  process.exit(1);
}

const {
  GH_OWNER, GH_REPO, GH_VISIBILITY, GITHUB_TOKEN,
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
  SITE_DOMAIN, SITE_MAIL, CF_OLD_API_TOKEN = '',
} = env;

console.log(`${C.dim}GH_OWNER=${GH_OWNER}  GH_REPO=${GH_REPO}  GH_VISIBILITY=${GH_VISIBILITY}
GITHUB_TOKEN=${mask(GITHUB_TOKEN)}
CLOUDFLARE_ACCOUNT_ID=${mask(CLOUDFLARE_ACCOUNT_ID)}  CLOUDFLARE_API_TOKEN=${mask(CLOUDFLARE_API_TOKEN)}
SITE_DOMAIN=${SITE_DOMAIN}  SITE_MAIL=${SITE_MAIL}
旧账号令牌=${CF_OLD_API_TOKEN ? mask(CF_OLD_API_TOKEN) : '未提供（改走 DNS 导出文件导入）'}${C.r}\n`);

/* ------------------------------ 1. GitHub ------------------------------ */
const GH = 'https://api.github.com';
const ghBase = { token: GITHUB_TOKEN, tokenType: 'bearer' };
let ghLogin = '';

{
  const r = await api(`${GH}/user`, ghBase);
  if (r.ok) {
    ghLogin = r.data.login;
    rec('ok', 'GitHub 令牌有效', `登录名 ${r.data.login}`);
    if (ghLogin.toLowerCase() !== GH_OWNER.toLowerCase()) {
      rec('warn', '用户名与 GH_OWNER 不一致', `令牌属于 ${ghLogin}，GH_OWNER 填的是 ${GH_OWNER}`);
    }
  } else {
    rec('bad', 'GitHub 令牌无效', `HTTP ${r.status}${r.error ? ' ' + r.error : ''}`);
  }
}

{
  const r = await api(`${GH}/rate_limit`, ghBase);
  if (r.ok) {
    const core = r.data?.resources?.core;
    if (core?.limit >= 5000) rec('ok', 'API 配额为 PAT 档位', `${core.limit} 次/时（够 1500 仓库一轮）`);
    else if (core?.limit >= 1000) rec('warn', 'API 配额偏低', `${core.limit} 次/时 —— 像是仓库级 GITHUB_TOKEN，建议换成 PAT`);
    else rec('warn', 'API 配额过低', `${core?.limit ?? '?'} 次/时 —— 疑似令牌没被读到（PAT 应显示 5000）`);
  } else {
    rec('warn', '配额查询失败', `HTTP ${r.status}`);
  }
}

{
  const r = await api(`${GH}/repos/${GH_OWNER}/${GH_REPO}`, ghBase);
  if (r.ok) {
    const vis = r.data.visibility || (r.data.private ? 'private' : 'public');
    rec('ok', '仓库存在且可读', `${r.data.full_name} · ${vis}`);
    if (vis !== GH_VISIBILITY) rec('warn', '可见性与 GH_VISIBILITY 不符', `实际 ${vis}，配置写的是 ${GH_VISIBILITY}`);
    const p = r.data.permissions || {};
    if (p.push && p.admin) rec('ok', '令牌对仓库有管理写权限', 'push + admin 均已具备');
    else rec('bad', '令牌对仓库权限不足', `push=${!!p.push} admin=${!!p.admin} —— 需 Contents / Pull requests / Administration 写权限`);
  } else {
    rec('bad', '仓库不可读', `HTTP ${r.status} —— 仓库是否已创建？令牌是否覆盖 ${GH_OWNER}/${GH_REPO}？`);
  }
}

{
  // 代码搜索：skill 生态唯一能穷举 SKILL.md 的手段，匿名不可用
  const q = encodeURIComponent(`repo:${GH_OWNER}/${GH_REPO} filename:SKILL.md`);
  const r = await api(`${GH}/search/code?q=${q}&per_page=1`, ghBase);
  if (r.ok) rec('ok', '代码搜索 API 可用', `命中 ${r.data.total_count} 条（配额独立：10 次/分钟）`);
  else if (r.status === 403) rec('warn', '代码搜索被限流或未授权', 'HTTP 403 —— 稍后重试；若持续 403 说明令牌缺读权限');
  else rec('bad', '代码搜索 API 不可用', `HTTP ${r.status} —— 该接口匿名不可用，必须带令牌`);
}

{
  const r = await api(`${GH}/repos/${GH_OWNER}/${GH_REPO}/actions/permissions/workflow`, ghBase);
  if (r.ok) {
    const dwp = r.data.default_workflow_permissions;
    const apr = r.data.can_approve_pull_request_reviews;
    if (dwp === 'write' && apr === true) {
      rec('ok', '仓库两个开关已设好', 'workflow=write · 允许 Actions 创建/批准 PR');
    } else if (FIX_WORKFLOW) {
      const f = await fetch(`${GH}/repos/${GH_OWNER}/${GH_REPO}/actions/permissions/workflow`, {
        method: 'PUT',
        headers: {
          'User-Agent': 'skillsbin-credential-check',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ default_workflow_permissions: 'write', can_approve_pull_request_reviews: true }),
        signal: AbortSignal.timeout(20000),
      });
      if (f.ok || f.status === 204) rec('ok', '仓库两个开关已自动设好', 'workflow=write · 允许 Actions 创建/批准 PR');
      else rec('bad', '自动设置开关失败', `HTTP ${f.status} —— 请到 Settings → Actions → General 手动勾选`);
    } else {
      rec('warn', '仓库两个开关未设好', `workflow=${dwp} · can_approve_pr=${apr} —— 加 --fix-workflow-perms 可自动设，或手动点`);
    }
  } else {
    rec('warn', '读不到仓库 Actions 设置', `HTTP ${r.status} —— 令牌缺 Administration 读权限时属正常，可手动确认`);
  }
}

/* ---------------------------- 2. Cloudflare ---------------------------- */
const CF = 'https://api.cloudflare.com/client/v4';
const cfBase = { token: CLOUDFLARE_API_TOKEN, tokenType: 'bearer', headers: { Accept: 'application/json' } };

{
  const r = await api(`${CF}/user/tokens/verify`, cfBase);
  if (r.ok && r.data?.success) rec('ok', 'CF 令牌有效', `status=${r.data.result?.status}`);
  else rec('bad', 'CF 令牌无效', `HTTP ${r.status} ${JSON.stringify(r.data?.errors ?? r.error ?? '')}`);
}

{
  const r = await api(`${CF}/accounts/${CLOUDFLARE_ACCOUNT_ID}`, cfBase);
  if (r.ok && r.data?.success) rec('ok', 'CF 账号可读', `${r.data.result?.name} (${CLOUDFLARE_ACCOUNT_ID})`);
  else if (r.status === 403) rec('warn', 'CF 账号读不到', 'HTTP 403 —— 令牌缺 Account Settings:Read 或 Account Resources 未包含该账号');
  else rec('bad', 'CF 账号 ID 无效', `HTTP ${r.status} ${JSON.stringify(r.data?.errors ?? r.error ?? '')}`);
}

{
  const r = await api(`${CF}/zones?name=${encodeURIComponent(SITE_DOMAIN)}`, cfBase);
  const zone = r.ok && r.data?.success ? r.data.result?.[0] : null;
  if (zone) {
    rec('ok', `zone 已在新账号`, `${SITE_DOMAIN} · id=${zone.id} · status=${zone.status}`);
    const ns = zone.name_servers || [];
    if (ns.length) rec('info', '要填到注册商的 NS 值', ns.join('  |  '));
  } else {
    rec('warn', `zone 尚未添加到新账号`, `HTTP ${r.status} —— 到新账号 Add a site 添加 ${SITE_DOMAIN} 后重跑本项`);
  }
}

{
  const r = await api(`${CF}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects`, cfBase);
  if (r.ok && r.data?.success) {
    const names = (r.data.result || []).map((p) => p.name);
    rec('ok', 'Pages 项目列表可读', names.length ? `已有：${names.join(', ')}` : '暂无项目（首次发布时我会建 skillsbin）');
  } else {
    rec('warn', 'Pages 项目列表读不到', `HTTP ${r.status} —— 令牌缺 Cloudflare Pages:Edit`);
  }
}

if (CF_OLD_API_TOKEN) {
  const r = await api(`${CF}/zones?name=${encodeURIComponent(SITE_DOMAIN)}`, { token: CF_OLD_API_TOKEN, tokenType: 'bearer', headers: { Accept: 'application/json' } });
  const zone = r.ok && r.data?.success ? r.data.result?.[0] : null;
  if (zone) rec('ok', '旧账号令牌可用（可代导出 DNS）', `${SITE_DOMAIN} · id=${zone.id}`);
  else rec('warn', '旧账号令牌读不到 zone', `HTTP ${r.status} —— 也可改为在旧账号 DNS 面板 Export 记录文件放进 secrets/`);
}

/* ------------------------------- 输出 ------------------------------- */
const ICON = { ok: `${C.ok}✅${C.r}`, bad: `${C.bad}❌${C.r}`, warn: `${C.warn}⚠️ ${C.r}`, info: `${C.dim}ℹ️ ${C.r}` };
const LABEL = { ok: '通过', bad: '未通过', warn: '需注意', info: '信息' };

console.log(`${C.b}自检结果${C.r}`);
console.log(`${C.dim}${'─'.repeat(74)}${C.r}`);
for (const r of rows) {
  console.log(`${ICON[r.level]} ${r.item}`);
  if (r.detail) console.log(`   ${C.dim}${r.detail}${C.r}`);
}
console.log(`${C.dim}${'─'.repeat(74)}${C.r}`);

const bad = rows.filter((r) => r.level === 'bad').length;
const warn = rows.filter((r) => r.level === 'warn').length;

if (bad === 0 && warn === 0) {
  console.log(`${C.ok}${C.b}全部通过 —— 可以进入开发了。${C.r} 把这段输出发我即可。\n`);
  process.exit(0);
}
if (bad === 0) {
  console.log(`${C.warn}${C.b}无阻断项，有 ${warn} 项需注意${C.r}（多为 zone 迁移等待期，不影响阶段 0/1 开工）。\n`);
  process.exit(0);
}
console.log(`${C.bad}${C.b}有 ${bad} 项未通过${C.r}，按上面的提示补完后重跑本脚本。`);
console.log(`${C.dim}申请路径见 docs/开工前置-凭据与权限清单.md${C.r}\n`);
process.exit(1);
