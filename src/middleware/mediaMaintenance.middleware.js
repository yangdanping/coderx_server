const config = require('@/app/config');
const Result = require('@/app/Result');

async function mediaMutationMaintenance(ctx, next) {
  if (config.MEDIA_MUTATIONS_PAUSED !== 'true') {
    await next();
    return;
  }

  ctx.status = 503;
  ctx.body = Result.fail('媒体上传和文章发布正在进行短时维护，请稍后重试', 503);
}

module.exports = mediaMutationMaintenance;
