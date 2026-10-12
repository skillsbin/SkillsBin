/**
 * GitHub REST 客户端（裸 fetch，零依赖）
 * ------------------------------------------------------------
 * 承载开发文档 §6.3 的「配额治理三护栏」：
 *   1. 主动刹车  —— 请求数达 requestBudget 或剩余跌破 reserveQuota 时立即收尾落盘（不是撞 403 干等）
 *   2. 断点续采  —— 由调用方把 cursor 写进 sync-state.json
 *   3. 刷新周期  —— refreshHours > cron 间隔，由调用方判断
 *
 * 关键细节：
 *   · 只跟踪 `x-ratelimit-resource === 'core'` 的额度。搜索是独立桶（30/min），
 *     混算会让 remaining 恒小于预留额度，导致发现层一上来就被误刹车（GetHub 踩过）。
 *   · 绝不信任 /rate_limit 的启动快照（会被代理/CDN 缓存），一律以响应头为准。
 *
 * 取文件正文（开发文档 §6.1 的 S3）：
 *   · 首选 raw.githubusercontent.com —— **不计 API 配额**，生产（GitHub Actions）走这条
 *   · 国内网络下 raw 常被阻断（连接超时），回落 `GET /repos/:o/:r/contents/:path` + Accept: raw
 *     —— 每次多花 1 核心配额，但换来「本地也能采」。策略自动探测，无需人工切换。
 */
const GH = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GhClient {
  constructor({
    token,
    requestDelayMs = 120,
    timeoutMs = 20000,
    retries = 3,
    requestBudget = 4200,
    reserveQuota = 250,
    minRemainingQuota = 40,
    maxWaitMin = 15,
    log = () => {},
  } = {}) {
    this.token = token;
    this.opts = { requestDelayMs, timeoutMs, retries, requestBudget, reserveQuota, minRemainingQuota, maxWaitMin, log };
    this.requests = 0;
    this.coreRemaining = null;
    this.coreLimit = null;
    this.resetAt = null;
    this.startedAt = Date.now();
    this.errors = [];
    this.rateLimitWaits = 0;
  }

  get elapsedMin() {
    return (Date.now() - this.startedAt) / 60000;
  }

  /** 允许 CLI 覆盖墙钟上限（本机长跑用；CI 保持 config 默认） */
  setMaxWait(min) {
    if (Number.isFinite(min) && min > 0) this.opts.maxWaitMin = min;
  }

  /** 三护栏 + 墙钟上限，任一条命中即返回原因字符串 */
  stopReason() {
    const { requestBudget, reserveQuota, minRemainingQuota, maxWaitMin } = this.opts;
    if (this.requests >= requestBudget) return `请求数达预算上限 ${requestBudget}`;
    if (this.coreRemaining != null && this.coreRemaining <= reserveQuota) {
      return `核心配额剩余 ${this.coreRemaining} ≤ 保命预留 ${reserveQuota}`;
    }
    if (this.coreRemaining != null && this.coreRemaining <= minRemainingQuota) {
      return `核心配额剩余 ${this.coreRemaining} ≤ 水位 ${minRemainingQuota}`;
    }
    if (this.elapsedMin >= maxWaitMin) return `本轮墙钟已达 ${maxWaitMin} 分钟`;
    return null;
  }

  /**
   * @param {string} path  以 / 开头走 api.github.com，以 http 开头则原样请求
   * @param {{search?:boolean, allow404?:boolean, as?:'json'|'text', accept?:string, noThrottle?:boolean, timeoutMs?:number}} o
   */
  async get(path, { search = false, allow404 = false, as = 'json', accept = null, noThrottle = false, timeoutMs = null } = {}) {
    const url = path.startsWith('http') ? path : `${GH}${path}`;
    let lastErr = null;

    for (let attempt = 1; attempt <= this.opts.retries; attempt++) {
      if (!noThrottle) await sleep(this.opts.requestDelayMs + Math.random() * 60);
      this.requests++;
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: accept || 'application/vnd.github+json',
            'User-Agent': 'skillsbin-crawler',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(timeoutMs || this.opts.timeoutMs),
        });

        // 只跟 core 桶，search 桶独立不参与刹车计算
        const resource = res.headers.get('x-ratelimit-resource');
        const remaining = res.headers.get('x-ratelimit-remaining');
        const limit = res.headers.get('x-ratelimit-limit');
        const reset = res.headers.get('x-ratelimit-reset');
        if (resource === 'core' && remaining != null) {
          this.coreRemaining = Number(remaining);
          this.coreLimit = limit != null ? Number(limit) : this.coreLimit;
          this.resetAt = reset != null ? new Date(Number(reset) * 1000).toISOString() : this.resetAt;
        }

        if (res.status === 404 && allow404) return { status: 404, data: null, text: null, headers: res.headers };
        if (res.ok) {
          if (as === 'text') {
            return { status: res.status, data: null, text: await res.text(), headers: res.headers };
          }
          // ⚠️ 不能写 .catch(() => null)：大响应（如 35k 条文件树 ≈ 9 MB）被超时截断时
          // JSON 解析会抛错，若吞掉就变成「200 + 空数据」，调用方会误判成「仓库没有 SKILL.md」。
          let data;
          try {
            data = await res.json();
          } catch (e) {
            lastErr = new Error(`响应 JSON 解析失败(可能被截断) ${e.message}`);
            this.errors.push({ path, message: lastErr.message });
            await sleep(Math.min(2 ** attempt * 400, 5000));
            continue;
          }
          return { status: res.status, data, text: null, headers: res.headers };
        }

        if (res.status === 403 || res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          if (search && this.coreRemaining == null) {
            // 搜索桶限流：等 60s 后重试（不消耗 core 预算判断）
            lastErr = new Error(`search rate limited (${res.status})`);
            await sleep(Math.min(60000, (retryAfter || 60) * 1000));
            this.rateLimitWaits++;
            continue;
          }
          if (this.coreRemaining != null && this.coreRemaining <= this.opts.reserveQuota) {
            return { status: 403, data: null, text: null, headers: res.headers, budgetStop: true };
          }
          const waitMs = Math.min((retryAfter || 2 ** attempt) * 1000, 15000);
          lastErr = new Error(`HTTP ${res.status}`);
          await sleep(waitMs);
          continue;
        }

        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(Math.min(2 ** attempt * 400, 5000));
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(2 ** attempt * 400, 5000));
      }
    }

    this.errors.push({ path, message: lastErr?.message || 'unknown' });
    return { status: 0, data: null, text: null, error: lastErr?.message || 'unknown' };
  }

  /** 搜索接口（独立配额桶） */
  search(path) {
    return this.get(path, { search: true });
  }

  /** 取纯文本（Contents API + Accept: raw）—— 每文件消耗 1 核心配额 */
  getText(path, o = {}) {
    return this.get(path, { ...o, as: 'text', accept: 'application/vnd.github.raw' });
  }
}

/** raw.githubusercontent.com 取正文：不计 API 配额（开发文档 §6.1 的关键优化） */
export async function fetchRaw(owner, repo, ref, path, { timeoutMs = 20000 } = {}) {
  const url = `${RAW_HOST}/${owner}/${repo}/${ref}/${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'skillsbin-crawler' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, error: e.cause?.message || e.message };
  }
}

/**
 * 内容获取器：自动在 raw / Contents API 之间选路。
 *   · strategy 未定时先试 raw；连续失败到阈值即锁定 Contents API（避免每个文件都白等一次超时）
 *   · 生产环境（Actions）raw 一次就通，全程 0 配额
 */
export class ContentFetcher {
  constructor({ gh, token, rawTimeoutMs = 8000, failThreshold = 3, log = () => {} } = {}) {
    this.gh = gh;
    this.token = token;
    this.rawTimeoutMs = rawTimeoutMs;
    this.failThreshold = failThreshold;
    this.log = log;
    this.strategy = null; // null | 'raw' | 'contents-api'
    this.rawFails = 0;
    this.via = { raw: 0, 'contents-api': 0 };
  }

  /** 强制策略（--content-via raw|api） */
  force(strategy) {
    if (strategy === 'raw' || strategy === 'api') {
      this.strategy = strategy === 'api' ? 'contents-api' : 'raw';
    }
  }

  /** 预热探测：拿一个已知小文件试 raw，失败即锁定 Contents API */
  async warmup(owner, repo, ref, path) {
    if (this.strategy) return this.strategy;
    const r = await fetchRaw(owner, repo, ref, path, { timeoutMs: this.rawTimeoutMs });
    if (r.ok) {
      this.strategy = 'raw';
    } else {
      this.strategy = 'contents-api';
      this.log(`  ⓘ raw.githubusercontent.com 不可达（${r.error || r.status}）→ 本轮改用 Contents API 取正文（每文件 +1 配额）`);
    }
    return this.strategy;
  }

  async fetch(owner, repo, ref, path) {
    if (this.strategy !== 'contents-api') {
      const r = await fetchRaw(owner, repo, ref, path, { timeoutMs: this.rawTimeoutMs });
      if (r.ok) {
        this.via.raw++;
        if (!this.strategy) this.strategy = 'raw';
        return { ok: true, text: r.text, via: 'raw' };
      }
      this.rawFails++;
      if (this.strategy === 'raw' || (!this.strategy && this.rawFails >= this.failThreshold)) {
        this.strategy = 'contents-api';
        this.log(`  ⓘ raw 连续失败 ${this.rawFails} 次 → 切换 Contents API 取正文`);
      }
      if (this.strategy !== 'contents-api') return { ok: false, status: r.status, error: r.error };
    }

    // Contents API 回落：1 核心配额/文件
    const res = await this.gh.getText(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
      allow404: true,
    });
    if (res.text != null && res.status === 200) {
      this.via['contents-api']++;
      return { ok: true, text: res.text, via: 'contents-api' };
    }
    return { ok: false, status: res.status, error: res.error };
  }
}

/** 有界并发池（保持输入顺序） */
export async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}
