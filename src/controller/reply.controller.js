const replyService = require('../service/reply.service.js');
const userService = require('../service/user.service.js');
const Result = require('../app/Result');
class ReplyController {
  async addReply(ctx, next) {
    // 1.获取数据(包括用户id,回复评论的文章id,回复评论的评论id,回复内容content)
    const userId = ctx.user.id;
    const { articleId, commentId, content } = ctx.request.body;
    // 2.将获取到的数据插入到数据库中
    const result = await replyService.addReply(userId, articleId, commentId, content);
    // 3.将插入数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('回复评论失败!');
  }
  async replyToReply(ctx, next) {
    // 1.获取数据(包括用户id,回复评论的文章id,回复评论的评论id,回复内容content)
    const userId = ctx.user.id;
    const { replyId } = ctx.params;
    const { articleId, commentId, content } = ctx.request.body;
    // 2.将获取到的数据插入到数据库中
    const result = await replyService.replyToReply(userId, articleId, commentId, replyId, content);
    // 3.将插入数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('回复该回复失败!');
  }
  async likeReply(ctx, next) {
    // 1.获取用户id和点赞的评论id
    const userId = ctx.user.id;
    const [urlKey] = Object.keys(ctx.params); //从params中取出对象的key,即我们拼接的资源id,如评论就是commentId
    const dataId = ctx.params[urlKey]; //获取到对应id的值
    const tableName = urlKey.replace('Id', ''); //把Id去掉就是表名
    // 2.根据传递过来参数在数据库中判断是否有点赞,有则取消点赞,没有则成功点赞
    const isliked = await userService.hasLike(tableName, dataId, userId);
    if (!isliked) {
      const result = await userService.changeLike(tableName, dataId, userId, isliked);
      ctx.body = Result.success(result); //增加一条点赞记录
    } else {
      const result = await userService.changeLike(tableName, dataId, userId, isliked);
      ctx.body = Result.success(result, '1'); //删除一条点赞记录
    }
  }
}

module.exports = new ReplyController();
