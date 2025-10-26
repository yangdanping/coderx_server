const fs = require('fs'); //fs模块用于读取文件信息,如获取到用户头像信息后找到图像资源返回给前端
const path = require('path');
const articleService = require('../service/article.service.js');
const userService = require('../service/user.service.js');
const fileService = require('../service/file.service.js');
const historyService = require('../service/history.service.js');
const { PICTURE_PATH } = require('../constants/file-path');
const { COVER_SUFFIX } = require('../constants/file');
const { removeHTMLTag } = require('../utils');
const Result = require('../app/Result');
const deleteFile = require('../utils/deleteFile');
class ArticleController {
  addArticle = async (ctx, next) => {
    // 1.获取用户id(从验证token的结果中拿到)文章数据
    const userId = ctx.user.id;
    const { title, content } = ctx.request.body;
    // 2.根据传递过来参数在数据库中插入文章
    const result = await articleService.addArticle(userId, title, content);
    // 3.将插入数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('发布文章失败!');
  };
  viewArticle = async (ctx, next) => {
    // 1.获取文章id
    const { articleId } = ctx.params;
    // 2.根据传递过来参数在数据库中增加文章浏览量
    const result = await articleService.addView(articleId);
    ctx.body = result ? Result.success(result) : Result.fail('增加文章浏览量失败!');
  };
  likeArticle = async (ctx, next) => {
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
  };

  getArticleLikedById = async (ctx, next) => {
    const { articleId } = ctx.params;
    const result = await articleService.getArticleLikedById(articleId);
    ctx.body = result ? Result.success(result) : Result.fail('增加文章浏览量失败!');
  };
  getDetail = async (ctx, next) => {
    // 1.获取文章id
    const { articleId } = ctx.params;
    console.log(articleId);
    // 2.根据传递过来文章id在数据库中查询单个文章
    const result = await articleService.getArticleById(articleId);

    // 3.如果用户已登录，添加浏览记录
    if (ctx.user && ctx.user.id) {
      try {
        await historyService.addHistory(ctx.user.id, articleId);
      } catch (error) {
        console.log('添加浏览记录失败:', error);
      }
    }

    // 将封面置顶
    if (result.images) {
      result.images.find(({ url }, index) => {
        if (url.endsWith(COVER_SUFFIX)) {
          return result.images.unshift(result.images.splice(index, 1)[0]);
        }
      });
    }
    if (result.status === 1) {
      result.title = result.content = '文章已被封禁';
    }
    // 4.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('获取该文章数据失败!');
  };
  getList = async (ctx, next) => {
    // 1.获取文章列表的偏离量和数据长度
    console.log('getList ctx.query', ctx.query);
    const { offset, limit, tagId, userId, order, idList, keywords } = ctx.query;
    const userCollectedIds = JSON.parse(idList);
    // 2.根据传递过来偏离量和数据长度在数据库中查询文章列表
    const result = await articleService.getArticleList(offset, limit, tagId, userId, order, userCollectedIds, keywords);
    // 3.将查询数据库的结果处理,给用户(前端/客户端)返回真正的数据
    if (result) {
      result.forEach((article) => {
        if (!article.status) {
          // 清理HTML标签并截取内容长度
          article.content = removeHTMLTag(article.content);
          if (article.content.length > 50) {
            article.content = article.content.slice(0, 50);
          }
        } else {
          // 被封禁的文章显示提示信息
          article.title = article.content = '文章已被封禁';
        }
      });
      const isQuery = tagId || userId || keywords;
      // 如果是有查询条件,则查询条件的结果长度就是总条数,否则查询总条数
      let total = isQuery ? result.length : await articleService.getTotal();
      ctx.body = result ? Result.success({ result, total }) : Result.fail('获取文章列表数据失败!');
    } else {
      ctx.body = Result.fail('获取文章列表失败!');
    }
  };
  getRecommendList = async (ctx, next) => {
    const { offset, limit } = ctx.query;
    const result = await articleService.getRecommendArticleList(offset, limit);
    ctx.body = result ? Result.success(result) : Result.fail('获取推荐文章列表失败!');
  };
  update = async (ctx, next) => {
    // 1.获取用户修改的文章内容或者标题
    const { title, content } = ctx.request.body;
    const { articleId } = ctx.params; //articleId来自路径
    // 2.根据传递过来文章标题和内容,在数据库中做修改
    const result = await articleService.update(title, content, articleId);
    // 3.将修改数据库的结果处理,给用户(前端/客户端)返回真正的数据
    ctx.body = result ? Result.success(result) : Result.fail('修改文章失败!');
  };
  delete = async (ctx, next) => {
    try {
      // 1. 获取文章ID
      const { articleId } = ctx.params;

      // 2. 删除文章（事务处理，包括查询文件列表和删除数据库记录）
      const { result, filesToDelete } = await articleService.delete(articleId);

      // 3. 返回成功响应
      ctx.body = Result.success(result);

      // 4. 事务成功后，异步删除磁盘文件（不阻塞响应）
      if (filesToDelete && filesToDelete.length > 0) {
        // 使用 Promise.resolve().then() 异步执行，不影响用户响应
        Promise.resolve().then(() => {
          try {
            deleteFile(filesToDelete);
            console.log(`成功删除文章 ${articleId} 的 ${filesToDelete.length} 个文件`);
          } catch (fileError) {
            console.error('删除磁盘文件失败（不影响业务）:', fileError);
            // TODO: 可以将失败的文件记录到待清理队列，由定时任务处理
          }
        });
      }
    } catch (error) {
      ctx.body = Result.fail('删除文章失败!');
    }
  };
  changeTag = async (ctx, next) => {
    // 1.获取数据(获取我们之前verifytagExists整合好的tags数组和文章id)
    const { tags } = ctx; //拿到了用户所选择的标签
    const { articleId } = ctx.params; //拿到了被添加标签的文章
    const { hasOldTags } = ctx.query;
    if (hasOldTags) {
      console.log(hasOldTags, tags, '这是修改!!,清空掉所有tags后添加');
      await articleService.clearTag(articleId);
    }
    if (!tags.length && hasOldTags) {
      console.log('新数组啥也没有,则清空后直接返回成功!!!,不再添加');
      ctx.body = Result.success('清空标签成功'); // 若新数组啥也没有,则清空后直接返回成功
    } else {
      // 2.添加所有的标签(害得做判断,若该文章已经有个标签叫JS了,则不需要再添加了)
      for (const tag of tags) {
        // 2.1判断标签是否已和文章有过关系了(若关系表中不存在,则添加关系)
        const isExist = await articleService.hasTag(articleId, tag.id);
        console.log(tag, `该标签与文章在关系表中${!isExist ? '不存在,可添加' : '存在'}`);
        if (!isExist) {
          const result = await articleService.addTag(articleId, tag.id);
          ctx.body = result ? Result.success(result) : Result.fail('添加标签失败!');
        }
      }
      // 3.不需要返回数据其实,总结:多对多的核心是这张关系表
      // ctx.body = '为该文章添加标签成功!';
    }
  };
  getFileInfo = async (ctx, next) => {
    // 1.获取数据(一条动态的每张图片来说,是用filename来区分不同的图的,所以路径中要拼接filename,到这里来获取)
    // 注意!要对前端传来的图片的尺寸参数判断,没有则请求的是原图,有则拼接上对应尺寸
    let { filename } = ctx.params; //改成let以便在下面进行type的拼接
    const { type } = ctx.query;
    // http://localhost:8000/article/images/1645078817803.jpg?type=small
    const fileInfo = await fileService.getFileByFilename(filename);
    // ['large', 'middle', 'small'].some((item) => item === type) && (filename += '-' + type); //调用数组的some函数,可判断数组中某个东西是等于某个值,返回布尔值
    if (filename.endsWith(COVER_SUFFIX)) {
      filename = filename.replace(COVER_SUFFIX, ''); // 删除后缀名,使其可以正常访问本地文件
    }

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
      ctx.body = fs.createReadStream(`${PICTURE_PATH}/${filename}`); //拼接上我们对应图片的路径
    } else {
      console.log('获取文章图像信息失败');
    }
  };
  search = async (ctx, next) => {
    const { keywords } = ctx.query; //拿到了关键字
    const result = await articleService.getArticlesByKeyWords(keywords);
    ctx.body = result ? Result.success(result) : Result.fail('查询文章失败!');
  };
}

module.exports = new ArticleController();
