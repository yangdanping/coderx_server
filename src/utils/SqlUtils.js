const dayjs = require('dayjs');

class SqlUtils {
  /**
   * 构造 SQL 的 IN 子句占位符
   * @param {string} column 字段名
   * @param {Array} list 数据数组
   * @param {string} prefix 前缀 (AND/OR/WHERE)
   * @returns {string} 构造好的 SQL 片段，例如 "AND id IN (?,?,?)"
   */
  static queryIn = (column, list, prefix = '') => {
    if (!Array.isArray(list) || list.length === 0) return '';
    const placeholders = list.map(() => '?').join(',');
    return `${prefix} ${column} IN (${placeholders})`;
  };

  /**
   * 构造游标查询条件（用于分页）
   * @param {string} cursor 游标格式："timestamp_id" 例如 "2024-01-01T00:00:00.000Z_123"
   * @param {string} direction 排序方向："DESC" 或 "ASC"
   * @returns {object} { condition: string, params: array }
   */
  static buildCursorCondition = (cursor, direction = 'DESC') => {
    if (!cursor) return { condition: '', params: [] };

    const [cursorTime, cursorId] = cursor.split('_'); // 解析游标格式
    // 使用 dayjs 解析时间,格式化为 MySQL 格式（本地时区）
    const formatCursorTime = dayjs(cursorTime).format('YYYY-MM-DD HH:mm:ss.SSS');
    const isDesc = direction.toUpperCase() === 'DESC';

    return {
      condition: isDesc ? `AND (c.create_at < ? OR (c.create_at = ? AND c.id < ?))` : `AND (c.create_at > ? OR (c.create_at = ? AND c.id > ?))`,
      params: [formatCursorTime, formatCursorTime, cursorId], // condition中对应的三个占位符参数
    };
  };

  /**
   * 生成下一页游标
   * @param {object} item 列表中的最后一项（需包含 createAt 和 id 字段）
   * @returns {string|null} 游标字符串(格式类似"timestamp_id")或 null
   */
  static buildNextCursor = (item) => {
    if (!item) return null;
    // 使用本地时间格式，与数据库存储格式保持一致，避免时区转换问题
    // dayjs 默认使用本地时区，format 方法会输出本地时间
    const createAtStr = dayjs(item.createAt).format('YYYY-MM-DD HH:mm:ss.SSS');
    return `${createAtStr}_${item.id}`;
  };
}

module.exports = SqlUtils;
