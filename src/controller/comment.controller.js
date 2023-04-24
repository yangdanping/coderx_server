const commentService = require('../service/comment.service.js');
const userService = require('../service/user.service.js');
const Result = require('../app/Result');
class CommentController {
  async addComment(ctx, next) {
    // 1.获取数据(包括用户id,评论的文章id,评论内容content)
    const userId = ctx.user.id; // 不需要再从前端获取用户id,因为我授权的这个人,已携带了用户信息了
    const { articleId, content } = ctx.request.body;
    // 2.将获取到的数据插入到数据库中
    const result = await commentService.addComment(userId, articleId, content);
    // 3.将插入数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('发表评论失败!');
  }
  async likeComment(ctx, next) {
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
  async reply(ctx, next) {
    // 1.获取数据(在上面基础上多个commentId,也就是说我需要知道我是对那条评论进行回复了)
    const userId = ctx.user.id;
    const { commentId } = ctx.params;
    const { articleId, content } = ctx.request.body;
    // 2.将获取到的数据插入到数据库中(注意!replyUserId也用于判断是否是对文章中某条评论的回复的回复)
    const result = await commentService.reply(userId, articleId, commentId, content);
    // 3.将插入数据的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('回复评论失败!');
  }
  async update(ctx, next) {
    // // 1.获取数据(在上面基础上多个commentId,也就是说我需要知道我是对那条评论进行修改)
    const { commentId } = ctx.params;
    const { content } = ctx.request.body;
    // 2.根据获取到的数据取数据库进行更新操作
    const result = await commentService.update(content, commentId);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('修改评论失败!');
  }
  async delete(ctx, next) {
    // 1.获取数据(只需评论的id即可删除)
    const { commentId } = ctx.params;
    // 2.根据获取到的数据去数据库进行删除操作
    const result = await commentService.delete(commentId);
    // 3.将删除结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('删除评论失败!');
  }
  async getList(ctx, next) {
    // 1.获取数据(由于是get请求,所以通过query的方式把其传过来,当然可以判断一些别人有没有传,没传的话最好在这里发送错误信息)
    const { articleId } = ctx.query;
    // 2.根据获取到的数据去查询出列表
    const result = await commentService.getCommentList(articleId);
    console.log(result);
    result.forEach((comment) => {
      if (comment.status === '1') {
        comment.content = '该评论已被封禁';
      }
    });
    ctx.body = result ? Result.success(result) : Result.fail('获取评论列表失败!');
  }
}

module.exports = new CommentController();
