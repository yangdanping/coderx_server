/**
 * 业务异常类
 * 用于在 Service/Controller 层抛出可预期的业务错误
 *
 * 与系统错误的区别：
 * - BusinessError: 业务逻辑错误（如"文章不存在"），需要告知用户具体原因
 * - Error: 系统错误（如数据库连接失败），返回通用错误信息
 *
 * @example
 * // 在 Service 层抛出
 * throw new BusinessError('文章不存在', 404);
 *
 * // 在 Controller 层抛出（带业务码）
 * throw new BusinessError('用户名已存在', 409, 40001);
 */
class BusinessError extends Error {
  /**
   * @param {string} message - 错误信息（会返回给前端）
   * @param {number} httpStatus - HTTP 状态码，默认 400
   * @param {number} bizCode - 业务错误码，默认等于 httpStatus（可选，用于更细粒度的错误区分）
   */
  constructor(message, httpStatus = 400, bizCode = null) {
    super(message);
    this.name = 'BusinessError';
    this.httpStatus = httpStatus;
    this.bizCode = bizCode ?? httpStatus; // 业务码默认等于 HTTP 状态码
    this.expose = true; // 标记：此错误信息可以暴露给客户端
  }
}

module.exports = BusinessError;
