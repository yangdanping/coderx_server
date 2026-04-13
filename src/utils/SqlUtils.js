const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

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

  // PG 统一按 UTC 解析游标时间，避免本地时区造成翻页偏移。
  static _formatTime = (timeInput) => {
    return dayjs.utc(timeInput).format('YYYY-MM-DD HH:mm:ss.SSS');
  };

  /**
   * 构造游标查询条件（用于分页）
   * @param {string} cursor 游标格式："timestamp_id" 例如 "2024-01-01T00:00:00.000Z_123"
   * @param {string} direction 排序方向："DESC" 或 "ASC"
   * @returns {object} { condition: string, params: array }
   */
  static buildTimeCursorCondition = (cursor, direction = 'DESC') => {
    if (!cursor) return { condition: '', params: [] };

    const [cursorTime, cursorId] = cursor.split('_');
    const formatCursorTime = SqlUtils._formatTime(cursorTime);
    const isDesc = direction.toUpperCase() === 'DESC';

    // PG 存储微秒精度，JS Date 只有毫秒精度，用 date_trunc 保持一致。
    const col = "date_trunc('milliseconds', c.create_at)";

    return {
      condition: isDesc ? `AND (${col} < ? OR (${col} = ? AND c.id < ?))` : `AND (${col} > ? OR (${col} = ? AND c.id > ?))`,
      params: [formatCursorTime, formatCursorTime, cursorId],
    };
  };

  static buildCursorCondition = (cursor, direction = 'DESC') => {
    return SqlUtils.buildTimeCursorCondition(cursor, direction);
  };

  /**
   * 构造热门排序的游标查询条件
   * 排序规则：likes DESC -> replyCount DESC -> createAt DESC -> id DESC
   * @param {string} cursor 游标格式："likes_replyCount_timestamp_id"
   * @returns {object} { condition: string, params: array }
   */
  static buildHotCursorCondition = (cursor) => {
    if (!cursor) return { condition: '', params: [] };

    const [likes, replyCount, cursorTime, cursorId] = cursor.split('_');
    const formatCursorTime = SqlUtils._formatTime(cursorTime);
    const cursorLikes = Number(likes);
    const cursorReplyCount = Number(replyCount);
    const parsedCursorId = Number(cursorId);

    const timeCol = `date_trunc('milliseconds', hot_comments."createAt")`;

    return {
      condition: `AND (
        hot_comments.likes < ?
        OR (hot_comments.likes = ? AND hot_comments."replyCount" < ?)
        OR (hot_comments.likes = ? AND hot_comments."replyCount" = ? AND ${timeCol} < ?)
        OR (hot_comments.likes = ? AND hot_comments."replyCount" = ? AND ${timeCol} = ? AND hot_comments.id < ?)
      )`,
      params: [cursorLikes, cursorLikes, cursorReplyCount, cursorLikes, cursorReplyCount, formatCursorTime, cursorLikes, cursorReplyCount, formatCursorTime, parsedCursorId],
    };
  };

  /**
   * 生成下一页游标
   * @param {object} item 列表中的最后一项（需包含 createAt 和 id 字段）
   * @returns {string|null} 游标字符串(格式类似"timestamp_id")或 null
   */
  static buildNextCursor = (item) => {
    if (!item) return null;
    const createAtStr = SqlUtils._formatTime(item.createAt);
    return `${createAtStr}_${item.id}`;
  };

  /**
   * 生成热门排序下一页游标
   * @param {object} item 列表中的最后一项（需包含 likes、replyCount、createAt 和 id 字段）
   * @returns {string|null}
   */
  static buildHotNextCursor = (item) => {
    if (!item) return null;
    const createAtStr = SqlUtils._formatTime(item.createAt);
    return `${item.likes}_${item.replyCount}_${createAtStr}_${item.id}`;
  };
}

module.exports = SqlUtils;
