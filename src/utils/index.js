const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Utils {
  // 自动加载路由工具-----------------------------
  // 配置：选择使用哪个版本的 comment 路由
  // COMMENT_VERSION: '1' 仅旧版, '2' 仅新版
  useRoutes = (app) => {
    const COMMENT_VERSION = '2';
    const routerDir = path.resolve(__dirname, '../router');
    // 加载单个路由文件（内部函数）
    const loadRouter = (dir, file) => {
      const router = require(path.resolve(dir, `./${file}`));
      app.use(router.routes()).use(router.allowedMethods());
      console.log(`路由文件 ${file} 已注册`);
    };

    fs.readdirSync(routerDir).forEach((file) => {
      if (!file) {
        console.log(`路由文件${file}注册失败`);
        return;
      }

      // comment 路由特殊处理：根据配置选择加载哪个版本
      if (file.startsWith('comment.router')) {
        const isV2 = file === 'comment.router.js';
        const isV1 = file === 'comment.router.old.js';
        if (COMMENT_VERSION === '2' && isV2) {
          loadRouter(routerDir, file);
        } else if (COMMENT_VERSION === '1' && isV1) {
          loadRouter(routerDir, file);
        }
        // 其他版本不加载，跳过
        return;
      }

      // 其他路由正常加载
      loadRouter(routerDir, file);
    });

    console.log(`[Router] 当前评论系统版本: ${COMMENT_VERSION === 'both' ? 'V1 + V2' : 'V' + COMMENT_VERSION}`);
  };
  // 密码加密工具-----------------------------
  encryptPwd = (password) => {
    const md5 = crypto.createHash('md5'); //采用md5加密,会返回一个md5对象
    try {
      const encryptedPwd = md5.update(password).digest('hex'); //调用md5对象的update方法可传入原始密码,返回的还是对象,调用其digest方法传入'hex'拿到返回加密后16进制的结果
      return encryptedPwd;
    } catch (error) {
      console.log(error);
    }
  };
  // 发送错误信息工具-----------------------------
  emitErrMsg = (ctx, errortype) => {
    const err = new Error(errortype); //Error对象有两个属性name和message
    return ctx.app.emit('error', err, ctx); //第一个参数表示发出去的事件是error事件,第二个参数表示你要给用户提示的错误信息
  };
  // 移除HTML标签工具-----------------------------
  removeHTMLTag = (str) => {
    return str.replace(new RegExp('<(S*?)[^>]*>.*?|<.*? />|&nbsp; ', 'g'), '');
  };
  // 专门用于 AI 上下文的清洗工具（保留段落结构）
  cleanTextForAI = (str) => {
    if (!str) return '';
    return str
      .replace(/<\/(p|div|h\d|li)>/gi, '\n') // 在块级元素结束处换行
      .replace(/<br\s*\/?>/gi, '\n') // <br> 换行
      .replace(/<[^>]+>/g, '') // 移除所有其他标签
      .replace(/&nbsp;/g, ' ') // 替换空格
      .replace(/\n\s*\n/g, '\n\n') // 合并多余换行，最多保留两个
      .trim();
  };
  // 分页参数处理工具-----------------------------
  getPaginationParams = (ctx) => {
    let { pageNum, pageSize, offset, limit } = ctx.query;

    // 优先使用 pageNum/pageSize
    const pNum = Number(pageNum) || 1;
    // pageSize 默认为 10，如果传了 limit 则优先使用 limit 作为 pageSize 的候补
    // 注意：这里要处理 limit 可能是 undefined 的情况
    const pSize = Number(pageSize) || (limit ? Number(limit) : 10);

    // 如果没有传 offset，则通过 pageNum 计算
    if (offset === undefined || offset === null) {
      offset = (pNum - 1) * pSize;
      limit = pSize;
    } else {
      // 如果传了 offset，则 limit 必须有值，否则默认为 10
      offset = Number(offset);
      limit = limit ? Number(limit) : 10;
    }

    // 兜底检查，防止 NaN
    if (isNaN(offset)) offset = 0;
    if (isNaN(limit)) limit = 10;

    return { offset: String(offset), limit: String(limit) };
  };
}

module.exports = new Utils();

/* useRoutes避免了路由需要向下面这样在app/index中一个个导入
  // (1)用户路由的注册------------------
  app.use(userRouter.routes()); //再次强调,使用路由必须注册
  app.use(userRouter.allowedMethods()); //用于判断某个method是否支持,就不用自己设置状态码了,可判断某个请求方式有没有,若没有就返回不允许
  // (2)授权路由的注册------------------
  app.use(authRouter.routes());
  app.use(authRouter.allowedMethods()); */
