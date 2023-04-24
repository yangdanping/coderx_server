const errorTypes = require('../constants/error-types');
const userService = require('../service/user.service.js');
const { emitErrMsg, encryptPwd } = require('../utils');

// ★1.用户注册验证中间件---------------------------------------------------
const verifyUserRegister = async (ctx, next) => {
  // 1.获取用户名和密码
  const { name, password } = ctx.request.body;
  // 2.判断用户名/密码不能为空(null/undefined/空字符串取反都是true,都会进到这里面来)
  if (!name || !password) {
    console.log(`verifyUserRegister<用户名/密码>校验---用户名${name ? name : '为空'},用户密码${password ? password : '为空'}`);
    return emitErrMsg(ctx, errorTypes.NAME_OR_PWD_IS_INCORRECT); //进到这里,我就要发射错误信息,在另外一个地方通过ctx.app.on拿到这个错误信息,而且return后,后续的代码都不会执行了
  } else {
    console.log('verifyUserRegister<用户名/密码>校验---用户名/密码不为空,可进行用户<存在>校验');
  }
  // 3.判断这次注册的用户名是没有被注册过
  const user = await userService.getUserByName(name); //若没查到,则user为undefined
  if (user) {
    console.log(`verifyUserSignin<存在>校验---根据用户名查找到同名用户`);
    return emitErrMsg(ctx, errorTypes.USERNAME_EXISTS);
  } else {
    console.log('verifyUserSignin<存在>校验---该用户是新用户,可进行注册');
    await next();
  }
};

// ★2.用户密码加密中间件---------------------------------------------------
const encryptUserPwd = async (ctx, next) => {
  console.log('验证密码加密');
  let { password } = ctx.request.body;
  ctx.request.body.password = encryptPwd(password);
  await next();
};

// ★3.用户登陆验证中间件---------------------------------------------------
const verifyUserLogin = async (ctx, next) => {
  // 1.获取用户名/密码,对其进行校验
  const { name, password } = ctx.request.body;
  console.log(name, password);
  // console.log(name, password);
  // 2.判断用户名/密码是否为空,一旦为空,后面的校验也就不用再进行,直接退出函数
  if (!name || !password) {
    console.log(`verifyUserLogin<用户名与密码>校验---用户名${name ? name : '为空'},用户密码${password ? password : '为空'}`);
    return emitErrMsg(ctx, errorTypes.NAME_OR_PWD_IS_INCORRECT);
  } else {
    console.log('verifyUserLogin<用户名与密码>校验---用户名/密码不为空,可进行用户<存在>校验');
  }
  // 3.判断用户是否存在,用户不存在,后面的校验也就不用再进行,直接退出函数(此处逻辑与user中间件相反)
  const user = await userService.getUserByName(name); //拿到result是个数组,加[]取第一个元素,即该用户在数据库中的完整数据(包含所有字段)
  console.log(user);
  if (!user) {
    console.log('verifyUserLogin<存在>校验---该用户不存在,登陆失败');
    return emitErrMsg(ctx, errorTypes.USER_DOES_NOT_EXISTS);
  } else {
    console.log('verifyUserLogin<存在>校验---该用户存在,可进行加密校验');
  }

  // 4.判断用户输入的原始密码是否和数据库中的加密后的密码(user.password)一致(存入数据库的密码必须先加密)
  if (encryptPwd(password) !== user.password) {
    return emitErrMsg(ctx, errorTypes.PWD_IS_INCORRECT);
  } else {
    ctx.user = user; //颁发令牌的前期工作,user作为令牌的payload
    await next();
  }
};

module.exports = {
  verifyUserRegister,
  encryptUserPwd,
  verifyUserLogin
};
