/**
 * 质量评分（纯函数，可单测）
 * ------------------------------------------------------------
 * 见开发文档 §7.1：
 *   score = 3.0 * 热度(stars 对数封顶)
 *         + 2.5 * 新鲜度(pushedAt)
 *         + 2.5 * 完整度(frontmatter)
 *         + 1.5 * skill 数合理性
 *         + 0.5 * 官方加权
 * 五项权重合计恰为 10，故结果天然落在 0~10，四舍五入 1 位小数。
 */
const DAY = 86400000;

export function freshnessScore(pushedAt, now = Date.now()) {
  const t = Date.parse(pushedAt);
  if (!Number.isFinite(t)) return 0;
  const months = (now - t) / (30.44 * DAY);
  if (months <= 6) return 1;
  if (months >= 24) return 0;
  return 1 - (months - 6) / 18;
}

export function starsScore(stars) {
  const s = Math.max(0, Number(stars) || 0);
  return Math.min(1, Math.log10(s + 1) / 3.5);
}

/** frontmatter 完整度：name / description / license / version / allowedTools 各 0.2 */
export function completenessScore(skill) {
  let c = 0;
  if (skill.name) c += 0.2;
  if (skill.desc && skill.desc.length >= 20) c += 0.2;
  if (skill.license) c += 0.2;
  if (skill.version) c += 0.2;
  if (Array.isArray(skill.allowedTools) && skill.allowedTools.length) c += 0.2;
  return c;
}

/** skill 数合理性：1~20 满分；>50 或「=1 且无 README」递减 */
export function skillCountScore(n, hasReadme) {
  if (!n || n <= 0) return 0;
  if (n === 1) return hasReadme ? 1 : 0.6;
  if (n <= 20) return 1;
  if (n <= 50) return 1 - ((n - 20) / 30) * 0.4;
  return 0.5;
}

/**
 * @returns {{score:number, tier:'featured'|'standard'|'watch', parts:object}}
 */
export function computeQuality({ stars, pushedAt, skills = [], hasReadme = false, official = false, weights, tiers, now = Date.now() }) {
  const W = weights || { stars: 3.0, freshness: 2.5, completeness: 2.5, skillCount: 1.5, official: 0.5 };
  const T = tiers || { featured: 7.5, standard: 5.0 };

  const sStars = starsScore(stars);
  const sFresh = freshnessScore(pushedAt, now);

  const list = skills.slice(0, 20);
  const sComplete = list.length
    ? list.reduce((a, s) => a + completenessScore(s), 0) / list.length
    : 0;

  const sCount = skillCountScore(skills.length, hasReadme);

  const raw =
    W.stars * sStars +
    W.freshness * sFresh +
    W.completeness * sComplete +
    W.skillCount * sCount +
    W.official * (official ? 1 : 0);

  const score = Math.round(Math.max(0, Math.min(10, raw)) * 10) / 10;
  const tier = score >= T.featured ? 'featured' : score >= T.standard ? 'standard' : 'watch';

  return {
    score,
    tier,
    parts: {
      stars: +(W.stars * sStars).toFixed(2),
      freshness: +(W.freshness * sFresh).toFixed(2),
      completeness: +(W.completeness * sComplete).toFixed(2),
      skillCount: +(W.skillCount * sCount).toFixed(2),
      official: +(W.official * (official ? 1 : 0)).toFixed(2),
    },
  };
}
