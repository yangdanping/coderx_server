const errorTypes = require('../constants/error-types');
const { emitErrMsg } = require('../utils');
const collectService = require('../service/collect.service.js');

const verifycollectExists = async (ctx, next) => {
  const userId = ctx.user.id;
  console.log('verifycollectExists', userId);
  const { name } = ctx.request.body;
  const tagResult = await collectService.getCollectByName(userId, name);
  if (tagResult && tagResult.name.toLowerCase() === name.toLowerCase()) {
    emitErrMsg(ctx, errorTypes.NAME_EXISTS);
  } else {
    await next();
  }
};

module.exports = {
  verifycollectExists
};
