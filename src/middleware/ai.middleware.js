const Result = require('@/app/Result');
const { AI_RATE_LIMITS } = require('@/constants/ai');

// 这里先用进程内存做轻量限流，适合当前单实例部署场景。
const rateLimitStore = new Map();

const getClientIp = (ctx) => ctx.ip || ctx.request.ip || ctx.headers['x-forwarded-for'] || 'unknown';

const createRateLimitMiddleware = ({ bucket, windowMs, maxRequests, keyResolver }) => {
  return async (ctx, next) => {
    const key = `${bucket}:${keyResolver(ctx)}`;
    const now = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || now >= record.resetAt) {
      rateLimitStore.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      await next();
      return;
    }

    // 超过阈值直接在网关层拒绝，避免请求继续打到模型服务。
    if (record.count >= maxRequests) {
      ctx.status = 429;
      ctx.body = Result.fail('AI 请求过于频繁，请稍后再试', 429);
      return;
    }

    record.count += 1;
    rateLimitStore.set(key, record);
    await next();
  };
};

const chatRateLimit = createRateLimitMiddleware({
  bucket: 'ai-chat',
  windowMs: AI_RATE_LIMITS.chat.windowMs,
  maxRequests: AI_RATE_LIMITS.chat.maxRequests,
  // 游客问答按 IP 维度限流，防止匿名刷接口。
  keyResolver: (ctx) => getClientIp(ctx),
});

const completionRateLimit = createRateLimitMiddleware({
  bucket: 'ai-completion',
  windowMs: AI_RATE_LIMITS.completion.windowMs,
  maxRequests: AI_RATE_LIMITS.completion.maxRequests,
  // 编辑补全优先按登录用户限流，避免多人共用同一出口 IP 时互相影响。
  keyResolver: (ctx) => ctx.user?.id || getClientIp(ctx),
});

module.exports = {
  chatRateLimit,
  completionRateLimit,
};
