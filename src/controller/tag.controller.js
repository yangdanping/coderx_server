const tagService = require('@/service/tag.service');
const Result = require('@/app/Result');

class TagController {
  addTag = async (ctx, next) => {
    const { name } = ctx.request.body;
    const result = await tagService.addTag(name);
    ctx.body = Result.success(result);
  };

  getList = async (ctx, next) => {
    const { offset = '0', limit = '99' } = ctx.query;
    const result = await tagService.getTagList(offset, limit);
    ctx.body = Result.success(result);
  };
}

module.exports = new TagController();
