const Result = require('@/app/Result');
const draftService = require('@/service/draft.service');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseNonNegativeInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsedValue = Number(value);
    return Number.isSafeInteger(parsedValue) ? parsedValue : null;
  }

  return null;
}

function parsePositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsedValue = Number(value);
    return Number.isSafeInteger(parsedValue) ? parsedValue : null;
  }

  return null;
}

class FlowDraftController {
  saveFlowDraft = async (ctx) => {
    const { content, meta = {}, version = 0 } = ctx.request.body || {};

    if (!isPlainObject(content)) {
      ctx.body = Result.fail('参数错误: content 必须是对象');
      return;
    }

    if (!isPlainObject(meta)) {
      ctx.body = Result.fail('参数错误: meta 必须是对象');
      return;
    }

    const normalizedVersion = parseNonNegativeInt(version);
    if (normalizedVersion === null) {
      ctx.body = Result.fail('参数错误: version 必须是非负整数');
      return;
    }

    const result = await draftService.upsertFlowDraft(ctx.user.id, {
      content,
      meta,
      version: normalizedVersion,
    });
    ctx.body = Result.success(result);
  };

  getFlowDraft = async (ctx) => {
    const result = await draftService.getFlowDraft(ctx.user.id);
    ctx.body = Result.success(result);
  };

  deleteFlowDraft = async (ctx) => {
    const draftId = parsePositiveInt(ctx.params.draftId);
    if (draftId === null) {
      ctx.body = Result.fail('参数错误: draftId 必须是正整数');
      return;
    }

    const result = await draftService.deleteFlowDraft(ctx.user.id, draftId);
    ctx.body = Result.success(result);
  };
}

module.exports = new FlowDraftController();
