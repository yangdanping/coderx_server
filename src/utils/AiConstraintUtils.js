const { tool } = require('ai');
const { z } = require('zod');
const { ollamaBaseURL } = require('@/constants/urls');
const { AI_ALLOWED_MODELS, AI_CAPABILITY, AI_LIMITS } = require('@/constants/ai');
const Utils = require('@/utils');

// ================= 「Prompt 引导 + 系统约束」配套：模型目录缓存/白名单、上下文截断、系统提示、可选只读工具、统一错误 =============================
class AiConstraintUtils {
  // 模型列表做短时缓存，避免每次请求都先打一遍 /api/tags。
  static modelCatalogCache = {
    expiresAt: 0,
    models: [],
  };

  // 将 Ollama /api/tags 返回的条目过滤白名单并映射为下拉用的 { name, value }，按修改时间排序。
  static buildModelCatalog = (models = []) =>
    models
      .filter((item) => item?.model)
      .filter((item) => AI_ALLOWED_MODELS.length === 0 || AI_ALLOWED_MODELS.includes(item.model))
      .toSorted((a, b) => new Date(a.modified_at) - new Date(b.modified_at))
      .map(({ model }) => ({
        name: model.split(':')[0],
        value: model,
      }));

  // 清洗并截断文章正文，避免注入模型的上下文超过上限。
  static sanitizeArticleContext = (context) => {
    if (!context) return '';

    const cleanContext = Utils.cleanTextForAI(context);
    if (cleanContext.length <= AI_LIMITS.maxContextLength) {
      return cleanContext;
    }

    return `${cleanContext.substring(0, AI_LIMITS.maxContextLength)}\n[文章内容过长，已截断]`;
  };

  // 组装系统提示词：声明助手边界、注入文章与可选只读工具说明；风格由 prompt 引导，硬约束由白名单/schema/限流承担。
  static buildSystemPrompt = (cleanContext) => {
    let systemPrompt = `你是 CoderX 的 AI 助手，不是会执行站内写操作的自治 Agent。
你的职责是解释代码、总结文章、辅助问答和提供写作建议。
请优先给出准确、克制、可验证的回答；如果信息不足，要明确说明不确定。`;

    if (cleanContext) {
      systemPrompt += `\n\n当前文章内容：\n${cleanContext}\n\n请优先基于这篇文章的内容回答用户问题。`;
    }

    if (AI_CAPABILITY.supportsTools) {
      systemPrompt += '\n\n如有必要，你可以调用只读工具辅助检索文章上下文，但不要编造未检索到的事实。';
    }

    return systemPrompt;
  };

  // 按关键词在段落中出现的次数打分，供文章内检索工具对段落排序。
  static scoreParagraph = (paragraph, keywords) => {
    if (!paragraph) return 0;
    return keywords.reduce((score, keyword) => {
      if (!keyword) return score;
      return paragraph.toLowerCase().includes(keyword) ? score + 1 : score;
    }, 0);
  };

  // 可选：向模型暴露仅在当前文章段落中检索的只读工具（默认关闭），不暴露业务写接口。
  static buildArticleContextTool = (cleanContext) => {
    if (!AI_CAPABILITY.supportsTools || !cleanContext) return undefined;

    const paragraphs = cleanContext
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .slice(0, 80);

    if (paragraphs.length === 0) return undefined;

    return {
      searchArticleContext: tool({
        description: '在当前文章上下文中检索与问题最相关的段落，只读，不执行写操作。',
        inputSchema: z.object({
          query: z.string().min(1).max(200).describe('需要检索的主题或问题'),
        }),
        execute: async ({ query }) => {
          const keywords = query
            .toLowerCase()
            .split(/[\s,，。！？;；:：]+/)
            .map((item) => item.trim())
            .filter((item) => item.length >= 2)
            .slice(0, 8);

          const ranked = paragraphs
            .map((paragraph) => ({
              paragraph,
              score: AiConstraintUtils.scoreParagraph(paragraph, keywords),
            }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((item) => item.paragraph);

          return {
            matched: ranked.length,
            excerpts: ranked.length > 0 ? ranked : paragraphs.slice(0, 2),
          };
        },
      }),
    };
  };

  // 按补全文本长度粗分为词/短语/句子，供结构化输出字段使用。
  static classifySuggestionType = (text) => {
    if (text.length <= 5) return 'word';
    if (text.length <= 15) return 'phrase';
    return 'sentence';
  };

  // 创建带业务错误码与原始错误的 Error，便于控制器统一识别。
  static createAiError = (message, code, originalError) => {
    const customError = new Error(message);
    customError.code = code;
    customError.originalError = originalError;
    return customError;
  };

  // 将 SDK/网络层异常映射为用户可读文案与稳定错误码（连接、超时、模型等）。
  static formatServiceError = (error, model) => {
    if (error.code) return error;

    let errorMessage = 'AI 服务暂时不可用';
    let errorCode = 'AI_SERVICE_ERROR';

    if (error.message.includes('ECONNREFUSED') || error.message.includes('connect')) {
      errorMessage = `AI 服务器连接失败 (${ollamaBaseURL})。请检查：1. Ollama 是否正在运行？2. 网络连接是否正常？3. 服务器地址是否正确？`;
      errorCode = 'CONNECTION_REFUSED';
    } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
      errorMessage = 'AI 服务器响应超时，请检查网络连接或稍后重试';
      errorCode = 'TIMEOUT';
    } else if (error.message.includes('ENOTFOUND')) {
      errorMessage = `无法解析 AI 服务器地址 (${ollamaBaseURL})，请检查配置`;
      errorCode = 'HOST_NOT_FOUND';
    } else if (error.message.includes('model')) {
      errorMessage = `模型 "${model}" 不可用，请先检查 Ollama 模型列表`;
      errorCode = 'MODEL_NOT_FOUND';
    }

    return AiConstraintUtils.createAiError(errorMessage, errorCode, error.message);
  };
}

module.exports = AiConstraintUtils;
