// 400系列错误 - 客户端错误
const NAME_OR_PWD_IS_INCORRECT = '用户名或密码输入不正确';
const USERNAME_EXISTS = '用户名已存在';
const USER_DOES_NOT_EXISTS = '用户不存在,请注册';
const PWD_IS_INCORRECT = '用户密码错误';
const UNAUTH = '未认证/token无效';
const UNPERMISSION = '不具备操作的权限';
const NAME_EXISTS = '命名已存在';

// 500系列错误 - 服务器错误
const INTERNAL_SERVER_ERROR = '服务器内部错误';
const DATABASE_ERROR = '数据库操作失败';
const SERVICE_UNAVAILABLE = '服务暂时不可用';

module.exports = {
  // 400系列
  NAME_OR_PWD_IS_INCORRECT,
  USERNAME_EXISTS,
  USER_DOES_NOT_EXISTS,
  PWD_IS_INCORRECT,
  UNAUTH,
  UNPERMISSION,
  NAME_EXISTS,
  // 500系列
  INTERNAL_SERVER_ERROR,
  DATABASE_ERROR,
  SERVICE_UNAVAILABLE
};
