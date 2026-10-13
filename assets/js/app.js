/* SkillsBin 前端交互
 * ------------------------------------------------------------
 * 零依赖。职责：
 *   1. 主题切换（localStorage 持久化，避免首屏闪白 —— 主题判定在 <head> 内联脚本里已做）
 *   2. 搜索：顶栏/#hero-q 回车进搜索页；搜索页读 ?q=，防抖过滤 window.__SB__.skills
 *   3. 列表页筛选与排序：直接过滤预渲染的 DOM 卡片（保住 SSR 正文，不做整页重渲）
 *   4. 复制：安装命令 / SKILL.md 正文 / 原文链接，带 toast 与按钮态反馈
 *   5. 安装方式 tab 切换、提交页预览联动、页脚数据时间回填
 *
 * 约定：所有跨页数据来自 window.__SB__（由 prerender 生成的 assets/js/data.js）。
 */
(function () {
  'use strict';

  var D = window.__SB__ || { repos: [], skills: [], categories: {}, hosts: {} };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var base = document.body.getAttribute('data-base') || '';

  /* ============================ 1. 工具 ============================ */
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var fmtNum = function (n) {
    var v = Number(n) || 0;
    if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + ' 万';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  };
  var hostLabel = function (h) { return (D.hosts[h] && D.hosts[h].label) || h; };
  var hostsOf = function (r) { return r.hosts || []; };

  /* ============================ 2. Toast ============================ */
  var toastTimer = null;
  function toast(msg, kind) {
    var wrap = $('#toast-wrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#' +
      (kind === 'err' ? 'i-alert' : 'i-check') + '"></use></svg><span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 220);
    }, 2400);
  }

  /* ============================ 3. 复制 ============================ */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // 非 https / 老浏览器兜底
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('execCommand failed')); }
      catch (e) { reject(e); }
      finally { ta.remove(); }
    });
  }

  function flash(btn, ok) {
    var use = btn.querySelector('use');
    if (!use) return;
    var prev = use.getAttribute('href');
    use.setAttribute('href', ok ? '#i-check' : '#i-alert');
    setTimeout(function () { use.setAttribute('href', prev); }, 1400);
  }

  function wireCopy(root) {
    $$('[data-copy]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = btn.getAttribute('data-copy-label');
        copyText(btn.getAttribute('data-copy')).then(
          function () { flash(btn, true); toast(label || '已复制到剪贴板'); },
          function () { flash(btn, false); toast('复制失败，请手动选择文本复制', 'err'); },
        );
      });
    });

    $$('[data-copy-raw]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inline = btn.getAttribute('data-copy-raw-inline') === '1';
        var holder = $('#skill-md');
        if (inline && holder) {
          copyText(holder.textContent).then(
            function () { flash(btn, true); toast('已复制 SKILL.md 全文'); },
            function () { flash(btn, false); toast('复制失败', 'err'); },
          );
          return;
        }
        var url = btn.getAttribute('data-copy-raw');
        copyText(url).then(
          function () { flash(btn, true); toast('已复制原文链接（该许可不在内联白名单，正文未在站内展示）'); },
          function () { flash(btn, false); toast('复制失败', 'err'); },
        );
      });
    });
  }

  /* ============================ 4. 主题 ============================ */
  function initTheme() {
    var btn = $('#theme-btn');
    if (!btn) return;
    var sync = function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      var use = btn.querySelector('use');
      if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
      btn.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
    };
    btn.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
      try { localStorage.setItem('sb-theme', dark ? 'light' : 'dark'); } catch (e) {}
      sync();
    });
    sync();
  }

  /* ============================ 5. 搜索框与快捷键 ============================ */
  function initSearchBoxes() {
    ['#q', '#hero-q'].forEach(function (sel) {
      var input = $(sel);
      if (!input) return;
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var q = input.value.trim();
        if (!q) return;
        location.href = base + '/search/?q=' + encodeURIComponent(q);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var box = $('#q') || $('#q-page');
      if (!box) return;
      e.preventDefault();
      box.focus();
      box.select();
    });
  }

  /* ============================ 6. 卡片渲染（搜索页用） ============================ */
  function skillCardHtml(s) {
    /* dz 已在构建期做过「skill 级 → 仓库级」回落；zr=1 表示这段中文是仓库简介而非 skill 专述 */
    var summary = s.dz || s.d;
    var mark = s.dz
      ? (s.zr ? '<span class="dot"></span><span title="该 skill 尚无单独撰写的中文摘要，此处展示所属仓库的简介">仓库简介</span>' : '')
      : '<span class="dot"></span><span>原文</span>';
    return '<a class="card" href="' + base + s.u + '">' +
      '<div class="card-title"><svg class="icon" aria-hidden="true"><use href="#i-box"></use></svg><span>' + esc(s.name) + '</span></div>' +
      '<div class="card-desc">' + esc(summary) + '</div>' +
      '<div class="card-meta">' +
        (s.tier === 'featured' ? '<span class="badge featured"><svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg>精选</span>' : '') +
        '<span>' + esc(s.o) + '/' + esc(s.n) + '</span><span class="dot"></span>' +
        '<span><svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg> ' + fmtNum(s.st) + '</span>' +
        mark +
      '</div>' +
      '<div class="card-meta">' + hostsOf(s).slice(0, 3).map(function (h) {
        return '<span class="badge host">' + esc(hostLabel(h)) + '</span>';
      }).join('') + '</div>' +
    '</a>';
  }

  /** 极简相关性打分：命中越多、越靠前字段权重越高 */
  function scoreSkill(s, terms) {
    var name = (s.name || '').toLowerCase();
    var zh = (s.dz || '').toLowerCase();
    var desc = (s.d || '').toLowerCase();
    var tg = (s.tg || []).join(' ').toLowerCase();
    var repo = (s.o + '/' + s.n).toLowerCase();
    var hosts = hostsOf(s).map(hostLabel).join(' ').toLowerCase();
    var cat = (s.cat || '').toLowerCase();
    var score = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (name.indexOf(t) >= 0) score += 12;
      if (zh.indexOf(t) >= 0) score += 8;
      if (tg.indexOf(t) >= 0) score += 6;
      if (desc.indexOf(t) >= 0) score += 4;
      if (cat.indexOf(t) >= 0) score += 3;
      if (hosts.indexOf(t) >= 0) score += 3;
      if (repo.indexOf(t) >= 0) score += 2;
    }
    return score;
  }

  function initSearchPage() {
    var input = $('#q-page');
    var list = $('#list');
    if (!input || !list) return;

    var q0 = new URLSearchParams(location.search).get('q') || '';
    input.value = q0;

    var timer = null;
    var render = function () {
      var raw = input.value.trim();
      var countEl = $('[data-count]');
      if (!raw) {
        list.innerHTML = '';
        if (countEl) countEl.textContent = '输入关键词开始搜索';
        return;
      }
      var terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
      var hits = [];
      for (var i = 0; i < D.skills.length; i++) {
        var sc = scoreSkill(D.skills[i], terms);
        if (sc > 0) hits.push({ s: D.skills[i], sc: sc });
      }
      hits.sort(function (a, b) { return b.sc - a.sc || b.s.q - a.s.q || b.s.st - a.s.st; });
      var top = hits.slice(0, 60);
      list.innerHTML = top.map(function (h) { return skillCardHtml(h.s); }).join('') ||
        '<p class="notice">没有匹配的 skill。换个关键词，或<a href="' + base + '/skills/">浏览全部</a>。</p>';
      if (countEl) {
        countEl.textContent = hits.length > top.length
          ? '找到 ' + hits.length + ' 个结果，显示前 ' + top.length + ' 个'
          : '找到 ' + hits.length + ' 个结果';
      }
      // 搜索页允许被分享，但用 replaceState 避免污染历史
      var url = location.pathname + (raw ? '?q=' + encodeURIComponent(raw) : '');
      history.replaceState(null, '', url);
    };

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(render, 140);
    });
    render();
    if (!q0) input.focus();
  }

  /* ============================ 7. 列表页筛选与排序 ============================ */
  function initListPage() {
    var list = $('#list');
    var sidebar = $('.sidebar');
    if (!list || !sidebar || !$('[data-f]')) return;

    var cards = $$('.card[data-repo]', list);
    if (!cards.length) return;

    var params = new URLSearchParams(location.search);
    var sortSel = $('#sort');
    var countEl = $('[data-count]');
    var pager = $('#list-pager');

    // 回填 URL 状态（单选组没有对应参数时保持预渲染的默认项，绝不乱勾）
    $$('[data-f]').forEach(function (el) {
      var name = el.getAttribute('data-f');
      var val = el.value;
      if (el.type === 'checkbox') {
        el.checked = (params.get(name) || '').split(',').indexOf(val) >= 0;
      } else {
        var p = params.get(name);
        if (p != null) el.checked = p === val;
      }
    });
    if (sortSel && params.get('sort')) sortSel.value = params.get('sort');

    var readFilters = function () {
      var f = { host: [], cat: [], nokey: false, nonet: false, stars: '0', fresh: '0' };
      $$('[data-f]').forEach(function (el) {
        var n = el.getAttribute('data-f');
        if (el.type === 'checkbox') {
          if (n === 'host' || n === 'cat') { if (el.checked) f[n].push(el.value); }
          else f[n] = el.checked;
        } else if (el.checked) {
          f[n] = el.value;
        }
      });
      return f;
    };

    var writeUrl = function (f, sort) {
      var p = new URLSearchParams();
      if (f.host.length) p.set('host', f.host.join(','));
      if (f.cat.length) p.set('cat', f.cat.join(','));
      if (f.nokey) p.set('nokey', '1');
      if (f.nonet) p.set('nonet', '1');
      if (f.stars && f.stars !== '0') p.set('stars', f.stars);
      if (f.fresh && f.fresh !== '0') p.set('fresh', f.fresh);
      if (sort && sort !== 'quality') p.set('sort', sort);
      var qs = p.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    };

    var apply = function () {
      var f = readFilters();
      var sort = sortSel ? sortSel.value : 'quality';
      var shown = 0;

      cards.forEach(function (c) {
        var hosts = (c.getAttribute('data-hosts') || '').split(',').filter(Boolean);
        var ok = true;
        if (f.host.length && !f.host.some(function (h) { return hosts.indexOf(h) >= 0; })) ok = false;
        if (ok && f.cat.length && f.cat.indexOf(c.getAttribute('data-cat')) < 0) ok = false;
        if (ok && f.nokey && c.getAttribute('data-key') === '1') ok = false;
        if (ok && f.nonet && c.getAttribute('data-net') === '1') ok = false;
        if (ok && Number(c.getAttribute('data-st') || 0) < Number(f.stars || 0)) ok = false;
        c.hidden = !ok;
        if (ok) shown++;
      });

      // 移动端折叠面板标题上的「已选条件数」徽章
      var mfc = $('.m-f-count');
      if (mfc) {
        var n = f.host.length + f.cat.length + (f.nokey ? 1 : 0) + (f.nonet ? 1 : 0) +
          (Number(f.stars) > 0 ? 1 : 0) + (Number(f.fresh) > 0 ? 1 : 0);
        mfc.hidden = !n;
        mfc.textContent = n;
      }

      // 有筛选条件时不做分页（已预渲染的卡片直接过滤），因此隐藏分页器
      var filtered = !!(f.host.length || f.cat.length || f.nokey || f.nonet || Number(f.stars) || Number(f.fresh));
      if (pager) pager.hidden = filtered;

      // 排序：只在未筛选时对当前页卡片重排（跨页排序属于构建期职责）
      if (!filtered && sort) {
        var key = {
          quality: function (c) { return -Number(c.getAttribute('data-q') || 0); },
          stars: function (c) { return -Number(c.getAttribute('data-st') || 0); },
          fresh: function (c) { return -Date.parse(c.getAttribute('data-at') || 0); },
          skills: function (c) { return -Number(c.getAttribute('data-sc') || 0); },
        }[sort];
        if (key) {
          cards.slice().sort(function (a, b) { return key(a) - key(b); }).forEach(function (c) { list.appendChild(c); });
        }
      }
      if (countEl) countEl.textContent = shown + ' 个结果';
      writeUrl(f, sort);
    };

    // 药丸选中态：原生控件在移动端不可见，用 label.on 表达（:has 之外的老浏览器兜底）
    var syncLabel = function (el) {
      var lab = el.closest('label');
      if (lab) lab.classList.toggle('on', el.checked);
    };
    $$('[data-f]').forEach(function (el) {
      syncLabel(el);
      el.addEventListener('change', function () { syncLabel(el); apply(); });
    });
    if (sortSel) sortSel.addEventListener('change', apply);
    var clear = $('#clear-filters');
    if (clear) clear.addEventListener('click', function () {
      $$('[data-f]').forEach(function (el) {
        if (el.type === 'checkbox') el.checked = false;
        else el.checked = el.value === '0';
        syncLabel(el);
      });
      apply();
    });

    apply();
  }

  /* ============================ 8. 安装方式 tabs ============================ */
  function initTabs() {
    $$('.tabs').forEach(function (group) {
      var tabs = $$('.tab', group);
      if (!tabs.length) return;
      tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
          var id = tab.getAttribute('data-tab');
          tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
          $$('.tabpanel').forEach(function (p) {
            if (p.getAttribute('data-panel') != null && tabs.some(function (t) { return t.getAttribute('data-tab') === p.getAttribute('data-panel'); })) {
              p.hidden = p.getAttribute('data-panel') !== id;
            }
          });
        });
      });
    });
  }

  /* ============================ 8.5 移动端筛选折叠 ============================
   * 预渲染 HTML 里 <details class="m-filters" open>（保证 SEO 与无 JS 可见），
   * 移动端默认收起为折叠面板，桌面端恒展开。 */
  function initMobileFilters() {
    var d = $('.m-filters');
    if (!d) return;
    var mq = window.matchMedia('(max-width: 760px)');
    var sync = function () {
      if (mq.matches) d.removeAttribute('open');
      else d.setAttribute('open', '');
    };
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);
    sync();
  }

  /* ============================ 9. 提交页联动 ============================ */
  function initSubmit() {
    var input = $('#sub-repo');
    var preview = $('#sub-preview');
    if (!input || !preview || !D.site) return;
    var link = $('#sub-link');
    var copyBtn = $('#sub-copy');
    var slug = 'owner__repo';
    var sync = function () {
      var v = input.value.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
      var m = v.match(/^([^\/\s]+)\/([^\/\s]+)$/);
      slug = m ? (m[1] + '__' + m[2]) : 'owner__repo';
      preview.textContent = 'submissions/' + slug + '.json';
      var url = 'https://github.com/' + D.site.repo + '/new/main?filename=submissions/' + slug + '.json';
      if (link) link.href = url + '&value=' + encodeURIComponent(JSON.stringify({ repo: v || 'owner/repo', note: '' }, null, 2));
      if (copyBtn) copyBtn.setAttribute('data-copy', m ? url : url);
    };
    input.addEventListener('input', sync);
    sync();
  }

  /* ============================ 10. 页脚数据时间 ============================ */
  function initSynced() {
    var el = $('[data-synced]');
    if (!el) return;
    var t = Date.parse((D.generatedAt || '').replace(/Z?$/, 'Z'));
    if (!Number.isFinite(t)) { el.textContent = '—'; return; }
    var d = new Date(t);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    el.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' UTC';
  }

  /* ============================ 启动 ============================ */
  /* ============================ 10. 详情页长描述展开/收起 ============================ */
  function initDescToggle() {
    $$('.desc-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var wrap = btn.closest('.desc-wrap');
        if (!wrap) return;
        var closed = wrap.classList.toggle('closed');
        btn.textContent = closed ? '展开全文' : '收起';
        btn.setAttribute('aria-expanded', String(!closed));
      });
    });
  }

  function boot() {
    initTheme();
    initSearchBoxes();
    wireCopy(document);
    initSearchPage();
    initListPage();
    initTabs();
    initMobileFilters();
    initDescToggle();
    initSubmit();
    initSynced();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
