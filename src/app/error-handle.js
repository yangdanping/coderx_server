const errorTypes = require('../constants/error-types');
const Result = require('./Result');
// 只有发生了错误才会来到这,将user.middleware传过来的错误信息(error.message)进一步细化并传给用户
const errorHandler = (error, ctx) => {
  //由于我在emit时,都把error, ctx这两个发射出去了,所以这里可以拿到
  let code, msg;
  // console.log(Object.getOwnPropertyDescriptors(error));  //拿到error对象的message作为key
  switch (error.message) {
    //以后我有其他的错误信息我只需在这添加case,改变对应的code和massage
    case errorTypes.NAME_OR_PWD_IS_INCORRECT:
      code = 400; // Bad Request(参数传错/错误请求)
      msg = errorTypes.NAME_OR_PWD_IS_INCORRECT;
      break;
    case errorTypes.USERNAME_EXISTS:
      code = 409; // Conflict(发生冲突)
      msg = errorTypes.USERNAME_EXISTS;
      break;
    case errorTypes.NAME_EXISTS:
      code = 409; // Conflict(发生冲突)
      msg = errorTypes.NAME_EXISTS;
      break;
    case errorTypes.USER_DOES_NOT_EXISTS:
      code = 400; // Bad Request(参数传错/错误请求)
      msg = errorTypes.USER_DOES_NOT_EXISTS;
      break;
    case errorTypes.PWD_IS_INCORRECT:
      code = 400; // Bad Request(参数传错/错误请求)
      msg = errorTypes.PWD_IS_INCORRECT;
      break;
    case errorTypes.UNAUTH:
      code = 401; // Unauthorized
      msg = errorTypes.UNAUTH;
      break;
    case errorTypes.UNPERMISSION:
      code = 401; // Unauthorized
      msg = errorTypes.UNPERMISSION;
      break;
    default:
      code = 404; // Bad Request
      msg = 'NOT FOUND';
  }

  console.log(`error-handle返回客户端的错误信息---${msg}`); //控制台打印测试
  ctx.status = code;
  ctx.body = Result.fail(msg, code); //返回给客户端具体的错误信息,让用户看到错误信息
};

module.exports = errorHandler;
