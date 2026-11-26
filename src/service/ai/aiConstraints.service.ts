import { tool } from 'ai';
import { z } from 'zod';
import { AI_LIMITS } from '../../constants/ai.js';
export type ModelEntry = { name: string; value: string };
export type RawModel = { model: string; modified_at: string };
export type AiError = Error & { code?: string; originalError?: unknown };
type Selection = { id: string; text: string; truncated: boolean; note: string };
export function cleanTextForAI(value: unknown): string {
  if (!value) return '';
  return String(value).replace(/<\/(p|div|h\d|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
}
const SENTENCE_END_RE = /(?:[。！？!?.;；]+["'”’）)\]]*|\n+)/g;
const HEAD_TAIL_OMISSION = '[中间内容过长，已省略]';

// ================= 「Prompt 引导 + 系统约束」配套：模型目录缓存/白名单、上下文截断、系统提示、可选只读工具、统一错误 =============================
export function createAiConstraints({ baseURL: ollamaBaseURL, allowedModels: AI_ALLOWED_MODELS, supportsTools }: { baseURL: string; allowedModels: readonly string[]; supportsTools: boolean }) {
class AiConstraintUtils {
  // 模型列表做短时缓存，避免每次请求都先打一遍 /api/tags。
  static modelCatalogCache = {
    expiresAt: 0,
    models: [] as ModelEntry[],
  };

  // 将 Ollama /api/tags 返回的条目过滤白名单并映射为下拉用的 { name, value }，按修改时间排序。
  static buildModelCatalog = (models: RawModel[] = []) =>
    models
      .filter((item) => item?.model)
      .filter((item) => AI_ALLOWED_MODELS.length === 0 || AI_ALLOWED_MODELS.includes(item.model))
      .sort((a, b) => new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime())
      .map(({ model }) => ({
        name: model.split(':')[0],
        value: model,
      }));

  static findBoundaryBefore = (text: string, limit: number, minLength = 0) => {
    if (limit >= text.length) return text.length;

    let match;
    let best = -1;
    SENTENCE_END_RE.lastIndex = 0;
    while ((match = SENTENCE_END_RE.exec(text)) !== null) {
      const boundary = match.index + match[0].length;
      if (boundary > limit) break;
      if (boundary >= minLength) {
        best = boundary;
      }
    }
    SENTENCE_END_RE.lastIndex = 0;

    return best;
  };

  static findBoundaryAfter = (text: string, index: number, maxStart: number) => {
    let match;
    SENTENCE_END_RE.lastIndex = 0;
    while ((match = SENTENCE_END_RE.exec(text)) !== null) {
      const boundary = match.index + match[0].length;
      if (boundary >= index && boundary <= maxStart) {
        SENTENCE_END_RE.lastIndex = 0;
        return boundary;
      }
      if (boundary > maxStart) break;
    }
    SENTENCE_END_RE.lastIndex = 0;

    return -1;
  };

  static sliceHeadBySemanticBoundary = (text: string, maxLength: number) => {
    const minLength = Math.floor(maxLength * 0.45);
    const boundary = AiConstraintUtils.findBoundaryBefore(text, maxLength, minLength);
    return (boundary > 0 ? text.slice(0, boundary) : text.slice(0, maxLength)).trim();
  };

  static sliceTailBySemanticBoundary = (text: string, maxLength: number) => {
    const targetStart = Math.max(0, text.length - maxLength);
    const maxStart = Math.min(text.length - 1, targetStart + Math.floor(maxLength * 0.55));
    const boundary = AiConstraintUtils.findBoundaryAfter(text, targetStart, maxStart);
    return (boundary > 0 ? text.slice(boundary) : text.slice(targetStart)).trim();
  };

  static truncateTextBySemanticBoundary = (text: string, maxLength: number, options: { mode?: string } = {}) => {
    const cleanText = String(text || '').trim();
    const mode = options.mode || 'head';

    if (!cleanText || cleanText.length <= maxLength) {
      return {
        text: cleanText,
        truncated: false,
        note: '',
      };
    }

    if (mode === 'head-tail') {
      const markerBudget = HEAD_TAIL_OMISSION.length + 2;
      const contentBudget = Math.max(20, maxLength - markerBudget);
      const headBudget = Math.max(8, Math.floor(contentBudget / 2));
      const tailBudget = Math.max(8, contentBudget - headBudget);
      const head = AiConstraintUtils.sliceHeadBySemanticBoundary(cleanText, headBudget);
      const tail = AiConstraintUtils.sliceTailBySemanticBoundary(cleanText, tailBudget);

      return {
        text: `${head}\n${HEAD_TAIL_OMISSION}\n${tail}`.trim(),
        truncated: true,
        note: '已保留划词片段的开头和结尾，并按语义边界省略中间内容',
      };
    }

    return {
      text: AiConstraintUtils.sliceHeadBySemanticBoundary(cleanText, maxLength),
      truncated: true,
      note: '内容过长，已按语义边界截断',
    };
  };

  // 清洗并截断文章正文，避免注入模型的上下文超过上限。
  static sanitizeArticleContext = (context: unknown) => {
    if (!context) return '';

    const cleanContext = cleanTextForAI(context);
    if (cleanContext.length <= AI_LIMITS.maxContextLength) {
      return cleanContext;
    }

    const result = AiConstraintUtils.truncateTextBySemanticBoundary(cleanContext, AI_LIMITS.maxContextLength, { mode: 'head' });
    return `${result.text}\n[文章内容过长，${result.note}]`;
  };

  static getSelectionContextText = (context: unknown) => {
    if (typeof context === 'string') return context;
    if (context && typeof context === 'object' && 'text' in context && typeof context.text === 'string') return context.text;
    return '';
  };

  static sanitizeSelectionContexts = (selectionContexts: unknown = []) => {
    if (!Array.isArray(selectionContexts)) return [];

    return selectionContexts
      .slice(0, AI_LIMITS.maxSelectionContexts)
      .map((context, index) => {
        const cleanText = cleanTextForAI(AiConstraintUtils.getSelectionContextText(context));
        if (!cleanText) return null;

        const result = AiConstraintUtils.truncateTextBySemanticBoundary(cleanText, AI_LIMITS.maxSelectionContextLength, { mode: 'head-tail' });
        return {
          id: typeof context?.id === 'string' && context.id.trim() ? context.id.trim().slice(0, 80) : `selection-${index + 1}`,
          text: result.text,
          truncated: result.truncated,
          note: result.note,
        };
      })
      .filter((item): item is Selection => item !== null);
  };

  // 组装系统提示词：声明助手边界、注入文章与可选只读工具说明；风格由 prompt 引导，硬约束由白名单/schema/限流承担。
  static buildSystemPrompt = (cleanContext: string, cleanSelectionContexts: Selection[] = []) => {
    let systemPrompt = `你是 CoderX 的 AI 助手，不是会执行站内写操作的自治 Agent。
你的职责是解释代码、总结文章、辅助问答和提供写作建议。
请优先给出准确、克制、可验证的回答；如果信息不足，要明确说明不确定。`;

    if (cleanContext) {
      systemPrompt += `\n\n当前文章内容：\n${cleanContext}\n\n请优先基于这篇文章的内容回答用户问题。`;
    }

    if (cleanSelectionContexts.length > 0) {
      const selectionText = cleanSelectionContexts.map((item, index) => `[片段 ${index + 1}]${item.truncated ? '（已截断）' : ''}\n${item.text}`).join('\n\n');

      systemPrompt += `\n\n用户选中的文章片段（本轮问题的高优先级上下文）：\n${selectionText}\n\n当用户使用“这段”“这句”“这里”等指代时，优先理解为以上选中的文章片段；如果片段与整篇文章背景冲突，先解释片段本身，再补充文章背景。`;
    }

    if (supportsTools) {
      systemPrompt += '\n\n如有必要，你可以调用只读工具辅助检索文章上下文，但不要编造未检索到的事实。';
    }

    return systemPrompt;
  };

  // 按关键词在段落中出现的次数打分，供文章内检索工具对段落排序。
  static scoreParagraph = (paragraph: string, keywords: string[]) => {
    if (!paragraph) return 0;
    return keywords.reduce((score, keyword) => {
      if (!keyword) return score;
      return paragraph.toLowerCase().includes(keyword) ? score + 1 : score;
    }, 0);
  };

  // 可选：向模型暴露仅在当前文章段落中检索的只读工具（默认关闭），不暴露业务写接口。
  static buildArticleContextTool = (cleanContext: string) => {
    if (!supportsTools || !cleanContext) return undefined;

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
  static classifySuggestionType = (text: string) => {
    if (text.length <= 5) return 'word';
    if (text.length <= 15) return 'phrase';
    return 'sentence';
  };

  // 创建带业务错误码与原始错误的 Error，便于控制器统一识别。
  static createAiError = (message: string, code: string, originalError?: unknown) => {
    const customError = new Error(message) as AiError;
    customError.code = code;
    customError.originalError = originalError;
    return customError;
  };

  // 将 SDK/网络层异常映射为用户可读文案与稳定错误码（连接、超时、模型等）。
  static formatServiceError = (error: unknown, model: unknown) => {
    const failure = error instanceof Error ? error as AiError : new Error(String(error)) as AiError;
    if (failure.code) return failure;

    let errorMessage = 'AI 服务暂时不可用';
    let errorCode = 'AI_SERVICE_ERROR';

    if (failure.message.includes('ECONNREFUSED') || failure.message.includes('connect')) {
      errorMessage = `AI 服务器连接失败 (${ollamaBaseURL})。请检查：1. Ollama 是否正在运行？2. 网络连接是否正常？3. 服务器地址是否正确？`;
      errorCode = 'CONNECTION_REFUSED';
    } else if (failure.message.includes('timeout') || failure.message.includes('ETIMEDOUT')) {
      errorMessage = 'AI 服务器响应超时，请检查网络连接或稍后重试';
      errorCode = 'TIMEOUT';
    } else if (failure.message.includes('ENOTFOUND')) {
      errorMessage = `无法解析 AI 服务器地址 (${ollamaBaseURL})，请检查配置`;
      errorCode = 'HOST_NOT_FOUND';
    } else if (failure.message.includes('model')) {
      errorMessage = `模型 "${model}" 不可用，请先检查 Ollama 模型列表`;
      errorCode = 'MODEL_NOT_FOUND';
    }

    return AiConstraintUtils.createAiError(errorMessage, errorCode, failure.message);
  };
}

return AiConstraintUtils;
}
