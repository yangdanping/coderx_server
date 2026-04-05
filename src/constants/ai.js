const DEFAULT_CHAT_MODEL = 'qwen2.5:7b';
const DEFAULT_COMPLETION_MODEL = DEFAULT_CHAT_MODEL;

const parseBoolean = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

// 这里统一用 Object.freeze，是为了把 AI 规则当成只读配置，避免运行时被意外改写导致前后端约束漂移。
// 这组常量统一描述当前 AI 功能的产品边界，避免前后端各自写死一套规则。
const AI_CAPABILITY = Object.freeze({
  type: 'assistant',
  label: 'AI 助手',
  supportsTools: parseBoolean(process.env.AI_ENABLE_TOOLS),
  scopes: Object.freeze(['article_qa', 'writing_completion']),
});

// 所有输入边界集中放在这里，便于 controller/service 复用同一套硬约束。
const AI_LIMITS = Object.freeze({
  healthCacheTtlMs: 30 * 1000, // 健康检查里模型列表缓存有效期，避免频繁请求 Ollama /api/tags
  maxModelNameLength: 100, // 请求体里 model 字段最大长度，防止异常长字符串
  maxMessages: 20, // 进入模型前最多保留最近若干条消息（service 里 slice 截断）
  maxRequestMessages: 40, // 单次聊天请求 messages 数组最多条数
  maxMessageTextLength: 4000, // 单条消息（压平后的文本）最大字符数
  maxTotalMessageChars: 20000, // 单次请求所有消息文本合计最大字符数
  maxContextLength: 50000, // 注入 system 的文章正文清洗、截断后最大字符数（进模型前）
  maxRawContextLength: 120000, // 请求里 context 原始字符串最大长度（清洗前，controller 校验）
  maxCompletionBefore: 500, // 补全传给模型的光标前文本最大字符数（截断后）
  maxCompletionAfter: 200, // 补全传给模型的光标后文本最大字符数（截断后）
  maxCompletionBeforeRaw: 2000, // 补全请求 beforeText 最大长度（校验用，截断前）
  maxCompletionAfterRaw: 1000, // 补全请求 afterText 最大长度（校验用，截断前）
  maxSuggestions: 3, // 单次补全最多返回几条建议
  maxCompletionSuggestionChars: 30, // 单条补全建议文本最大字符数
  maxToolSteps: 3, // 开启工具时模型最多允许的 tool 步数（与 stream 配置一致）
});

// 访问策略显式化后，前端健康检查就能直接感知“游客可用/仅登录可用”的业务边界。
const AI_ACCESS_POLICY = Object.freeze({
  chat: Object.freeze({
    allowGuest: true,
    description: '文章问答助手，支持游客访问',
  }),
  completion: Object.freeze({
    allowGuest: false,
    description: '编辑补全仅限登录用户使用',
  }),
});

// 聊天和补全的调用频率分开控制，避免高频补全挤占问答资源。
const AI_RATE_LIMITS = Object.freeze({
  chat: Object.freeze({
    windowMs: 60 * 1000,
    maxRequests: 12,
  }),
  completion: Object.freeze({
    windowMs: 60 * 1000,
    maxRequests: 30,
  }),
});

// 通过环境变量做模型 allowlist，避免请求方随意指定服务端未认可的模型。
const AI_ALLOWED_MODELS = Object.freeze(parseCsv(process.env.AI_ALLOWED_MODELS));

module.exports = {
  AI_CAPABILITY,
  AI_LIMITS,
  AI_ACCESS_POLICY,
  AI_RATE_LIMITS,
  AI_ALLOWED_MODELS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_COMPLETION_MODEL,
};
