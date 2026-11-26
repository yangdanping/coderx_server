import type { Context } from 'hono';
import { createFactory } from 'hono/factory';
import { AI_ACCESS_POLICY, AI_LIMITS } from '../constants/ai.js';
import type { AppEnv } from '../http/types.js';
import { bodyFields } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import type { AiChatService } from '../service/ai/ai.service.js';
import AiValidUtils from '../utils/AiValidUtils.js';
import type { AiError } from '../service/ai/aiConstraints.service.js';

const { createHandlers } = createFactory<AppEnv>();

type AiService = Pick<AiChatService, 'capability' | 'checkHealth' | 'getCompletion'>;

export function createAiController(service: AiService, clock = Date.now) {
  const timestamp = () => new Date(clock()).toISOString();
  return {
    health: createHandlers(async c => {
      const metadata = { capability: service.capability, accessPolicy: AI_ACCESS_POLICY };
      try {
        const [healthy, models] = await service.checkHealth();
        return legacyJson(c, {
          models,
          status: healthy ? 'online' : 'offline',
          message: healthy ? 'AI service is running' : 'AI service is not available',
          ...metadata,
          timestamp: timestamp(),
        });
      } catch (error) {
        return legacyJson(c, {
          models: [],
          status: 'offline',
          message: error instanceof Error ? error.message : undefined,
          ...metadata,
          timestamp: timestamp(),
        }, 503);
      }
    }),
    completion: createHandlers(async c => {
      const { beforeText, afterText, model, maxSuggestions } = bodyFields(c.get('parsedBody'));
      const invalid = AiValidUtils.validateCompletionPayload({ beforeText, afterText, model, maxSuggestions });
      if (invalid) return legacyJson(c, {
        success: false,
        message: invalid,
        code: 'INVALID_AI_COMPLETION_PAYLOAD',
        timestamp: timestamp(),
      }, 400);

      // The shared legacy validator checks types before clipping the model context.
      const before = (beforeText as string).slice(-AI_LIMITS.maxCompletionBefore);
      const after = typeof afterText === 'string' ? afterText.slice(0, AI_LIMITS.maxCompletionAfter) : '';
      try {
        const suggestions = await service.getCompletion(
          before, after, model as string | null | undefined,
          typeof maxSuggestions === 'number' ? maxSuggestions : AI_LIMITS.maxSuggestions,
        );
        return legacyJson(c, { success: true, suggestions, timestamp: timestamp() });
      } catch (error) {
        const failure = error instanceof Error ? error as AiError : undefined;
        return legacyJson(c, {
          success: false,
          message: failure?.message,
          code: failure?.code || 'COMPLETION_ERROR',
          suggestions: [],
          timestamp: timestamp(),
        }, 503);
      }
    }),
  };
}

function bindChatBody(body: ReadableStream<Uint8Array>, lifetime: AbortController, detachRequest: () => void) {
  const reader = body.getReader();
  let finished = false;
  let onAbort: () => void;
  const finish = (cancelSource = false) => {
    if (finished) return;
    finished = true;
    lifetime.signal.removeEventListener('abort', onAbort);
    detachRequest();
    if (cancelSource) {
      // The SDK retains a tee branch. Abort the provider separately, and
      // release this reader without waiting for that branch to cancel.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        controller.close();
        finish(true);
      };
      if (lifetime.signal.aborted) onAbort();
      else lifetime.signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch {
        if (finished) return;
        finish();
        lifetime.abort();
        // The Node adapter logs body read errors. Provider details can contain
        // user input, so let it observe a fixed transport failure.
        controller.error(new Error('AI chat response stream failed'));
      }
    },
    cancel() {
      finish(true);
      lifetime.abort();
    },
  }, { highWaterMark: 0 });
}

export function createAiChatController(service: Pick<AiChatService, 'streamChat'>) {
  return async (c: Context<AppEnv>) => {
    const body = c.get('parsedBody');
    const field = (key: string): unknown => body && typeof body === 'object' ? Reflect.get(body, key) : undefined;
    const messages = field('messages'), model = field('model'), context = field('context'), selectionContexts = field('selectionContexts');
    const invalid = AiValidUtils.validateChatPayload({ messages, model, context, selectionContexts });
    if (invalid) return c.json({ success: false, message: invalid, code: 'INVALID_AI_CHAT_PAYLOAD', timestamp: new Date().toISOString() }, 400);
    const lifetime = new AbortController();
    const requestSignal = c.req.raw.signal;
    const onDisconnect = () => lifetime.abort();
    const detachRequest = () => requestSignal.removeEventListener('abort', onDisconnect);
    if (requestSignal.aborted) onDisconnect();
    else requestSignal.addEventListener('abort', onDisconnect, { once: true });
    try {
      const result = await service.streamChat(messages as unknown[], model as string | null | undefined, context, selectionContexts, lifetime.signal);
      lifetime.signal.throwIfAborted();
      const response = result.toUIMessageStreamResponse();
      if (!response.body) {
        detachRequest();
        return c.newResponse(null, response);
      }
      return c.newResponse(bindChatBody(response.body, lifetime, detachRequest), response);
    } catch (error) {
      detachRequest();
      const isAbort = lifetime.signal.aborted && error === lifetime.signal.reason;
      lifetime.abort();
      const failure = !isAbort && error instanceof Error ? error as AiError : new Error('AI 服务暂时不可用') as AiError;
      return c.json({ success: false, message: failure.message, code: failure.code || 'AI_SERVICE_ERROR', timestamp: new Date().toISOString() }, 503);
    }
  };
}
