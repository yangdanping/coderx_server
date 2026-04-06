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

  /**
   * MySQL 用本地时间，PG（session timezone = GMT）用 UTC，
   * 确保游标时间戳与数据库内部表示匹配。
   *
   * 注意：必须用 dayjs.utc(input) 而非 dayjs(input).utc()，
   * 前者直接按 UTC 解析，后者先按本地时区解析再转 UTC 会偏移 8 小时。
   */
  static _formatTime = (timeInput, dialect) => {
    const d = dialect === 'pg' ? dayjs.utc(timeInput) : dayjs(timeInput);
    return d.format('YYYY-MM-DD HH:mm:ss.SSS');
  };

  /**
   * 构造游标查询条件（用于分页）
   * @param {string} cursor 游标格式："timestamp_id" 例如 "2024-01-01T00:00:00.000Z_123"
   * @param {string} direction 排序方向："DESC" 或 "ASC"
   * @param {string} dialect 数据库方言 "mysql" | "pg"
   * @returns {object} { condition: string, params: array }
   */
  static buildTimeCursorCondition = (cursor, direction = 'DESC', dialect = 'mysql') => {
    if (!cursor) return { condition: '', params: [] };

    const [cursorTime, cursorId] = cursor.split('_');
    const formatCursorTime = SqlUtils._formatTime(cursorTime, dialect);
    const isDesc = direction.toUpperCase() === 'DESC';

    // PG 存储微秒精度，JS Date 只有毫秒精度，直接比较会导致跨页重复。
    // 用 date_trunc 将 PG 端也截断到毫秒，确保双方精度一致。
    const col = dialect === 'pg' ? "date_trunc('milliseconds', c.create_at)" : 'c.create_at';

    return {
      condition: isDesc ? `AND (${col} < ? OR (${col} = ? AND c.id < ?))` : `AND (${col} > ? OR (${col} = ? AND c.id > ?))`,
      params: [formatCursorTime, formatCursorTime, cursorId],
    };
  };

  static buildCursorCondition = (cursor, direction = 'DESC', dialect = 'mysql') => {
    return SqlUtils.buildTimeCursorCondition(cursor, direction, dialect);
  };

  /**
   * 构造热门排序的游标查询条件
   * 排序规则：likes DESC -> replyCount DESC -> createAt DESC -> id DESC
   * @param {string} cursor 游标格式："likes_replyCount_timestamp_id"
   * @param {string} dialect 数据库方言 "mysql" | "pg"
   * @returns {object} { condition: string, params: array }
   */
  static buildHotCursorCondition = (cursor, dialect = 'mysql') => {
    if (!cursor) return { condition: '', params: [] };

    const [likes, replyCount, cursorTime, cursorId] = cursor.split('_');
    const formatCursorTime = SqlUtils._formatTime(cursorTime, dialect);
    const cursorLikes = Number(likes);
    const cursorReplyCount = Number(replyCount);
    const parsedCursorId = Number(cursorId);

    const q = (name) => (dialect === 'pg' ? `"${name}"` : name);
    const timeCol = dialect === 'pg' ? `date_trunc('milliseconds', hot_comments."createAt")` : 'hot_comments.createAt';

    return {
      condition: `AND (
        hot_comments.likes < ?
        OR (hot_comments.likes = ? AND hot_comments.${q('replyCount')} < ?)
        OR (hot_comments.likes = ? AND hot_comments.${q('replyCount')} = ? AND ${timeCol} < ?)
        OR (hot_comments.likes = ? AND hot_comments.${q('replyCount')} = ? AND ${timeCol} = ? AND hot_comments.id < ?)
      )`,
      params: [cursorLikes, cursorLikes, cursorReplyCount, cursorLikes, cursorReplyCount, formatCursorTime, cursorLikes, cursorReplyCount, formatCursorTime, parsedCursorId],
    };
  };

  /**
   * 生成下一页游标
   * @param {object} item 列表中的最后一项（需包含 createAt 和 id 字段）
   * @param {string} dialect 数据库方言 "mysql" | "pg"
   * @returns {string|null} 游标字符串(格式类似"timestamp_id")或 null
   */
  static buildNextCursor = (item, dialect = 'mysql') => {
    if (!item) return null;
    const createAtStr = SqlUtils._formatTime(item.createAt, dialect);
    return `${createAtStr}_${item.id}`;
  };

  /**
   * 生成热门排序下一页游标
   * @param {object} item 列表中的最后一项（需包含 likes、replyCount、createAt 和 id 字段）
   * @param {string} dialect 数据库方言 "mysql" | "pg"
   * @returns {string|null}
   */
  static buildHotNextCursor = (item, dialect = 'mysql') => {
    if (!item) return null;
    const createAtStr = SqlUtils._formatTime(item.createAt, dialect);
    return `${item.likes}_${item.replyCount}_${createAtStr}_${item.id}`;
  };
}

module.exports = SqlUtils;
