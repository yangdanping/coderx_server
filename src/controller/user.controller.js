// controller层一般处理路由中具体的逻辑--------------------
const fs = require('fs'); //fs模块用于读取文件信息,如获取到用户头像信息后找到图像资源返回给前端
const jwt = require('jsonwebtoken');
const userService = require('../service/user.service');
const fileService = require('../service/file.service');
const { removeHTMLTag } = require('../utils');
const { PRIVATE_KEY } = require('../app/config');
const { AVATAR_PATH } = require('../constants/file-path');
const Result = require('../app/Result');

class UserContoller {
  async userLogin(ctx, next) {
    // 1.拿到验证中间件设置的user(仅取出id, name作为token的payload,为了安全性不取出密码,id非常重要,各种一对一,一对多,多对多需要用)
    const { id, name } = ctx.user;
    // // 2.生成密钥和公钥,生成token,并传入携带的用户数据,授权中间件verifyAuth通过ctx.user = verifyResult获得这边传来的id,name
    const token = jwt.sign({ id, name }, PRIVATE_KEY, {
      expiresIn: 60 * 60 * 24, //设置24小时后过期
      // expiresIn: 10,
      algorithm: 'RS256' //设置RS256加密算法
    });
    // 3.向客户端返回id,name,token
    ctx.body = token ? Result.success({ id, name }, 0, token) : Result.fail('生成token失败');
  }
  async addUser(ctx, next) {
    // 1.获取用户请求传递的参数
    const user = ctx.request.body; //注意!request是koa自定义的重新封装后的对象
    // 2.根据传递过来参数在数据库中创建用户(要对JSON数据进行解析,要用koa-bodyparser,在app/config.js中注册)
    console.log('addUser', user);
    const result = await userService.addUser(user);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('创建用户失败');
  }
  async getProfile(ctx, next) {
    // 1.拿到路径中拼接的用户id
    const { userId } = ctx.params;
    // 2.根据id将用户表左连接用户信息表查找用户
    const userInfo = await userService.getProfileById(userId);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = userInfo ? Result.success(userInfo) : Result.fail('获取用户信息失败');
  }
  async updateProfile(ctx, next) {
    // 1.拿到验证中间件中获取到的id和前端传来的用户信息
    const { id } = ctx.user;
    const profile = ctx.request.body;
    // 2.根据id将用户表左连接用户信息表查找用户
    const result = await userService.updateProfileById(id, profile);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('修改用户信息失败!');
  }
  async getLiked(ctx, next) {
    // 1.拿到路径中拼接的用户id
    const { userId } = ctx.params;
    // 2.根据id将用户表左连接用户信息表查找用户
    const likedInfo = await userService.getLikedById(userId);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = likedInfo ? Result.success(likedInfo) : Result.fail('获取点赞信息失败');
  }
  async getAvatar(ctx, next) {
    // 1.拿到路径中拼接的用户id(注意!用户上传图片的服务器地址要保存到用户信息表中)
    const { userId } = ctx.params;
    // 2.根据拿到的用户id在avatar表中查看是否有该用户id的头像信息,
    const avatarInfo = await fileService.getAvatarById(userId);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    /* cxt.body可以放各种类型的数据,所以我们这里完全可以放个Stream类型的数据
      到时候它会读取我们的Stream流,然后直接把我们对应的数据返回
      当然直接返回,那边请求后浏览器是直接下载了,但我们不想下载,
      则必须先设置该图片的类型,请求后即可将图片直接展示 */
    if (avatarInfo) {
      console.log('获取用户头像信息成功');
      // ctx.body = avatarInfo; // 注意,此时返回的只是个json数据格式
      ctx.response.set('content-type', avatarInfo.mimetype);
      ctx.body = fs.createReadStream(`${AVATAR_PATH}/${avatarInfo.filename}`); //拼接上我们对应图片的路径
    } else {
      Result.fail('获取用户头像信息失败');
    }
  }
  async userFollow(ctx, next) {
    // 1.获取关注者id与被关注者id
    const followerId = ctx.user.id;
    const { userId } = ctx.params;
    if (followerId !== parseInt(userId)) {
      // 2.根据传递过来参数在数据库中判断是否有关注,若无则可增加一条关注记录,反之删除
      const isFollowed = await userService.hasFollowed(userId, followerId);
      if (!isFollowed) {
        const result = await userService.follow(userId, followerId);
        ctx.body = Result.success(result); //增加一条关注记录(该用户关注一个用户)
      } else {
        const result = await userService.unfollow(userId, followerId);
        ctx.body = Result.success(result, '1'); //删除一条关注记录(该用户取关一个用户)
      }
    } else {
      ctx.body = Result.fail('不能关注自己');
    }
  }
  async getFollow(ctx, next) {
    // 1.获取关注者id与被关注者id
    const { userId } = ctx.params;
    // 2.根据被关注者id去数据库查询关注者,以及被关注者自己关注的人
    const result = await userService.getFollowInfo(userId);
    ctx.body = result ? Result.success(result) : Result.fail('获取用户关注信息失败');
  }
  async getArticle(ctx, next) {
    const { userId } = ctx.params;
    const { offset, limit } = ctx.query;
    console.log(offset, limit);
    const userArticle = await userService.getArticleById(userId, offset, limit);
    if (userArticle) {
      userArticle.forEach((article) => (article.content = removeHTMLTag(article.content)));
      console.log('获取用户发表过的文章成功');
      ctx.body = Result.success(userArticle);
    } else {
      ctx.body = Result.fail('获取用户发表过的文章失败');
    }
  }
  async getComment(ctx, next) {
    const { userId } = ctx.params;
    const { offset, limit } = ctx.query;
    const userComment = await userService.getCommentById(userId, offset, limit);
    if (userComment) {
      userComment.forEach((comment) => (comment.content = removeHTMLTag(comment.content)));
      ctx.body = Result.success(userComment);
    } else {
      ctx.body = Result.fail('获取用户发表过的评论失败');
    }
  }
  async getArticleByCollectId(ctx, next) {
    const { userId } = ctx.params;
    const { collectId, offset, limit } = ctx.query;
    console.log(userId, collectId, offset, limit);
    const collectArticle = await userService.getArticleByCollectId(userId, collectId, offset, limit);
    if (collectArticle) {
      collectArticle.forEach((article) => (article.content = removeHTMLTag(article.content)));
      console.log('获取该收藏夹下的文章成功');
      ctx.body = Result.success(collectArticle);
    } else {
      ctx.body = Result.fail('获取用户发表过的文章失败');
    }
  }
  async userReport(ctx, next) {
    const { userId } = ctx.params;
    const { reportOptions, articleId, commentId } = ctx.request.body;
    if (!commentId) {
      const result = await userService.userReport(parseInt(userId), reportOptions.join(' '), articleId);
      ctx.body = result ? Result.success(result) : Result.fail('举报用户失败!');
      console.log('我举报的是文章', parseInt(userId), articleId, reportOptions);
    } else {
      const result = await userService.userReport(parseInt(userId), reportOptions.join(' '), null, commentId);
      ctx.body = result ? Result.success(result) : Result.fail('举报用户失败!');
      console.log('我举报的是评论', parseInt(userId), commentId, reportOptions);
    }
  }
  async userFeedback(ctx, next) {
    const { userId } = ctx.params;
    const { content } = ctx.request.body;
    const result = await userService.userFeedback(parseInt(userId), content);
    ctx.body = result ? Result.success(result) : Result.fail('举报用户失败!');
  }
  async getReplyByUserId(ctx, next) {
    const { userId } = ctx.params;
    console.log('getReplyByUserId!!!!', userId);
    // 2.根据传递过来偏离量和数据长度在数据库中查询文章列表
    const result = await userService.getReplyByUserId(userId);
    ctx.body = result ? Result.success(result) : Result.fail('获取反馈回复失败!');
  }
}

module.exports = new UserContoller();
