// controller层一般处理路由中具体的逻辑--------------------
const fs = require('fs'); //fs模块用于读取文件信息,如获取到用户头像信息后找到图像资源返回给前端
const jwt = require('jsonwebtoken');
const userService = require('@/service/user.service');
const articleService = require('@/service/article.service');
const fileService = require('@/service/file.service');
const avatarService = require('@/service/avatar.service');
const Utils = require('@/utils');
const { PRIVATE_KEY } = require('@/app/config');
const { AVATAR_PATH } = require('@/constants/filePaths');
const Result = require('@/app/Result');

class UserContoller {
  userLogin = async (ctx, next) => {
    // 1.拿到验证中间件设置的user(仅取出id, name作为token的payload,为了安全性不取出密码,id非常重要,各种一对一,一对多,多对多需要用)
    const { id, name } = ctx.user;
    // // 2.生成密钥和公钥,生成token,并传入携带的用户数据,授权中间件verifyAuth通过ctx.user = verifyResult获得这边传来的id,name
    const token = jwt.sign({ id, name }, PRIVATE_KEY, {
      expiresIn: 60 * 60 * 24 * 7, //设置7天后过期
      // expiresIn: 10, //测试用,X秒后过期
      algorithm: 'RS256', //设置RS256非对称加密算法
      allowInsecureKeySizes: true, //9版本要加上
    });
    // 3.向客户端返回id,name,token(过期时间会自动添加到 Payload ,也就是jwt的第二个部分)
    // ctx.body = token ? Result.success({ id, name }, 0, token) : Result.fail('生成token失败');
    const data = { id, name, token };
    console.log('userLogin data', data);
    ctx.body = token ? Result.success(data) : Result.fail('生成token失败'); // 将token放入data中
  };
  addUser = async (ctx, next) => {
    const user = ctx.request.body;
    console.log('addUser', user);
    const result = await userService.addUser(user);
    ctx.body = Result.success(result);
  };
  getProfile = async (ctx, next) => {
    const { userId } = ctx.params;
    const userInfo = await userService.getProfileById(userId);
    ctx.body = Result.success(userInfo);
  };

  updateProfile = async (ctx, next) => {
    const { id } = ctx.user;
    const profile = ctx.request.body;
    const result = await userService.updateProfileById(id, profile);
    ctx.body = Result.success(result);
  };

  getLiked = async (ctx, next) => {
    const { userId } = ctx.params;
    const likedInfo = await userService.getLikedById(userId);
    ctx.body = Result.success(likedInfo);
  };
  getAvatar = async (ctx, next) => {
    // 1.拿到路径中拼接的用户id(注意!用户上传图片的服务器地址要保存到用户信息表中)
    const { userId } = ctx.params;
    // 2.根据拿到的用户id在avatar表中查看是否有该用户id的头像信息,
    const avatarInfo = await avatarService.getAvatarById(userId);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    /* cxt.body可以放各种类型的数据,所以我们这里完全可以放个Stream类型的数据
      到时候它会读取我们的Stream流,然后直接把我们对应的数据返回
      当然直接返回,那边请求后浏览器是直接下载了,但我们不想下载,
      则必须先设置该图片的类型,请求后即可将图片直接展示 */
    if (avatarInfo) {
      // console.log('获取用户头像信息成功');
      // ctx.body = avatarInfo; // 注意,此时返回的只是个json数据格式
      ctx.response.set('content-type', avatarInfo.mimetype);
      ctx.body = fs.createReadStream(`${AVATAR_PATH}/${avatarInfo.filename}`); //拼接上我们对应图片的路径
    } else {
      Result.fail('获取用户头像信息失败');
    }
  };
  userFollow = async (ctx, next) => {
    const followerId = ctx.user.id;
    const { userId } = ctx.params;

    if (followerId === parseInt(userId)) {
      throw new BusinessError('不能关注自己', 400);
    }

    const result = await userService.toggleFollow(userId, followerId);
    ctx.body = Result.success(result);
  };
  getFollow = async (ctx, next) => {
    const { userId } = ctx.params;
    const result = await userService.getFollowInfo(userId);
    ctx.body = Result.success(result);
  };

  getComment = async (ctx, next) => {
    const { userId } = ctx.params;
    const { offset, limit } = Utils.getPaginationParams(ctx);
    const userComment = await userService.getCommentById(userId, offset, limit);
    userComment.forEach((comment) => (comment.content = Utils.removeHTMLTag(comment.content)));
    ctx.body = Result.success(userComment);
  };

  getArticleByCollectId = async (ctx, next) => {
    const { userId } = ctx.params;
    const { collectId } = ctx.query;
    const { offset, limit } = Utils.getPaginationParams(ctx);
    console.log(userId, collectId, offset, limit);
    const collectArticle = await userService.getArticleByCollectId(userId, collectId, offset, limit);
    collectArticle.forEach((article) => (article.content = Utils.removeHTMLTag(article.content)));
    console.log('获取该收藏夹下的文章成功');
    ctx.body = Result.success(collectArticle);
  };
  userReport = async (ctx, next) => {
    const { userId } = ctx.params;
    const { reportOptions, articleId, commentId } = ctx.request.body;
    if (!commentId) {
      const result = await userService.userReport(parseInt(userId), reportOptions.join(' '), articleId);
      console.log('我举报的是文章', parseInt(userId), articleId, reportOptions);
      ctx.body = Result.success(result);
    } else {
      const result = await userService.userReport(parseInt(userId), reportOptions.join(' '), null, commentId);
      console.log('我举报的是评论', parseInt(userId), commentId, reportOptions);
      ctx.body = Result.success(result);
    }
  };

  getHotUsers = async (ctx, next) => {
    console.log('getHotUsers!!!!');
    const result = await userService.getHotUsers();
    ctx.body = Result.success(result);
  };
  // userFeedback = async (ctx, next) => {
  //   const { userId } = ctx.params;
  //   const { content } = ctx.request.body;
  //   const result = await userService.userFeedback(parseInt(userId), content);
  //   ctx.body = result ? Result.success(result) : Result.fail('举报用户失败!');
  // };
  // getReplyByUserId = async (ctx, next) => {
  //   const { userId } = ctx.params;
  //   console.log('getReplyByUserId!!!!', userId);
  //   // 2.根据传递过来偏离量和数据长度在数据库中查询文章列表
  //   const result = await userService.getReplyByUserId(userId);
  //   ctx.body = result ? Result.success(result) : Result.fail('获取反馈回复失败!');
  // };
}

module.exports = new UserContoller();
