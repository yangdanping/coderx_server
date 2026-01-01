const fs = require('fs'); //fs模块用于读取文件信息,如获取到用户头像信息后找到图像资源返回给前端
const path = require('path');
const articleService = require('@/service/article.service.js');
const userService = require('@/service/user.service.js');
const fileService = require('@/service/file.service.js');
const historyService = require('@/service/history.service.js');
const { IMG_PATH, VIDEO_PATH } = require('@/constants/filePaths');
const Utils = require('@/utils');
const Result = require('@/app/Result');
const deleteFile = require('@/utils/deleteFile');
class ArticleController {
  /**
   * 发布文章
   * 重构说明：
   * - 移除 result ? ... : ... 判断
   * - Service 层如果出错会抛异常，由全局中间件捕获并返回 Result.fail()
   * - Controller 只关心"正常路径"，代码更简洁
   */
  addArticle = async (ctx, next) => {
    const userId = ctx.user.id;
    const { title, content } = ctx.request.body;
    const result = await articleService.addArticle(userId, title, content);
    ctx.body = Result.success(result);
  };

  /**
   * 增加浏览量
   */
  viewArticle = async (ctx, next) => {
    const { articleId } = ctx.params;
    const result = await articleService.addView(articleId);
    ctx.body = Result.success(result);
  };
  likeArticle = async (ctx, next) => {
    // 1.获取用户id和点赞的评论id
    const userId = ctx.user.id;
    const [urlKey] = Object.keys(ctx.params); //从params中取出对象的key,即我们拼接的资源id,如评论就是commentId
    const dataId = ctx.params[urlKey]; //获取到对应id的值
    const tableName = urlKey.replace('Id', ''); //把Id去掉就是表名

    // 2.根据传递过来参数在数据库中判断是否有点赞,有则取消点赞,没有则成功点赞
    const isLiked = await userService.hasLike(tableName, dataId, userId);

    // 3.执行点赞/取消点赞操作
    await userService.changeLike(tableName, dataId, userId, isLiked);

    // 4.获取更新后的点赞总数
    const likeInfo = await articleService.getArticleLikedById(dataId);

    // 5.统一返回格式：code=0 表示成功，data 中包含业务状态
    ctx.body = Result.success({
      liked: !isLiked, // 操作后的状态：true表示已点赞，false表示已取消
      likes: likeInfo.likes || 0, // 点赞总数
    });
  };

  getArticleLikedById = async (ctx, next) => {
    const { articleId } = ctx.params;
    const result = await articleService.getArticleLikedById(articleId);
    ctx.body = Result.success(result);
  };

  /**
   * 获取文章详情
   * 重构说明：
   * - 移除 result ? ... : ... 判断
   * - Service 层查不到文章时会抛出 BusinessError('文章不存在', 404)
   * - 封禁文章的处理逻辑保持不变（这是业务逻辑，不是错误）
   */
  getDetail = async (ctx, next) => {
    const { articleId } = ctx.params;
    console.log(articleId);

    // Service 层如果查不到会抛出 BusinessError，不会走到下面的代码
    const result = await articleService.getArticleById(articleId);

    // 如果用户已登录，添加浏览记录
    if (ctx.user && ctx.user.id) {
      try {
        await historyService.addHistory(ctx.user.id, articleId);
      } catch (error) {
        console.log('添加浏览记录失败:', error);
      }
    }

    // 封禁文章的处理（这是正常业务逻辑，不是错误）
    if (result.status === 1) {
      result.title = result.content = '文章已被封禁';
    }

    ctx.body = Result.success(result);
  };
  /**
   * 获取文章列表
   */
  getList = async (ctx, next) => {
    console.log('getList ctx.query', ctx.query);
    const { offset, limit } = Utils.getPaginationParams(ctx);
    const { tagId, userId, pageOrder, idList, keywords } = ctx.query;
    const userCollectedIds = idList?.length ? JSON.parse(idList) : [];

    const result = await articleService.getArticleList(offset, limit, tagId, userId, pageOrder, userCollectedIds, keywords);

    // 处理文章内容（清理HTML标签、截取长度、封禁提示）
    result.forEach((article) => {
      if (!article.status) {
        article.content = Utils.removeHTMLTag(article.content);
        if (article.content.length > 50) {
          article.content = article.content.slice(0, 50);
        }
      } else {
        article.title = article.content = '文章已被封禁';
      }
    });

    const total = await articleService.getTotal(tagId, userId, userCollectedIds, keywords);
    ctx.body = Result.success({ result, total });
  };
  getRecommendList = async (ctx, next) => {
    const { offset, limit } = Utils.getPaginationParams(ctx);
    const result = await articleService.getRecommendArticleList(offset, limit);
    ctx.body = Result.success(result);
  };
  update = async (ctx, next) => {
    const { title, content } = ctx.request.body;
    const { articleId } = ctx.params;
    const result = await articleService.update(title, content, articleId);
    ctx.body = Result.success(result);
  };
  /**
   * 删除文章
   * 重构说明：移除手动 try-catch，Service 层异常由全局中间件捕获
   */
  delete = async (ctx, next) => {
    const { articleId } = ctx.params;
    const { result, imagesToDelete, videosToDelete } = await articleService.delete(articleId);

    ctx.body = Result.success(result);

    // 事务成功后，异步删除磁盘文件（不阻塞响应）
    Promise.resolve().then(() => {
      try {
        let deletedCount = 0;

        if (imagesToDelete && imagesToDelete.length > 0) {
          deleteFile(imagesToDelete, 'img');
          deletedCount += imagesToDelete.length;
          console.log(`✅ 成功删除文章 ${articleId} 的 ${imagesToDelete.length} 个图片文件`);
        }

        if (videosToDelete && videosToDelete.length > 0) {
          deleteFile(videosToDelete, 'video');
          deletedCount += videosToDelete.length;
          console.log(`✅ 成功删除文章 ${articleId} 的 ${videosToDelete.length} 个视频文件（含封面）`);
        }

        if (deletedCount > 0) {
          console.log(`📁 文章 ${articleId} 共删除 ${deletedCount} 个文件`);
        }
      } catch (fileError) {
        console.error('❌ 删除磁盘文件失败（不影响业务）:', fileError);
      }
    });
  };
  changeTag = async (ctx, next) => {
    const { tags } = ctx;
    const { articleId } = ctx.params;

    console.log(`文章 ${articleId} 更新标签:`, tags);

    await articleService.clearTag(articleId);

    if (tags && tags.length > 0) {
      const tagIds = tags.map((tag) => tag.id);
      const result = await articleService.batchAddTags(articleId, tagIds);
      ctx.body = Result.success(result, '标签保存成功');
    } else {
      ctx.body = Result.success('标签已清空');
    }
  };
  getFileInfo = async (ctx, next) => {
    // 1.获取数据(一条动态的每张图片来说,是用filename来区分不同的图的,所以路径中要拼接filename,到这里来获取)
    // 注意!要对前端传来的图片的尺寸参数判断,没有则请求的是原图,有则拼接上对应尺寸
    let { filename } = ctx.params; //改成let以便在下面进行type的拼接
    const { type } = ctx.query;
    // http://localhost:8000/article/images/1645078817803.jpg?type=small
    const fileInfo = await fileService.getFileByFilename(filename);

    // 处理small类型的图片
    if (type === 'small') {
      const extname = path.extname(filename);
      filename = filename.replace(extname, `-${type}${extname}`);
    }
    // 2.根据获取到的id去数据库直接查询
    if (fileInfo) {
      // console.log('获取文章图像信息成功', fileInfo);
      // 3.把查询到的图片做和用户获取头像一样也做特殊处理,就能返回
      ctx.response.set('content-type', fileInfo.mimetype);
      ctx.body = fs.createReadStream(`${IMG_PATH}/${filename}`); //拼接上我们对应图片的路径
    } else {
      console.log('获取文章图像信息失败');
    }
  };
  search = async (ctx, next) => {
    const { keywords } = ctx.query;
    const result = await articleService.getArticlesByKeyWords(keywords);
    ctx.body = Result.success(result);
  };

  /**
   * 获取视频文件和封面图
   * 支持访问视频文件(.mp4等)和封面图(-poster.jpg)
   */
  getVideoInfo = async (ctx, next) => {
    const { filename } = ctx.params;

    try {
      // 拼接视频文件的完整路径
      const videoPath = path.join(VIDEO_PATH, filename);

      // 检查文件是否存在
      if (!fs.existsSync(videoPath)) {
        console.log('视频文件不存在:', videoPath);
        ctx.status = 404;
        ctx.body = Result.fail('视频文件不存在');
        return;
      }

      // 获取文件信息
      const stats = fs.statSync(videoPath);

      // 设置响应头
      // 根据文件扩展名设置正确的 MIME 类型
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      ctx.response.set('content-type', contentType);
      ctx.response.set('content-length', stats.size);

      // 支持视频流式传输(支持拖动进度条)
      const range = ctx.headers.range;
      if (range) {
        // 解析 Range 头
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunksize = end - start + 1;

        ctx.status = 206; // Partial Content
        ctx.response.set('content-range', `bytes ${start}-${end}/${stats.size}`);
        ctx.response.set('accept-ranges', 'bytes');
        ctx.response.set('content-length', chunksize);

        // 创建可读流,只读取请求的部分
        ctx.body = fs.createReadStream(videoPath, { start, end });
      } else {
        // 没有 Range 请求,返回整个文件
        ctx.body = fs.createReadStream(videoPath);
      }
    } catch (error) {
      console.error('getVideoInfo error:', error);
      ctx.status = 500;
      ctx.body = Result.fail('获取视频失败: ' + error.message);
    }
  };
}

module.exports = new ArticleController();
