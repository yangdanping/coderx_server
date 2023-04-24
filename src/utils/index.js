const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Utils {
  // 自动加载路由工具-----------------------------
  useRoutes() {
    //fs模块传入__dirname读取当前index文件所在的目录,返回的数组里面含有当前所在文件夹里的所有文件
    const routerDir = path.resolve(__dirname, '../router'); //C:\Users\daniel\Desktop\coderhub3.0\src\router
    fs.readdirSync(routerDir).forEach((file) => {
      if (file) {
        const router = require(path.resolve(routerDir, `./${file}`));
        this.use(router.routes()).use(router.allowedMethods());
        console.log(`路由文件${file}已注册`);
      } else {
        console.log(`路由文件${file}注册失败`);
      }
    });
  }
  // 密码加密工具-----------------------------
  encryptPwd(password) {
    const md5 = crypto.createHash('md5'); //采用md5加密,会返回一个md5对象
    try {
      const encryptedPwd = md5.update(password).digest('hex'); //调用md5对象的update方法可传入原始密码,返回的还是对象,调用其digest方法传入'hex'拿到返回加密后16进制的结果
      return encryptedPwd;
    } catch (error) {
      console.log(error);
    }
  }
  // 发送错误信息工具-----------------------------
  emitErrMsg(ctx, errortype) {
    const err = new Error(errortype); //Error对象有两个属性name和message
    return ctx.app.emit('error', err, ctx); //第一个参数表示发出去的事件是error事件,第二个参数表示你要给用户提示的错误信息
  }
  removeHTMLTag(str) {
    return str.replace(new RegExp('<(S*?)[^>]*>.*?|<.*? />|&nbsp; ', 'g'), '');
  }
}

module.exports = new Utils();

/* 若不像useRoutes中那样做,则需在app/index中需要路由需要想下面那样一个个导入
  // (2)用户路由的注册------------------
  app.use(userRouter.routes()); //再次强调,使用路由必须注册
  app.use(userRouter.allowedMethods()); //用于判断某个method是否支持,就不用自己设置状态码了,可判断某个请求方式有没有,若没有就返回不允许
  // (3)授权路由的注册------------------
  app.use(authRouter.routes());
  app.use(authRouter.allowedMethods()); */
