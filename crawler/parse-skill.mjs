/**
 * SKILL.md frontmatter 解析（纯函数，可单测）
 * ------------------------------------------------------------
 * skill 生态的 frontmatter 极不规范，本解析器按开发文档 §5.4 的「容错原则」实现：
 *   · 字段名大小写、连字符与下划线互认（allowed-tools / allowedTools / allowed_tools 等价）
 *   · 引号包裹 / 裸值 / 内联数组 [a, b] / 多行 - 列表 / 块标量 > | 四种写法都要吃
 *   · 单个 skill 解析失败不导致整仓库被拒，只记 parseError
 *
 * 不引入 YAML 依赖 —— 只支持一层扁平键 + 数组 / 块标量，这正是 SKILL.md 的实际形态。
 */
import { createHash } from 'node:crypto';

const KEY_ALIAS = (k) => k.toLowerCase().replace(/[\s_-]/g, '');

/** 去掉成对引号 */
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

/** 内联数组 [a, b, "c"] → ['a','b','c'] */
function parseInlineArray(v) {
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((x) => unquote(x))
    .filter((x) => x !== '');
}

/**
 * 解析 YAML frontmatter 块（只吃一层扁平结构）
 * @returns {{data: Record<string, string|string[]>, error: string|null}}
 */
export function parseFrontmatterBlock(raw) {
  const data = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  let error = null;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    // 缩进行 = 嵌套结构（inputs: / metadata: / hooks: 的下一层），不是顶层键。
    // 曾经的键名正则把空格也算进键名字符集，于是 `    description:` 被当成顶层
    // description 并**覆盖**掉真正的 skill 简介 —— firecrawl/firecrawl 的 5 个
    // skill 简介全变成「Optional base URL for self-hosted Firecrawl deployments.」
    // （那是 inputs[].description 的值）就是这么来的。嵌套行一律跳过。
    if (/^\s/.test(line)) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!m) {
      error = error || `无法解析的行: ${line.slice(0, 60)}`;
      i++;
      continue;
    }
    const key = m[1].trim();
    const nk = KEY_ALIAS(key);
    let rest = m[2];

    // 块标量 > / | ：吃后续更深缩进的行
    if (/^[>|][+-]?\s*$/.test(rest.trim())) {
      const buf = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          buf.push('');
          i++;
          continue;
        }
        if (!/^\s+/.test(l)) break;
        buf.push(l.replace(/^\s{1,4}/, ''));
        i++;
      }
      data[nk] = buf.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }

    // 内联数组
    if (rest.trim().startsWith('[')) {
      data[nk] = parseInlineArray(rest);
      i++;
      continue;
    }

    // 空值 → 可能是多行 - 列表，也可能是**裸多行标量**（YAML 允许纯标量续行，Gemini CLI 大量使用）
    if (rest.trim() === '') {
      let j = i + 1;
      // 先跳过后面的空行，看第一行非空内容长什么样
      while (j < lines.length && lines[j].trim() === '') j++;
      const next = j < lines.length ? lines[j] : '';

      if (/^\s*-\s+/.test(next)) {
        const items = [];
        let k = i + 1;
        // 列表项的**续行**（更深的缩进）也是该列表的一部分，必须一并吃掉，
        // 否则会被主循环当成顶层键（`inputs:` 下每一项的 `description:` 同理）。
        while (k < lines.length && (/^\s*-\s+/.test(lines[k]) || /^\s+\S/.test(lines[k]))) {
          if (/^\s*-\s+/.test(lines[k])) items.push(unquote(lines[k].replace(/^\s*-\s+/, '')));
          k++;
        }
        data[nk] = items;
        i = k;
        continue;
      }

      if (/^\s+\S/.test(next)) {
        // 裸多行标量：吃下所有「缩进更深且不是新键」的续行，按空格折叠
        const buf = [];
        let k = i + 1;
        while (k < lines.length) {
          const l = lines[k];
          if (l.trim() === '') { buf.push(''); k++; continue; }
          if (!/^\s+/.test(l)) break;
          if (/^\s*-\s+/.test(l)) break;
          // 形如 "  key: value" 的缩进行视为嵌套结构，不并入纯标量
          if (/^\s+[A-Za-z0-9_.\-]+\s*:(\s|$)/.test(l)) break;
          buf.push(l.trim());
          k++;
        }
        const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
        if (joined) {
          data[nk] = joined;
          i = k;
          continue;
        }
      }

      data[nk] = '';
      i++;
      continue;
    }

    data[nk] = unquote(rest);
    i++;
  }

  return { data, error };
}

/**
 * 从文件正文中切出 frontmatter 与 body
 * @returns {{fm: Record<string, string|string[]>, body: string, fmRaw: string, hadFm: boolean}}
 */
export function splitFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const m = src.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!m) return { fm: {}, body: src, fmRaw: '', hadFm: false };
  const { data } = parseFrontmatterBlock(m[1]);
  return { fm: data, body: src.slice(m[0].length), fmRaw: m[1], hadFm: true };
}

/** 取字段（键名归一化后匹配，兼容多种写法） */
export function pick(fm, ...names) {
  const want = names.map(KEY_ALIAS);
  for (const k of Object.keys(fm)) {
    if (want.includes(KEY_ALIAS(k))) {
      const v = fm[k];
      if (Array.isArray(v)) return v;
      return v == null ? '' : String(v);
    }
  }
  return undefined;
}

const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [String(v)] : []);

/** 常见外部命令行工具名（用于推断 bins 依赖） */
const KNOWN_BINS = [
  'git', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pip', 'uv', 'uvx',
  'docker', 'kubectl', 'gh', 'curl', 'wget', 'jq', 'ffmpeg', 'pandoc', 'pdftk', 'qpdf',
  'tesseract', 'playwright', 'npx', 'deno', 'cargo', 'rustc', 'go', 'make', 'gcc', 'rg',
  'ripgrep', 'fd', 'awk', 'sed', 'sqlite3', 'psql', 'mysql', 'redis-cli', 'aws', 'gcloud',
  'az', 'terraform', 'helm', 'poetry', 'conda', 'brew', 'imagemagick', 'convert', 'soffice',
];

/** 推断依赖属性：是否需要 API Key / 联网 / 外部命令 */
export function inferRequires(fm, body) {
  const hay = `${JSON.stringify(fm)}\n${body}`.toLowerCase();
  const apiKey =
    /(api[_\s-]?key|apikey|access[_\s-]?token|bearer\s+token|secret[_\s-]?key|openai_api_key|anthropic_api_key)/i.test(
      hay,
    );
  const network =
    /(https?:\/\/|fetch\(|axios|requests\.|curl\s|webhook|api\.|endpoint)/i.test(hay);
  const bins = KNOWN_BINS.filter((b) => new RegExp(`(^|[^a-z0-9_-])${b}([^a-z0-9_-]|$)`, 'i').test(hay));
  return { apiKey, network, bins: bins.slice(0, 8) };
}

/** 推断触发场景（用于搜索加权与页面标签）—— 宁可为空，也不产出垃圾片段 */
export function inferTriggers(fm, body) {
  const out = new Set();

  // 1. 显式字段优先
  for (const t of asArray(pick(fm, 'triggers', 'trigger', 'when-to-use', 'use-when'))) {
    const v = String(t).trim();
    if (v) out.add(v);
  }

  // 2. 从 description 里抽「Use when …」/「适用于 …」从句，再按标点切短语
  const desc = String(pick(fm, 'description') || '');
  const m = desc.match(/(?:use\s+(?:this\s+(?:skill\s+)?)?when|适用于|用于)\s*[：:]?\s*([^。.!?]{4,90})/i);
  if (m) {
    for (const part of m[1].split(/[,，;；、]|\s+or\s+/i)) {
      const t = part.trim().replace(/^[-–—\s"']+|[-–—\s"']+$/g, '');
      if (t && t.length >= 2 && t.length <= 24 && t.split(/\s+/).length <= 5) out.add(t);
    }
  }

  // 3. 正文里的显式触发提示
  const mb = body.match(/(?:use\s+when|触发(?:时机|条件)?)\s*[：:]\s*([^\n]{4,120})/i);
  if (mb) {
    const t = mb[1].trim().slice(0, 120);
    if (t) out.add(t);
  }

  return [...out].slice(0, 8);
}

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * 把一份 SKILL.md 正文 + 路径，规范化成一个 skill 记录
 * @param {{owner:string, repo:string, path:string, text:string, hosts?:string[], limits?:{descMinLen:number, descMaxLen:number, nameMaxLen:number}}} o
 * @returns {{ok: true, skill: object} | {ok: false, error: string}}
 */
export function normalizeSkill({ owner, repo, path, text, hosts = [], limits = {} }) {
  const DESC_MIN = limits.descMinLen ?? 20;
  const DESC_MAX = limits.descMaxLen ?? 1500;

  const { fm, body, hadFm } = splitFrontmatter(text);
  if (!hadFm) return { ok: false, error: 'no-frontmatter' };

  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const dirBase = (dir.split('/').pop() || '').trim();

  let name = String(pick(fm, 'name') || '').trim();
  // 兜底：不少仓库只写 description（如 rtk-ai/rtk），name 缺失时用目录名顶上
  if (!name) name = dirBase;
  if (!name) return { ok: false, error: 'missing-name' };
  if (name.length > 200) return { ok: false, error: 'name-too-long' };

  const description = String(pick(fm, 'description') || '').trim();
  if (!description) return { ok: false, error: 'missing-description' };
  if (description.length < DESC_MIN) return { ok: false, error: 'description-too-short' };
  if (description.length > DESC_MAX) return { ok: false, error: 'description-too-long' };

  // slug 一律从目录名派生（天然 kebab-case、与安装目录一致）；目录缺失时才从 name 生成。
  // name 允许是「AgentDB Advanced Features」这类自由文本 —— 只作展示，不进 URL。
  let slug = (dirBase || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug) slug = 'skill';

  const license = String(pick(fm, 'license') || '').trim();
  const version = String(pick(fm, 'version') || '').trim();
  const allowedTools = asArray(pick(fm, 'allowed-tools', 'allowedTools', 'allowed_tools'));
  const author = String(pick(fm, 'author') || '').trim();
  const metaExtra = {};
  for (const [k, v] of Object.entries(fm)) {
    if (KEY_ALIAS(k).startsWith('metadata') && !Array.isArray(v) && v) metaExtra[k] = v;
  }

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;

  return {
    ok: true,
    skill: {
      slug,
      name,
      dir,
      path,
      desc: description,
      descZh: '',
      triggers: inferTriggers(fm, body),
      version: version || '',
      license: license || '',
      allowedTools,
      author,
      metaExtra,
      hosts: hosts.length ? hosts : ['generic'],
      requires: inferRequires(fm, body),
      install: {},
      bodyInline: false,
      excerpt: '',
      contentHash: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      wordCount: words,
    },
  };
}

/** 判断某路径是否是 SKILL.md */
export const isSkillPath = (p) => /(^|\/)SKILL\.md$/i.test(p);
