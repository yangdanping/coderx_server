const jwt = require('jsonwebtoken');
const authService = require('../service/auth.service');
const errorTypes = require('../constants/error-types');
const { emitErrMsg } = require('../utils');
const { PUBLIC_KEY } = require('../app/config');
const Result = require('../app/Result');

/* ★1.验证授权中间件------------------------------------------
很重要!很常用!加了该中间件的接口每次请求都会验证是否有token/token是否过期 */
const verifyAuth = async (ctx, next) => {
  const authorization = ctx.headers.authorization;
  if (!authorization) return emitErrMsg(ctx, errorTypes.UNAUTH); //若header中没有携带token信息,则报错无效的token
  const token = authorization.replace('Bearer ', '');
  console.log('拿到了token', token);
  // 2.验证token(记得导入之前设置好的公钥,拿到的结果是之前颁发token时携带的数据(id/name/颁发时间/过期时间))
  // jwt验证失败后会直接抛出异常,所以要try/catch捕获该异常,否则就会直接报错
  try {
    const verifyResult = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] });
    ctx.user = verifyResult; //记得把拿到的结果(id/name/.../颁发时间/过期时间)保存到user,到时用户发布动态等要用到
    await next(); //验证成功,则直接调用next
  } catch (error) {
    return emitErrMsg(ctx, errorTypes.UNAUTH);
  }
};

// -----------------------------------------------------------------------------------
// ★★★2.验证权限中间件---------------------------------------------------
/* 该中间件非常重要!1.很多内容(动态/评论/其他)的更新/删除都需要验证权限:
2.当前我写的接口都属于业务接口,但若是后台管理系统里怎么验证这个人是否具备权限呢?
首先它其实会有一对一的关系: 在后台管理系统中的用户与角色(role)是一对一的关系,即一个用户必然有一个角色,而角色有很多的权限
多对多的关系: 即我的角色(role)和我们的权限,如菜单里面的选项,里面有删除/修改/动态
到时我就看这个角色具不具备某个选项,具备返回true,不具备返回false,只需做个查询即可,(后面写标签时也会有多对多) */
const verifyPermission = async (ctx, next) => {
  console.log('<验证权限>中间件------------------');
  // 1.获取修改的数据的id/用户的id,判断该数据是否由id发出
  const [urlKey] = Object.keys(ctx.params); //从params中取出对象的key,即我们拼接的资源id,如评论就是commentId
  const dataId = ctx.params[urlKey]; //获取到表id的值
  console.log('verifyPermission dataId', dataId);
  const tableName = urlKey.replace('Id', ''); //把Id去掉就是表名
  console.log('verifyPermission tableName', tableName);
  const userId = ctx.user.id;
  console.log('verifyPermission userId', userId);
  // 2.验证权限(该状态是由谁发出的,则只能由谁修改)
  try {
    const isPermission = await authService.checkPermission(tableName, dataId, userId);
    if (!isPermission) throw new Error(); //抛出异常后直接到catch
  } catch (error) {
    return emitErrMsg(ctx, errorTypes.UNPERMISSION);
  }
  await next(); //验证成功,则直接调用next
};

// ★3.验证状态中间件------------------------------------------
const verifyStatus = async (ctx, next) => {
  const { id } = ctx.user;
  const result = await authService.checkStatus(id);
  console.log('verifyStatus!!!!!', result);
  result === '0' ? await next() : (ctx.body = Result.fail('您已被封禁'));
};
module.exports = {
  verifyAuth,
  verifyStatus,
  verifyPermission
};
