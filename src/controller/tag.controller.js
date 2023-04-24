const tagService = require('../service/tag.service');
const Result = require('../app/Result');
class TagController {
  async addTag(ctx, next) {
    const { name } = ctx.request.body;
    const result = await tagService.addTag(name);
    ctx.body = result ? Result.success(result) : Result.fail('创建标签失败!');
  }
  async getList(ctx, next) {
    const { offset, limit } = ctx.query; //暂时先限制展示标签的数量
    const result = await tagService.getTagList(offset, limit);
    ctx.body = result ? Result.success(result) : Result.fail('获取标签列表失败!');
  }

}


module.exports = new TagController();
