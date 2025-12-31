const errorTypes = require('@/constants/errorTypes');
const Utils = require('@/utils');
const collectService = require('@/service/collect.service.js');

const verifycollectExists = async (ctx, next) => {
  const userId = ctx.user.id;
  console.log('verifycollectExists', userId);
  const { name } = ctx.request.body;
  const tagResult = await collectService.getCollectByName(userId, name);
  if (tagResult && tagResult.name.toLowerCase() === name.toLowerCase()) {
    Utils.emitErrMsg(ctx, errorTypes.NAME_EXISTS);
  } else {
    await next();
  }
};

module.exports = {
  verifycollectExists,
};
