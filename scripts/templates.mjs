/**
 * 模板与组件：图标 sprite、HTML 转义、迷你 Markdown、页面骨架
 * ------------------------------------------------------------
 * 零框架：模板字符串 + 纯函数。所有图标自绘（不引入第三方品牌图标集，避免侵权风险）。
 */
import { hostMeta, catMeta } from './taxonomy.mjs';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const attr = (s) => esc(s).replace(/\n/g, ' ');

/* ============================ 图标 sprite ============================ */
/* 全部自绘，24×24 画布。宿主图标一律用抽象几何符号，不用任何产品官方 logo。 */
export const ICON_SPRITE = `
<symbol id="i-logo" viewBox="0 0 24 24"><path d="M12 2.6 20.2 7.3v9.4L12 21.4 3.8 16.7V7.3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><rect x="7.4" y="7.4" width="3.2" height="3.2" rx=".7" fill="currentColor" stroke="none"/><rect x="13.4" y="7.4" width="3.2" height="3.2" rx=".7" fill="currentColor" stroke="none" opacity=".55"/><rect x="7.4" y="13.4" width="3.2" height="3.2" rx=".7" fill="currentColor" stroke="none" opacity=".55"/><path d="M13.6 16.6h3.4m0 0-1.5-1.5m1.5 1.5-1.5 1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.2 4.2"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M5.5 15H5a1.4 1.4 0 0 1-1.4-1.4V5.4A1.4 1.4 0 0 1 5 4h8.2A1.4 1.4 0 0 1 14.6 5.4V6"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12.8 4.4 4.4L19 7.6"/></symbol>
<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z"/></symbol>
<symbol id="i-star" viewBox="0 0 24 24"><path d="m12 3.4 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.9l6.1-.9Z"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 2"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24"><circle cx="8.2" cy="8.2" r="4.2"/><path d="m11.3 11.3 7.3 7.3M16.4 16.4l1.6-1.6M18.6 18.6l1.6-1.6"/></symbol>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6c2.2 2.3 3.3 5.2 3.3 8.4S14.2 18.1 12 20.4c-2.2-2.3-3.3-5.2-3.3-8.4S9.8 5.9 12 3.6Z"/></symbol>
<symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.4"/><path d="m7.6 9.6 2.8 2.6-2.8 2.6M12.6 15h4"/></symbol>
<symbol id="i-box" viewBox="0 0 24 24"><path d="M20.4 8.2v7.6L12 20.4 3.6 15.8V8.2L12 3.6Z"/><path d="M3.6 8.2 12 12.8l8.4-4.6M12 12.8v7.6"/></symbol>
<symbol id="i-external" viewBox="0 0 24 24"><path d="M13.4 4.6h6v6M19 5 11 13M17.4 14v4.4a1.4 1.4 0 0 1-1.4 1.4H5.6a1.4 1.4 0 0 1-1.4-1.4V8a1.4 1.4 0 0 1 1.4-1.4H10"/></symbol>
<symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="m9.6 5.6 6.4 6.4-6.4 6.4"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 7.4h10M18 7.4h2M4 16.6h2M10 16.6h10"/><circle cx="16" cy="7.4" r="2.1"/><circle cx="8" cy="16.6" r="2.1"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 3.6 8.4 4.4L12 12.4 3.6 8Z"/><path d="m3.6 12.6 8.4 4.4 8.4-4.4"/></symbol>
<symbol id="i-sparkles" viewBox="0 0 24 24"><path d="M12 3.2 13.6 8l4.8 1.6L13.6 11.2 12 16l-1.6-4.8L5.6 9.6 10.4 8Z"/><path d="M18.4 15.2 19.2 17.6l2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8Z"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3.4 19 6v6c0 4.2-2.9 7.4-7 8.6-4.1-1.2-7-4.4-7-8.6V6Z"/><path d="m9.2 12 2 2 3.6-3.8"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4M12 7.8h.01"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 15.6V4.8M8.2 8.6 12 4.8l3.8 3.8"/><path d="M4.6 14.4v3.8a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-3.8"/></symbol>
<symbol id="i-book" viewBox="0 0 24 24"><path d="M4.4 5.2A1.6 1.6 0 0 1 6 3.6h12.2v16.8H6a1.6 1.6 0 0 0-1.6 1.6Z"/><path d="M4.4 18.6a1.6 1.6 0 0 1 1.6-1.6h12.2"/></symbol>
<symbol id="i-git-branch" viewBox="0 0 24 24"><circle cx="7" cy="5.6" r="2.2"/><circle cx="7" cy="18.4" r="2.2"/><circle cx="17" cy="12" r="2.2"/><path d="M7 7.8v8.4M7 12h5.6a2.2 2.2 0 0 0 2.2-2.2v-.2"/></symbol>
<symbol id="i-hexagons" viewBox="0 0 24 24"><path d="M12 3.4 16.4 6v5.2L12 13.8 7.6 11.2V6Z"/><path d="M7.6 13.8v3.4L12 19.8l4.4-2.6v-3.4"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4.4 21 19.4H3Z"/><path d="M12 10v4M12 16.6h.01"/></symbol>
<symbol id="i-mail" viewBox="0 0 24 24"><rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2"/><path d="m3.8 6.6 8.2 6 8.2-6"/></symbol>

<symbol id="i-home" viewBox="0 0 24 24"><path d="M4 10.6 12 4.2l8 6.4V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19Z"/><path d="M9.6 20.4v-5.4h4.8v5.4"/></symbol>
<symbol id="i-briefcase" viewBox="0 0 24 24"><rect x="3.4" y="7.6" width="17.2" height="11.8" rx="2.2"/><path d="M9.2 7.6V5.8a1.6 1.6 0 0 1 1.6-1.6h2.4a1.6 1.6 0 0 1 1.6 1.6v1.8M3.4 12.6h17.2"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="m10.2 8.6 5.6 3.4-5.6 3.4Z"/></symbol>
<symbol id="i-megaphone" viewBox="0 0 24 24"><path d="M4 10.4h3.4L14.6 7v10.2L7.4 13.6H4Z"/><path d="M17.6 9.4a3.6 3.6 0 0 1 0 5.2"/><path d="M8 13.6v3.6"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="4.6" y="10.4" width="14.8" height="9.4" rx="2.2"/><path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6M12 14.2v2.6"/></symbol>
<symbol id="i-cap" viewBox="0 0 24 24"><path d="m3.4 9.6 8.6-4.2 8.6 4.2-8.6 4.2Z"/><path d="M7.8 11.8v4.4c0 1 1.9 1.8 4.2 1.8s4.2-.8 4.2-1.8v-4.4"/></symbol>
<symbol id="i-host-generic" viewBox="0 0 24 24"><path d="M12 2.8 20.6 7.6v8.8L12 21.2 3.4 16.4V7.6Z"/><rect x="8.4" y="8.4" width="3" height="3" rx=".6" fill="currentColor" stroke="none"/><rect x="12.6" y="8.4" width="3" height="3" rx=".6" fill="currentColor" stroke="none"/><rect x="8.4" y="12.6" width="3" height="3" rx=".6" fill="currentColor" stroke="none"/><rect x="12.6" y="12.6" width="3" height="3" rx=".6" fill="currentColor" stroke="none"/></symbol>
<symbol id="i-host-claude-code" viewBox="0 0 24 24"><path d="M12 3.2v6.2M12 14.6v6.2M3.2 12h6.2M14.6 12h6.2M6 6l3.4 3.4M14.6 14.6 18 18M18 6l-3.4 3.4M9.4 14.6 6 18"/></symbol>
<symbol id="i-host-cursor" viewBox="0 0 24 24"><path d="M6.2 3.8 18.6 12l-6.2 1.6L9.6 20Z"/></symbol>
<symbol id="i-host-cline" viewBox="0 0 24 24"><path d="M12 3.4 20.4 18.6H3.6Z"/><path d="M12 9.6v4.2M12 16.4h.01"/></symbol>
<symbol id="i-host-codex" viewBox="0 0 24 24"><rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4"/><path d="m7.8 9.8 2.8 2.6-2.8 2.6M13 15h3.6"/></symbol>
<symbol id="i-host-mcp" viewBox="0 0 24 24"><rect x="3.2" y="8.6" width="6.4" height="6.8" rx="1.8"/><rect x="14.4" y="8.6" width="6.4" height="6.8" rx="1.8"/><path d="M9.6 12h4.8"/></symbol>
<symbol id="i-host-gemini" viewBox="0 0 24 24"><path d="M12 3.2 14 10l6.8 2L14 14l-2 6.8L10 14l-6.8-2L10 10Z"/></symbol>
<symbol id="i-host-windsurf" viewBox="0 0 24 24"><path d="M3.6 14.4c2.6-4.4 5.2-4.4 7.8 0s5.2 4.4 7.8 0"/><path d="M3.6 8.6c2.6-4.4 5.2-4.4 7.8 0"/></symbol>`;

/* ============================ 迷你 Markdown ============================ */
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

/** 把 SKILL.md 正文转成 HTML。支持标题/列表/代码块/引用/表格/分割线/段落。 */
export function mdToHtml(md) {
  const src = String(md || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      closeList();
      const lang = line.replace(/^\s*```/, '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const t = /^\s*(\d+)\./.test(line) ? 'ol' : 'ul';
      if (listType !== t) {
        closeList();
        out.push(`<${t}>`);
        listType = t;
      }
      out.push(`<li>${inline(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      closeList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }

  closeList();
  return out.join('\n');
}

/* ============================ 组件 ============================ */
export function hostChip(host, { asLink = true, base = '' } = {}) {
  const m = hostMeta(host);
  const inner = `<svg class="icon" aria-hidden="true"><use href="#${m.icon}"></use></svg>${esc(m.label)}`;
  return asLink
    ? `<a class="chip" href="${base}/h/${m.slug}/">${inner}</a>`
    : `<span class="chip">${inner}</span>`;
}

export function catChip(cat, { asLink = true, base = '' } = {}) {
  const m = catMeta(cat);
  return asLink
    ? `<a class="chip" href="${base}/c/${m.slug}/">${esc(cat)}</a>`
    : `<span class="badge cat">${esc(cat)}</span>`;
}

export function tierBadge(tier) {
  if (tier === 'featured') return `<span class="badge featured"><svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg>精选</span>`;
  if (tier === 'standard') return `<span class="badge">标准</span>`;
  return `<span class="badge">观察</span>`;
}

export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  const d = Math.floor((now - t) / 86400000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.round(d / 30)} 个月前`;
  return `${(d / 365).toFixed(1)} 年前`;
}

export function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + ' 万';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

/**
 * 许可展示：SPDX id（MIT / Apache-2.0 / BSD-3-Clause…）原样展示；
 * 作者自填的自由文本（如「Complete terms in LICENSE.txt」）没有徽章价值，
 * 统一显示为「见仓库许可」，避免出现一长句撑爆标签行。
 */
const SPDX_LIKE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,39}$/;
export const isSpdxLike = (l) => SPDX_LIKE.test(String(l || '').trim()) && String(l).trim().length > 1;
export function licenseLabel(l) {
  const s = String(l || '').trim();
  if (!s) return '';
  return isSpdxLike(s) ? s : '见仓库许可';
}

/** skill 卡片
 *  中文摘要优先取 skill 级（owner/repo/slug 粒度）；skill 级未撰写时回落仓库级，
 *  这样卡片对中文读者仍有意义，但要用「仓库简介」标记出粒度差异，不能冒充 skill 级摘要。 */
export function skillCard(item, skill, base = '') {
  const href = `${base}/skills/${item.owner}/${item.repo}/${skill.slug}/`;
  const skillZh = skill.descZh || '';
  const repoZh = skillZh ? '' : item.descZh || '';
  const summary = skillZh || repoZh || skill.desc || item.desc || '（未填写描述）';
  return `<a class="card" href="${href}">
  <div class="card-title"><svg class="icon" aria-hidden="true"><use href="#i-box"></use></svg><span>${esc(skill.name)}</span></div>
  <div class="card-desc">${esc(summary)}</div>
  <div class="card-meta">
    ${item.quality.tier === 'featured' ? tierBadge('featured') : ''}
    <span>${esc(item.owner)}/${esc(item.repo)}</span>
    <span class="dot"></span>
    <span><svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg> ${fmtNum(item.stars)}</span>
    ${repoZh ? '<span class="dot"></span><span title="该 skill 尚无单独撰写的中文摘要，此处展示所属仓库的简介">仓库简介</span>' : ''}
    ${!skillZh && !repoZh ? '<span class="dot"></span><span>原文</span>' : ''}
  </div>
  <div class="card-meta">${item.hosts.slice(0, 3).map((h) => `<span class="badge host">${esc(hostMeta(h).label)}</span>`).join('')}</div>
</a>`;
}

/** 仓库卡片（列表页用，以仓库为单位）
 *  data-* 属性供 app.js 做浏览器端筛选/排序 —— 这样能保住预渲染的 SSR 正文，不必整体重渲。 */
export function repoCard(item, base = '') {
  const href = `${base}/skills/${item.owner}/${item.repo}/`;
  const summary = item.descZh || item.desc || '（仓库未填写描述）';
  const needsKey = (item.skills || []).some((s) => s.requires?.apiKey) ? 1 : 0;
  const needsNet = (item.skills || []).some((s) => s.requires?.network) ? 1 : 0;
  return `<a class="card" data-repo="${attr(item.id)}" data-hosts="${attr(item.hosts.join(','))}" data-cat="${attr(item.category)}" data-q="${attr(item.quality.score)}" data-st="${attr(item.stars)}" data-sc="${attr(item.skillCount)}" data-at="${attr(item.pushedAt || '')}" data-key="${needsKey}" data-net="${needsNet}" href="${href}">
  <div class="card-title"><svg class="icon" aria-hidden="true"><use href="#i-hexagons"></use></svg><span>${esc(item.owner)}/${esc(item.repo)}</span></div>
  <div class="card-desc">${esc(summary)}</div>
  <div class="card-meta">
    ${item.quality.tier === 'featured' ? tierBadge('featured') : ''}
    <span class="badge cat">${esc(item.category)}</span>
    <span><svg class="icon" aria-hidden="true"><use href="#i-box"></use></svg> ${item.skillCount} 个 skill</span>
    <span class="dot"></span>
    <span><svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg> ${fmtNum(item.stars)}</span>
    <span class="dot"></span>
    <span><svg class="icon" aria-hidden="true"><use href="#i-clock"></use></svg> ${timeAgo(item.pushedAt)}</span>
  </div>
</a>`;
}

/* ============================ 页面骨架 ============================ */
export function layout({
  site,
  title,
  description,
  canonical,
  base = '',
  content,
  jsonld = [],
  active = '',
  ogType = 'website',
  themeColor = '#0f6e56',
  indexData = null,
}) {
  const fullTitle = title ? `${title} · ${site.name}` : `${site.name}（${site.nameZh}）— ${site.tagline}`;
  const sibs = (site.siblings || []).map((s) => `<a href="${attr(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`).join('');
  const ldArr = Array.isArray(jsonld) ? jsonld : jsonld ? [jsonld] : [];
  const ld = ldArr
    .filter(Boolean)
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="${attr(canonical)}">
<meta name="theme-color" content="${attr(themeColor)}">
<meta property="og:type" content="${attr(ogType)}">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${attr(fullTitle)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="${attr(canonical)}">
<meta property="og:image" content="https://${attr(site.domain)}/assets/img/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(fullTitle)}">
<meta name="twitter:description" content="${attr(description)}">
<meta name="twitter:image" content="https://${attr(site.domain)}/assets/img/og.png">
<link rel="alternate" hreflang="zh-CN" href="${attr(canonical)}">
<link rel="alternate" hreflang="x-default" href="${attr(canonical)}">
<link rel="icon" href="${base}/assets/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${base}/assets/css/style.css">
<script>try{var t=localStorage.getItem('sb-theme');if(t)document.documentElement.dataset.theme=t;else if(matchMedia('(prefers-color-scheme:dark)').matches)document.documentElement.dataset.theme='dark'}catch(e){}</script>
${ld}
</head>
<body data-base="${attr(base)}">
<svg style="display:none" aria-hidden="true"><defs>${ICON_SPRITE}</defs></svg>

<a href="#main" class="sr-only">跳到主要内容</a>

<header class="site-header">
  <div class="container">
    <a class="brand" href="${base}/">
      <span class="brand-mark"><svg class="icon" style="font-size:17px"><use href="#i-logo"></use></svg></span>
      ${esc(site.name)}<small>${esc(site.nameZh)}</small>
    </a>
    <nav class="nav">
      <a href="${base}/skills/"${active === 'skills' ? ' aria-current="page"' : ''}>全部 Skill</a>
      <a href="${base}/c/code/"${active === 'cat' ? ' aria-current="page"' : ''}>分类</a>
      <a href="${base}/h/claude-code/"${active === 'host' ? ' aria-current="page"' : ''}>宿主</a>
      <a href="${base}/about/"${active === 'about' ? ' aria-current="page"' : ''}>关于</a>
    </nav>
    <span class="header-spacer"></span>
    <div class="searchbox">
      <svg class="icon" aria-hidden="true"><use href="#i-search"></use></svg>
      <input id="q" type="search" placeholder="搜索 skill、用途、宿主…" aria-label="搜索" autocomplete="off">
      <kbd>/</kbd>
    </div>
    <button class="icon-btn" id="theme-btn" type="button" aria-label="切换主题"><svg class="icon" aria-hidden="true"><use href="#i-moon"></use></svg></button>
    <a class="icon-btn" href="https://github.com/${attr(site.repo)}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库"><svg class="icon" aria-hidden="true"><use href="#i-git-branch"></use></svg></a>
    <a class="btn sm primary" href="${base}/submit/">提交收录</a>
  </div>
</header>

<main id="main">
${content}
</main>

<footer class="site-footer">
  <div class="container">
    <div class="row">
      <div>
        <div style="font-weight:600;color:var(--c-text)">${esc(site.name)} · ${esc(site.nameZh)}</div>
        <div style="margin-top:6px">${esc(site.tagline)}</div>
      </div>
      <nav>
        <a href="${base}/skills/">全部 Skill</a>
        <a href="${base}/submit/">提交收录</a>
        <a href="${base}/about/">关于</a>
        <a href="${base}/llms.txt">llms.txt</a>
        <a href="https://github.com/${attr(site.repo)}" target="_blank" rel="noopener noreferrer">GitHub</a>
        ${sibs}
      </nav>
    </div>
    <p class="legal">
      本项目仅做数据聚合，所有 Skill 的版权与许可归原仓库作者所有。站内展示的简介若无特别标注均为本站撰写的摘要，
      不构成原文再分发；正文仅在内联许可白名单内展示，并固定标注来源、许可与 commit。
      权利人若要求下架，请邮件至 <a href="mailto:${attr(site.mail)}?subject=%E4%B8%8B%E6%9E%B6%E7%94%B3%E8%AF%B7">${esc(site.mail)}</a>，我们承诺 72 小时内处理。
      数据每 12 小时更新，最近一次采集：<span data-synced>—</span>。
    </p>
  </div>
</footer>

<div id="toast-wrap" role="status" aria-live="polite"></div>
<script src="${base}/assets/js/data.js"></script>
<script src="${base}/assets/js/app.js" defer></script>
</body>
</html>`;
}
