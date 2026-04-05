const { AI_LIMITS } = require('@/constants/ai');

const ALLOWED_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

class AiValidUtils {
  /**
   * 统一把 UIMessage part 中可能出现的文本字段压平成字符串，便于长度校验。
   * @param {object} part
   * @returns {string}
   */
  static getPartText = (part) => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.output === 'string') return part.output;
    if (typeof part.input === 'string') return part.input;
    return '';
  };

  /**
   * 从 UIMessage 提取可计数字符串（content 或 parts 拼接）。
   * @param {object} message
   * @returns {string}
   */
  static getMessageText = (message) => {
    if (!message || typeof message !== 'object') return '';
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.parts)) return '';
    return message.parts.map(AiValidUtils.getPartText).join('');
  };

  /**
   * @param {unknown} model
   * @returns {string|null} 错误文案，null 表示通过（含 model 为空沿用默认）
   */
  static validateModelName = (model) => {
    if (model == null) return null;
    if (typeof model !== 'string') return 'model 必须是字符串';
    if (!model.trim()) return 'model 不能为空';
    if (model.length > AI_LIMITS.maxModelNameLength) return 'model 参数过长';
    return null;
  };

  /**
   * @param {{ messages: unknown; context?: unknown; model?: unknown }} payload
   * @returns {string|null}
   */
  static validateChatPayload = ({ messages, context, model }) => {
    if (!Array.isArray(messages) || messages.length === 0) {
      return 'messages 必须是非空数组';
    }

    if (messages.length > AI_LIMITS.maxRequestMessages) {
      return `messages 数量不能超过 ${AI_LIMITS.maxRequestMessages} 条`;
    }

    let totalChars = 0;
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        return 'messages 中存在非法消息对象';
      }

      if (!ALLOWED_MESSAGE_ROLES.has(message.role)) {
        return `不支持的消息角色: ${message.role}`;
      }

      const text = AiValidUtils.getMessageText(message);
      totalChars += text.length;

      if (text.length > AI_LIMITS.maxMessageTextLength) {
        return `单条消息长度不能超过 ${AI_LIMITS.maxMessageTextLength} 个字符`;
      }
    }

    if (totalChars > AI_LIMITS.maxTotalMessageChars) {
      return `消息总长度不能超过 ${AI_LIMITS.maxTotalMessageChars} 个字符`;
    }

    if (context != null && typeof context !== 'string') {
      return 'context 必须是字符串或 null';
    }

    if (typeof context === 'string' && context.length > AI_LIMITS.maxRawContextLength) {
      return `context 原始长度不能超过 ${AI_LIMITS.maxRawContextLength} 个字符`;
    }

    return AiValidUtils.validateModelName(model);
  };

  /**
   * @param {{ beforeText: unknown; afterText?: unknown; model?: unknown; maxSuggestions?: unknown }} payload
   * @returns {string|null}
   */
  static validateCompletionPayload = ({ beforeText, afterText, model, maxSuggestions }) => {
    if (!beforeText || typeof beforeText !== 'string') {
      return 'beforeText is required and must be a string';
    }

    if (beforeText.length > AI_LIMITS.maxCompletionBeforeRaw) {
      return `beforeText 长度不能超过 ${AI_LIMITS.maxCompletionBeforeRaw} 个字符`;
    }

    if (afterText != null && typeof afterText !== 'string') {
      return 'afterText must be a string';
    }

    if (typeof afterText === 'string' && afterText.length > AI_LIMITS.maxCompletionAfterRaw) {
      return `afterText 长度不能超过 ${AI_LIMITS.maxCompletionAfterRaw} 个字符`;
    }

    if (maxSuggestions != null) {
      if (!Number.isInteger(maxSuggestions) || maxSuggestions < 1 || maxSuggestions > AI_LIMITS.maxSuggestions) {
        return `maxSuggestions 必须是 1-${AI_LIMITS.maxSuggestions} 之间的整数`;
      }
    }

    return AiValidUtils.validateModelName(model);
  };
}

module.exports = AiValidUtils;
