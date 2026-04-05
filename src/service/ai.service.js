const { createOpenAI } = require('@ai-sdk/openai');
const { streamText, convertToModelMessages, generateText, Output, stepCountIs } = require('ai');
const { z } = require('zod');
const { ollamaBaseURL } = require('@/constants/urls');
const { AI_CAPABILITY, AI_LIMITS, DEFAULT_CHAT_MODEL, DEFAULT_COMPLETION_MODEL } = require('@/constants/ai');
const AiConstraintUtils = require('@/utils/AiConstraintUtils');

// 创建 Ollama 的 OpenAI 兼容实例
// 可以通过环境变量配置远程 Ollama 服务器
// 本地: http://localhost:11434/v1
// 远程(win本): http://192.168.3.10:11434/v1
const ollama = createOpenAI({
  baseURL: ollamaBaseURL,
  apiKey: 'ollama', // Ollama 不需要真实的 API key，但 SDK 要求提供
});

console.log(`Ollama 服务地址: ${ollamaBaseURL}`);

// ===================================================

class AiService {
  /**
   * 获取当前可用模型目录：请求 Ollama `/api/tags`，经白名单与 `AiConstraintUtils.buildModelCatalog` 格式化后写入短时缓存；
   * `resolveModel`、健康检查等都依赖此方法，避免重复打远端接口。
   */
  getModelCatalog = async (forceRefresh = false) => {
    const now = Date.now();
    // 缓存未过期且已有数据时直接返回，跳过后续 fetch（forceRefresh 为 true 时强制刷新，例如健康检查）
    if (!forceRefresh && AiConstraintUtils.modelCatalogCache.expiresAt > now && AiConstraintUtils.modelCatalogCache.models.length > 0) {
      return AiConstraintUtils.modelCatalogCache.models;
    }

    const baseUrl = ollamaBaseURL.replace('/v1', '');
    const res = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Health check failed with status: ${res.status}`);
    }

    const data = await res.json();
    const models = AiConstraintUtils.buildModelCatalog(data.models || []);
    AiConstraintUtils.modelCatalogCache.models = models;
    AiConstraintUtils.modelCatalogCache.expiresAt = now + AI_LIMITS.healthCacheTtlMs;
    return models;
  };

  // 所有实际调用前都经过这里做一次 allowlist 解析，避免前端随意透传模型名。
  resolveModel = async (requestedModel, fallbackModel) => {
    const models = await this.getModelCatalog();
    const allowedValues = models.map((item) => item.value);

    if (allowedValues.length === 0) {
      throw AiConstraintUtils.createAiError('当前没有可用的 AI 模型，请先在 Ollama 中拉取并启用模型', 'MODEL_UNAVAILABLE');
    }

    const resolvedModel = requestedModel || (allowedValues.includes(fallbackModel) ? fallbackModel : allowedValues[0]);
    if (!allowedValues.includes(resolvedModel)) {
      throw AiConstraintUtils.createAiError(`模型 "${resolvedModel}" 不在允许列表中，可选模型：${allowedValues.join(', ')}`, 'MODEL_NOT_ALLOWED');
    }

    return resolvedModel;
  };

  // 健康检查：测试 Ollama 服务是否可用
  checkHealth = async () => {
    try {
      const models = await this.getModelCatalog(true);
      console.log(`✅ [Health Check] Ollama is running, models: ${JSON.stringify(models)}`);
      return [models.length > 0, models];
    } catch (error) {
      console.warn(`⚠️ [Health Check] Ollama is not available:`, error.message);
      return [false, []];
    }
  };

  /**
   * 流式对话接口
   * @param {Array} messages - 消息历史 [{role: 'user', content: '...'}, ...]
   * @param {String} model - 模型名称, 默认为 qwen2.5:7b
   * @param {String} context - 文章内容上下文（可选）
   */
  streamChat = async (messages, model = DEFAULT_CHAT_MODEL, context = null) => {
    try {
      const resolvedModel = await this.resolveModel(model, DEFAULT_CHAT_MODEL);
      console.log(`\n🤖 [AI Request] 模型: ${resolvedModel}, 消息数: ${messages.length}`);
      const startTime = Date.now();
      const cleanContext = AiConstraintUtils.sanitizeArticleContext(context);
      const managedMessages = messages.length > AI_LIMITS.maxMessages ? messages.slice(-AI_LIMITS.maxMessages) : messages;
      const tools = AiConstraintUtils.buildArticleContextTool(cleanContext);

      // 先构造纯文本问答的默认链路，只有在显式开启工具模式时才追加 tools/stopWhen。
      const streamOptions = {
        model: ollama.chat(resolvedModel),
        system: AiConstraintUtils.buildSystemPrompt(cleanContext),
        messages: await convertToModelMessages(managedMessages),
        maxTokens: 4096,
      };

      if (tools) {
        streamOptions.tools = tools;
        streamOptions.stopWhen = stepCountIs(AI_LIMITS.maxToolSteps);
      }

      const result = await streamText(streamOptions);

      const endTime = Date.now();
      console.log(`✅ [AI Response] 请求完成, 耗时: ${endTime - startTime}ms`);

      // 直接返回 result 对象，让 Controller 处理响应流
      return result;
    } catch (error) {
      console.error('❌ [AI Service Error]', error);
      throw AiConstraintUtils.formatServiceError(error, model);
    }
  };

  /**
   * 编辑补全接口（非流式，快速响应）
   * @param {String} beforeText - 光标前文本（最多 500 字）
   * @param {String} afterText - 光标后文本（可选，最多 200 字）
   * @param {String} model - 模型名称
   * @param {Number} maxSuggestions - 建议数量（默认 3）
   * @returns {Promise<Array>} 补全建议数组
   */
  getCompletion = async (beforeText, afterText = '', model = DEFAULT_COMPLETION_MODEL, maxSuggestions = AI_LIMITS.maxSuggestions) => {
    try {
      const resolvedModel = await this.resolveModel(model, DEFAULT_COMPLETION_MODEL);
      console.log(`\n✏️ [AI Completion] 模型: ${resolvedModel}, 上文长度: ${beforeText.length}, 下文长度: ${afterText.length}`);
      const startTime = Date.now();

      let userPrompt = `你将基于上下文生成 ${maxSuggestions} 个续写建议。

上文内容：
"""
${beforeText}
"""`;

      if (afterText) {
        userPrompt += `

下文内容：
"""
${afterText}
"""`;
      }

      userPrompt += `

要求：
1. 每个建议都必须自然衔接上下文
2. 每个建议控制在 1-${AI_LIMITS.maxCompletionSuggestionChars} 个字符之间
3. 不要返回解释，只返回结构化字段`;

      // 用 schema 约束输出结构，避免再依赖“请严格返回 JSON”这类软约束。
      const completionSchema = z.object({
        suggestions: z.array(z.string().trim().min(1).max(AI_LIMITS.maxCompletionSuggestionChars)).min(1).max(maxSuggestions),
      });

      const result = await generateText({
        model: ollama.chat(resolvedModel),
        system: '你是一个写作补全助手，只输出可直接插入正文的续写建议。',
        prompt: userPrompt,
        output: Output.object({
          schema: completionSchema,
        }),
        maxTokens: 200,
      });

      const endTime = Date.now();
      console.log(`✅ [AI Completion] 请求完成, 耗时: ${endTime - startTime}ms`);

      return result.output.suggestions.slice(0, maxSuggestions).map((text, index) => ({
        id: String.fromCharCode(65 + index),
        text: text.trim(),
        type: AiConstraintUtils.classifySuggestionType(text.trim()),
      }));
    } catch (error) {
      console.error('❌ [AI Completion Error]', error);
      const serviceError = AiConstraintUtils.formatServiceError(error, model);
      if (serviceError.code === 'AI_SERVICE_ERROR') {
        serviceError.code = 'COMPLETION_ERROR';
        serviceError.message = 'AI 补全服务暂时不可用';
      }
      throw serviceError;
    }
  };
}

module.exports = new AiService();
