/**
 * 分类与宿主字典
 * ------------------------------------------------------------
 * 分类导语必须**手工撰写**（开发文档 §8.1：禁止自动生成拼词）——
 * 这些导语是分类页的主要收录正文，也是页面之间内容差异化的来源。
 */

export const CATEGORIES = {
  编码: { slug: 'code', icon: 'i-terminal', intro: '代码生成、重构、测试、审查、Git 操作类的 skill。把「读代码—改代码—验代码」这条链路上重复的动作固化下来，是 skill 生态里数量最多的一类。' },
  写作: { slug: 'writing', icon: 'i-book', intro: '文档撰写、翻译、文案润色、Markdown 排版类的 skill。多用于把零散素材整理成结构化成稿，或在不同语言、不同文体之间转换。' },
  研究: { slug: 'research', icon: 'i-search', intro: '资料检索、论文阅读、长文摘要、信息比对的 skill。特点是需要联网或读取大文件，输出以「提炼 + 出处」为主，而不是直接成稿。' },
  数据: { slug: 'data', icon: 'i-layers', intro: '表格处理、SQL 查询、数据清洗、图表生成、抓取与 ETL 类的 skill。通常要读写本地文件或连接数据库，使用时注意数据边界与权限。' },
  设计: { slug: 'design', icon: 'i-sparkles', intro: '界面设计、配色排版、图像处理、SVG 与品牌资产生成的 skill。输入多为自然语言描述或参考图，输出为可用的设计交付物。' },
  自动化: { slug: 'automation', icon: 'i-sliders', intro: '工作流编排、定时任务、浏览器操作、CI 集成类的 skill。这类 skill 会真实产生副作用，安装前建议先看清它调用了哪些外部命令。' },
  运维: { slug: 'ops', icon: 'i-shield', intro: '部署、容器、集群、监控、日志排查类的 skill。多数依赖外部命令（docker / kubectl / cloud CLI），对执行环境有明确要求。' },
  生活: { slug: 'life', icon: 'i-mail', intro: '日历、邮件、笔记、健康、出行、记账类的 skill。把日常工具接到 agent 上，属于「个人助理」方向，通常需要账号授权或 API Key。' },
  未分类: { slug: 'uncategorized', icon: 'i-info', intro: '尚未归入八大用途的 skill。多数是新仓库或描述过短，分类规则尚未覆盖 —— 这类占比超过 20% 时说明分类关键词需要补充。' },
};

export const HOSTS = {
  'claude-code': { label: 'Claude Code', icon: 'i-host-claude-code', intro: 'Anthropic 官方的命令行 agent，skill 生态的事实标准。识别信号是仓库里存在 .claude/skills/ 目录或 .claude-plugin/marketplace.json 插件清单。' },
  cursor: { label: 'Cursor', icon: 'i-host-cursor', intro: '基于 VS Code 的 AI 编辑器。除 SKILL.md 外，还会用 .cursor/rules/ 下的规则文件，因此带该目录的仓库会被标为 Cursor 兼容。' },
  cline: { label: 'Cline', icon: 'i-host-cline', intro: 'VS Code 里的自主编码 agent 扩展，用 .clinerules 承载规则。兼容 SKILL.md 规范的仓库一般也能直接使用。' },
  codex: { label: 'Codex CLI', icon: 'i-host-codex', intro: 'OpenAI 的命令行编码 agent，用 AGENTS.md 声明项目级指令。带 AGENTS.md 的仓库会被标为 Codex 兼容。' },
  mcp: { label: 'MCP 客户端', icon: 'i-host-mcp', intro: '任何支持 Model Context Protocol 的客户端。这类仓库提供的是可被调用的工具服务，而不是提示词型 skill，安装方式与纯 SKILL.md 不同。' },
  gemini: { label: 'Gemini CLI', icon: 'i-host-gemini', intro: 'Google 的命令行 agent，用 GEMINI.md 声明上下文。结构上贴近通用 SKILL.md 规范。' },
  windsurf: { label: 'Windsurf', icon: 'i-host-windsurf', intro: 'Codeium 出品的 AI IDE，用 .windsurf/rules 承载规则，同样接受 SKILL.md 形态的能力包。' },
  generic: { label: '通用', icon: 'i-host-generic', intro: '只包含标准 SKILL.md、没有绑定任何特定客户端信号的仓库。理论上任何支持 SKILL.md 规范的客户端都能加载，是最可移植的一类。' },
};

/** 宿主 id 本身就是 URL slug（claude-code / cursor / ...），补进返回值以免页面链接变成 /h/undefined/ */
export const hostMeta = (h) => (HOSTS[h] ? { ...HOSTS[h], slug: h } : { label: h, icon: 'i-host-generic', slug: slugHost(h), intro: '' });
export const catMeta = (c) => CATEGORIES[c] || { ...CATEGORIES['未分类'], label: c };

function slugHost(h) {
  return String(h).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** 宿主 URL slug（与 inferHosts 的键一一对应） */
export const hostSlug = (h) => (HOSTS[h] ? h : slugHost(h));

/** 未分类之外的分类顺序（用于首页宫格与导航） */
export const CATEGORY_ORDER = ['编码', '写作', '研究', '数据', '设计', '自动化', '运维', '生活'];

/** 宿主展示顺序 */
export const HOST_ORDER = ['claude-code', 'cursor', 'cline', 'codex', 'mcp', 'gemini', 'windsurf', 'generic'];
