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

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null) {
    return { value: null, invalid: false };
  }

  const parsedValue = parsePositiveInt(value);
  return {
    value: parsedValue,
    invalid: parsedValue === null,
  };
}

function parseRequiredPositiveInt(value) {
  const parsedValue = parsePositiveInt(value);
  return {
    value: parsedValue,
    invalid: parsedValue === null,
  };
}

class DraftController {
  saveDraft = async (ctx, next) => {
    const { title = null, content, meta = {}, version = 0 } = ctx.request.body || {};
    const articleIdResult = parseOptionalPositiveInt(ctx.request.body?.articleId);

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

    if (articleIdResult.invalid) {
      ctx.body = Result.fail('参数错误: articleId 必须是正整数');
      return;
    }

    const result = await draftService.upsertDraft(ctx.user.id, {
      articleId: articleIdResult.value,
      title,
      content,
      meta,
      version: normalizedVersion,
    });

    ctx.body = Result.success(result);
  };

  getDraft = async (ctx, next) => {
    const result = await draftService.getDraft(ctx.user.id, null);
    ctx.body = Result.success(result);
  };

  getDraftByArticleId = async (ctx, next) => {
    const articleIdResult = parseRequiredPositiveInt(ctx.params.articleId);
    if (articleIdResult.invalid) {
      ctx.body = Result.fail('参数错误: articleId 必须是正整数');
      return;
    }

    const result = await draftService.getDraft(ctx.user.id, articleIdResult.value);
    ctx.body = Result.success(result);
  };

  deleteDraft = async (ctx, next) => {
    const draftIdResult = parseRequiredPositiveInt(ctx.params.draftId);
    if (draftIdResult.invalid) {
      ctx.body = Result.fail('参数错误: draftId 必须是正整数');
      return;
    }

    const result = await draftService.deleteDraft(ctx.user.id, draftIdResult.value);
    ctx.body = Result.success(result);
  };
}

module.exports = new DraftController();
