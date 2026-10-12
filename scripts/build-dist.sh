#!/usr/bin/env bash
# ============================================================
# SkillsBin — 构建 Cloudflare Pages 发布产物 dist/
# ------------------------------------------------------------
# 被 deploy.yml 与 sync.yml 的发布作业共同调用，避免两处逻辑漂移。
#
# 与 GetHub 的差异：本站是**构建期预渲染**（无客户端路由），
# dist/ 的全部 HTML 由 scripts/prerender.mjs 一次性生成，
# 本脚本只负责：跑预渲染 → 泄密检查 → 硬闸门 → 内容指纹。
#
# 硬闸门（开发文档 §3.4，prerender 与本脚本双重断言）：
#   · 单文件 ≤ 25 MiB
#   · 文件总数 ≤ 20000（Cloudflare Pages 单次部署上限）
#   · HTML 页面数 ≤ prerender.maxPages（config.json，默认 18000）
#
# 用法：bash scripts/build-dist.sh
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
NODE_BIN="${NODE_BIN:-node}"

echo "▶ 预渲染 dist/ ..."
# 先清空产物：预渲染只写不删，若某 skill 下架或改 slug，旧 HTML 会留在 dist 里一起发布（幽灵页面）。
# CI 是全新 checkout、dist 从一开始就不存在，这一行主要服务本地增量构建；
# 个别受限环境会拒绝批量删除，失败不阻塞（预渲染会覆盖同名文件）。
rm -rf dist 2>/dev/null || true
"$NODE_BIN" scripts/prerender.mjs

# ---- 泄密检查：源码 / 配置 / 凭据 / 工作流不得进入产物 ----
LEAKED=0
for p in dist/crawler dist/.github dist/.deploy.env dist/.workbuddy dist/.git dist/scripts dist/docs dist/data/skills dist/submissions dist/secrets; do
  if [ -e "$p" ]; then
    echo "LEAK! $p" >&2
    LEAKED=1
  fi
done
# .deploy.env 的内容也可能被误拷进其它文件，抽查关键字段名
if grep -rl "GITHUB_TOKEN=\|CLOUDFLARE_API_TOKEN=" dist 2>/dev/null | head -3 | grep -q .; then
  echo "LEAK! 产物中出现凭据字段名" >&2
  LEAKED=1
fi
[ "$LEAKED" -eq 0 ] || { echo "❌ 产物包含非站点文件，已中止发布" >&2; exit 1; }

# ---- 体积守卫：Cloudflare Pages 限制单文件 25 MiB、单次部署 20000 文件 ----
TOO_BIG="$(find dist -type f -size +25M -print || true)"
if [ -n "$TOO_BIG" ]; then
  echo "❌ 以下文件超过 Cloudflare Pages 单文件 25 MiB 上限：" >&2
  # shellcheck disable=SC2086
  ls -lh $TOO_BIG >&2
  exit 1
fi

COUNT="$(find dist -type f | wc -l | tr -d ' ')"

# ---- 静态资源内容指纹 ----
# gethub.cn 同款问题：zone 级「Browser Cache TTL」会把 /assets/*.js|.css 的
# Cache-Control 统一改写成 max-age=14400，只靠 _headers 压不住这个 4 小时窗口。
# 用内容哈希查询串彻底绕开：内容变了 URL 就变；没变则沿用旧 URL，缓存照旧生效。
# 注意要改写**全部 HTML**（每页都引这三个资源），不只是首页。
hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-12
  else shasum -a 256 "$1" | cut -c1-12; fi
}
declare -a FINGERPRINTED=()
for f in assets/css/style.css assets/js/app.js assets/js/data.js; do
  [ -f "dist/$f" ] || continue
  h="$(hash_of "dist/$f")"
  find dist -name '*.html' -type f -print0 | xargs -0 perl -pi -e "s{\Q$f\E(?:\\?v=[0-9a-f]+)?}{$f?v=$h}g"
  FINGERPRINTED+=("$f?v=$h")
done
if [ "${#FINGERPRINTED[@]}" -gt 0 ]; then
  echo "🔖 已为静态资源注入内容指纹（绕过 zone 级 4 小时缓存重写）"
  printf '   %s\n' "${FINGERPRINTED[@]}"
fi

if [ "$COUNT" -gt 20000 ]; then
  echo "❌ 产物文件数 $COUNT 超过 Cloudflare Pages 单次部署 20000 个上限" >&2
  exit 1
fi

echo "✅ 站点产物就绪: ${COUNT} 个文件 / $(du -sh dist | cut -f1)"
