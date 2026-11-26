import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText, Output, convertToModelMessages, createDownload, stepCountIs, type LanguageModel, type UIMessage } from 'ai';
import { z } from 'zod';
import { AI_LIMITS, DEFAULT_CHAT_MODEL, DEFAULT_COMPLETION_MODEL, createAiCapability } from '../../constants/ai.js';
import { createAiConstraints, type ModelEntry, type RawModel } from './aiConstraints.service.js';

type Dependencies = {
  baseURL: string;
  logEvent?: (event: 'stream-error' | 'setup-error') => void;
  allowedModels?: readonly string[];
  supportsTools?: boolean;
  fetch?: typeof fetch;
  clock?: () => number;
  model?: (name: string) => LanguageModel;
  constraints?: ReturnType<typeof createAiConstraints>;
  resolveModel?: (requested: string | null, fallback: string, abortSignal?: AbortSignal) => Promise<string>;
};

function isRequestAbort(error: unknown, signal?: AbortSignal) {
  if (!signal?.aborted) return false;
  const wasAborted = (failure: unknown) => failure === signal.reason || (failure instanceof Error && failure.name === 'AbortError');
  return wasAborted(error) || (error instanceof Error && wasAborted(error.cause));
}

const download = createDownload();

export function createAiChatService(deps: Dependencies) {
  const supportsTools = deps.supportsTools ?? false;
  const helpers = deps.constraints ?? createAiConstraints({ baseURL: deps.baseURL, allowedModels: deps.allowedModels ?? [], supportsTools });
  const clock = deps.clock ?? Date.now;
  const model = deps.model ?? createOpenAI({ baseURL: deps.baseURL, apiKey: 'ollama' }).chat;
  async function getModelCatalog(forceRefresh = false, abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    const now = clock();
    const cache = helpers.modelCatalogCache;
    if (!forceRefresh && cache.expiresAt > now && cache.models.length > 0) return cache.models;
    const timeout = AbortSignal.timeout(5000);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const response = await (deps.fetch ?? fetch)(`${deps.baseURL.replace('/v1', '')}/api/tags`, { method: 'GET', signal });
    if (!response.ok) throw new Error(`Health check failed with status: ${response.status}`);
    const data = await response.json() as { models?: RawModel[] };
    signal.throwIfAborted();
    cache.models = helpers.buildModelCatalog(data.models || []);
    cache.expiresAt = now + AI_LIMITS.healthCacheTtlMs;
    return cache.models;
  }
  const resolveModel = deps.resolveModel ?? (async (requested: string | null, fallback: string, abortSignal?: AbortSignal) => {
    const allowed = (await getModelCatalog(false, abortSignal)).map(item => item.value);
    if (!allowed.length) throw helpers.createAiError('当前没有可用的 AI 模型，请先在 Ollama 中拉取并启用模型', 'MODEL_UNAVAILABLE');
    const resolved = requested || (allowed.includes(fallback) ? fallback : allowed[0]);
    if (!allowed.includes(resolved)) throw helpers.createAiError(`模型 "${resolved}" 不在允许列表中，可选模型：${allowed.join(', ')}`, 'MODEL_NOT_ALLOWED');
    return resolved;
  });
  return {
    capability: createAiCapability(supportsTools),
    getModelCatalog,
    resolveModel,
    async checkHealth(): Promise<[boolean, ModelEntry[]]> {
      try {
        const models = await getModelCatalog(true);
        return [models.length > 0, models];
      } catch {
        // Unavailable Ollama is an ordinary offline result on the public probe.
        return [false, []];
      }
    },
    async getCompletion(
      beforeText: string,
      afterText = '',
      requested: string | null = DEFAULT_COMPLETION_MODEL,
      maxSuggestions: number = AI_LIMITS.maxSuggestions,
    ) {
      try {
        const resolved = await resolveModel(requested, DEFAULT_COMPLETION_MODEL);
        const following = afterText ? `\n\n下文内容：\n"""\n${afterText}\n"""` : '';
        const prompt = `你将基于上下文生成 ${maxSuggestions} 个续写建议。

上文内容：
"""
${beforeText}
"""${following}

要求：
1. 每个建议都必须自然衔接上下文
2. 每个建议控制在 1-${AI_LIMITS.maxCompletionSuggestionChars} 个字符之间
3. 不要返回解释，只返回结构化字段`;
        const schema = z.object({
          suggestions: z.array(z.string().trim().min(1).max(AI_LIMITS.maxCompletionSuggestionChars))
            .min(1).max(maxSuggestions),
        });
        // SDK 7 ignored legacy maxTokens, so keep the existing effective limits.
        const result = await generateText({
          model: model(resolved),
          system: '你是一个写作补全助手，只输出可直接插入正文的续写建议。',
          prompt,
          output: Output.object({ schema }),
        });
        return result.output.suggestions.slice(0, maxSuggestions).map((text, index) => ({
          id: String.fromCharCode(65 + index),
          text,
          type: helpers.classifySuggestionType(text),
        }));
      } catch (error) {
        const failure = helpers.formatServiceError(error, requested);
        if (failure.code === 'AI_SERVICE_ERROR') {
          failure.code = 'COMPLETION_ERROR';
          failure.message = 'AI 补全服务暂时不可用';
        }
        throw failure;
      }
    },
    async streamChat(messages: unknown[], requested: string | null = DEFAULT_CHAT_MODEL, context: unknown = null, selectionContexts: unknown = [], abortSignal?: AbortSignal) {
      try {
        abortSignal?.throwIfAborted();
        const resolved = await resolveModel(requested, DEFAULT_CHAT_MODEL, abortSignal);
        abortSignal?.throwIfAborted();
        const cleanContext = helpers.sanitizeArticleContext(context);
        const selections = helpers.sanitizeSelectionContexts(selectionContexts);
        const tools = helpers.buildArticleContextTool(cleanContext);
        const managed = messages.length > AI_LIMITS.maxMessages ? messages.slice(-AI_LIMITS.maxMessages) : messages;
        // Validation deliberately retains legacy content-only/system/tool inputs.
        // SDK conversion owns their downstream failures, just as in the legacy path.
        const converted = await convertToModelMessages(managed as UIMessage[]);
        abortSignal?.throwIfAborted();
        return streamText({
          model: model(resolved), system: helpers.buildSystemPrompt(cleanContext, selections), messages: converted,
          abortSignal,
          ...(abortSignal ? {
            // Keep the SDK's default URL handling and limits, while tying
            // attachment downloads during prompt setup to this request.
            experimental_download: async entries => {
              abortSignal.throwIfAborted();
              const downloadAbort = new AbortController();
              const signal = AbortSignal.any([abortSignal, downloadAbort.signal]);
              try {
                const files = await Promise.all(entries.map(({ url, isUrlSupportedByModel }) =>
                  isUrlSupportedByModel ? null : download({ url, abortSignal: signal })));
                abortSignal.throwIfAborted();
                return files;
              } catch (error) {
                // Promise.all rejects before its other downloads settle. Close
                // those sockets without replacing the failure reported by SDK.
                downloadAbort.abort(error);
                throw error;
              }
            },
          } : {}),
          // SDK 7 ignored legacy maxTokens. Do not introduce a new effective cap.
          ...(tools ? { tools, stopWhen: stepCountIs(AI_LIMITS.maxToolSteps) } : {}),
          onError: ({ error }) => {
            if (!isRequestAbort(error, abortSignal)) deps.logEvent?.('stream-error');
          },
        });
      } catch (error) {
        if (abortSignal && isRequestAbort(error, abortSignal)) throw abortSignal.reason;
        deps.logEvent?.('setup-error');
        throw helpers.formatServiceError(error, requested);
      }
    },
  };
}
export type AiChatService = ReturnType<typeof createAiChatService>;
