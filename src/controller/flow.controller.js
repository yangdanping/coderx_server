const validator = require('validator');
const Result = require('@/app/Result');
const flowService = require('@/service/flow.service');

function parsePositiveInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function invalid(ctx, message) {
  ctx.body = Result.fail(`参数错误: ${message}`);
}

class FlowController {
  createFlow = async (ctx) => {
    const body = ctx.request.body || {};
    if (typeof body.clientRequestId !== 'string' || !validator.isUUID(body.clientRequestId)) {
      invalid(ctx, 'clientRequestId 必须是 UUID');
      return;
    }
    if (!body.content || typeof body.content !== 'object' || Array.isArray(body.content) || body.content.type !== 'doc') {
      invalid(ctx, 'content 必须是 Tiptap doc');
      return;
    }
    if (!Array.isArray(body.mediaIds)) {
      invalid(ctx, 'mediaIds 必须是数组');
      return;
    }
    if (body.mediaIds.length > 9) {
      invalid(ctx, 'mediaIds 不能超过 9 个');
      return;
    }
    if (!body.mediaIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
      invalid(ctx, 'mediaIds 只能包含正安全整数');
      return;
    }
    if (new Set(body.mediaIds).size !== body.mediaIds.length) {
      invalid(ctx, 'mediaIds 不能重复');
      return;
    }
    const result = await flowService.createFlow(ctx.user.id, {
      clientRequestId: body.clientRequestId,
      content: body.content,
      mediaIds: body.mediaIds,
    });
    ctx.body = Result.success(result);
  };

  getFlowFeed = async (ctx) => {
    const page = ctx.query.pageNum === undefined ? 1 : parsePositiveInt(ctx.query.pageNum);
    const pageSize = ctx.query.pageSize === undefined ? 10 : parsePositiveInt(ctx.query.pageSize);
    if (page === null || pageSize === null || pageSize > 100) {
      invalid(ctx, '分页参数必须是有效正整数，且 pageSize 不能超过 100');
      return;
    }
    ctx.body = Result.success(await flowService.getFlowFeed(page, pageSize));
  };

  getFlowDetail = async (ctx) => {
    const flowId = parsePositiveInt(ctx.params.flowId);
    if (flowId === null) {
      invalid(ctx, 'flowId 必须是正整数');
      return;
    }
    ctx.body = Result.success(await flowService.getFlowDetail(flowId));
  };
}

module.exports = new FlowController();
