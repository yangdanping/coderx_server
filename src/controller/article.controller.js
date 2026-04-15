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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInt(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }

  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

function parseOptionalDraftId(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: null, invalid: false };
  }

  const value = parsePositiveInt(raw);
  return {
    value,
    invalid: value === null,
  };
}

class ArticleController {
  /**
   * 发布文章
   */
  addArticle = async (ctx, next) => {
    const userId = ctx.user.id;
    const { title, contentJson = null, draftId: rawDraftId } = ctx.request.body;
    const draftIdResult = parseOptionalDraftId(rawDraftId);

    if (draftIdResult.invalid) {
      ctx.body = Result.fail('参数错误: draftId 必须是正整数');
      return;
    }

    if (contentJson !== null && !isPlainObject(contentJson)) {
      ctx.body = Result.fail('参数错误: contentJson 必须是对象');
      return;
    }

    if (contentJson === null && draftIdResult.value === null) {
      ctx.body = Result.fail('参数错误: contentJson 不能为空');
      return;
    }

    const result = await articleService.addArticle(userId, title, draftIdResult.value, contentJson);
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
    const [urlKey] = Object.keys(ctx.params); //从 params 中取出对象的 key
    const dataId = ctx.params[urlKey]; //获取到对应 id 的值
    const tableName = urlKey.replace('Id', ''); //把 Id 去掉就是表名

    // 切换点赞状态
    const result = await userService.toggleLike(tableName, dataId, userId);

    // 获取更新后的点赞总数
    const likeInfo = await articleService.getArticleLikedById(dataId);

    // 5.统一返回格式：code=0 表示成功，data 中包含业务状态
    ctx.body = Result.success({
      liked: result.isLiked, // 操作后的状态：true表示已点赞，false表示已取消
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

    // 与列表/历史链路保持一致：任何 truthy 状态都视为需要屏蔽
    if (result.status) {
      result.title = '文章已被封禁';
      result.excerpt = '文章已被封禁';
      result.content = '文章已被封禁';
      result.contentHtml = '文章已被封禁';
      result.contentJson = null;
      result.images = [];
      result.videos = [];
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
    const validPageOrders = new Set(['date', 'hot']);
    const normalizedPageOrder = validPageOrders.has(pageOrder) ? pageOrder : 'date';
    const userCollectedIds = idList?.length ? JSON.parse(idList) : [];

    const result = await articleService.getArticleList(offset, limit, tagId, userId, normalizedPageOrder, userCollectedIds, keywords);

    // 处理文章内容（清理HTML标签、截取长度、封禁提示）
    result.forEach((article) => {
      if (!article.status) {
        const preview = typeof article.excerpt === 'string' ? article.excerpt : '';
        article.excerpt = preview.length > 50 ? preview.slice(0, 50) : preview;
        delete article.content;
      } else {
        article.title = '文章已被封禁';
        article.excerpt = '文章已被封禁';
        delete article.content;
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
    const userId = ctx.user.id;
    const { title, contentJson = null, draftId: rawDraftId } = ctx.request.body;
    const { articleId } = ctx.params;
    const draftIdResult = parseOptionalDraftId(rawDraftId);

    if (draftIdResult.invalid) {
      ctx.body = Result.fail('参数错误: draftId 必须是正整数');
      return;
    }

    if (contentJson !== null && !isPlainObject(contentJson)) {
      ctx.body = Result.fail('参数错误: contentJson 必须是对象');
      return;
    }

    if (contentJson === null && draftIdResult.value === null) {
      ctx.body = Result.fail('参数错误: contentJson 不能为空');
      return;
    }

    const result = await articleService.update(userId, title, articleId, draftIdResult.value, contentJson);
    ctx.body = Result.success(result);
  };
  /**
   * 删除文章
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
