import type { DatabaseAdapter, MutationResult, QueryExecutor } from '../app/database/database.types.js';
import BusinessError from '../errors/BusinessError.js';
import { validateOptionalNickname } from '../utils/nickname.js';
import { hydrateAvatarUrls } from '../utils/publicAssetUrls.js';
import type { createNotificationService, NotificationResult } from './notification.factory.js';
import {
  buildGetArticleByCollectIdExecuteParams,
  buildGetArticleByCollectIdSql,
  buildGetCommentByIdExecuteParams,
  buildGetCommentByIdSql,
  buildGetFollowInfoSql,
  buildGetHotUsersSql,
  buildGetLikedByIdSql,
  buildGetProfileByIdSql,
  buildGetUserByNameSql,
} from './sql/user.sql.js';

type UserId = string | number;
type LikeAction = 'liked' | 'unliked';
type CollectionIdInput = Parameters<typeof buildGetArticleByCollectIdExecuteParams>[1];

interface UserAccount {
  id: UserId;
  name: string;
  password: string;
}

interface UserRegistration {
  name: unknown;
  password: unknown;
  nickname?: unknown;
}

interface UserIdentity {
  id: UserId;
  name: string;
}

interface UserDisplayIdentity {
  id: UserId | null;
  name: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  sex: string | null;
  career: string | null;
}

interface UserProfile extends UserIdentity {
  status: boolean;
  nickname: string | null;
  avatarUrl: string | null;
  age: number | null;
  sex: string | null;
  email: string | null;
  career: string | null;
  address: string | null;
  articleCount: number | string;
  commentCount: number | string;
}

interface HotUser extends Omit<UserProfile, 'status' | 'articleCount' | 'commentCount'> {
  articleInfo: { totalLikes: number; totalViews: number | null };
}

interface UserComment {
  id: UserId;
  title: string | null;
  content: string;
  commentId: UserId | null;
  createAt: Date | string;
  user: Omit<UserDisplayIdentity, 'sex' | 'career'>;
  likes: number | string;
}

interface UserLiked extends UserIdentity {
  articleLiked: UserId[] | null;
  commentLiked: UserId[] | null;
}

interface UserFollow extends UserIdentity {
  following: UserDisplayIdentity[] | null;
  follower: UserDisplayIdentity[] | null;
}

interface CollectedArticle {
  id: UserId | null;
  title: string | null;
  excerpt: string | null;
  createAt: Date | string | null;
}

interface UserServiceDependencies {
  connection: DatabaseAdapter;
  baseURL: string;
  notificationService: Pick<ReturnType<typeof createNotificationService>, 'createFollowNotification'>;
  publishNotificationCreated: (notification: unknown) => Promise<unknown>;
}

interface ToggleFollowResult {
  isFollowed: boolean;
  action: 'followed' | 'unfollowed';
  notificationCreated: boolean;
  notification: NotificationResult['notification'];
}

const PROFILE_COLUMN_BY_API_KEY: Readonly<Partial<Record<string, string>>> = {
  avatarUrl: 'avatar_url',
  age: 'age',
  sex: 'sex',
  phone: 'phone',
  email: 'email',
  career: 'career',
  address: 'address',
  sign: 'sign',
  nickname: 'nickname',
};

/**
 * The old service and HTTP routes log these failures and omit the result.
 * Keep this mapping at the compatibility boundary so the query methods can reject.
 */
export async function legacyUserQueryResult<T>(query: Promise<T>): Promise<T | undefined> {
  try {
    return await query;
  } catch (error) {
    console.log(error);
    return undefined;
  }
}

export function createUserService({ connection, baseURL, notificationService, publishNotificationCreated }: UserServiceDependencies) {
  return new (class UserService {
    getUserByName = async (name: unknown): Promise<UserAccount | undefined> => {
      const statement = buildGetUserByNameSql();
      const [result] = await connection.execute(statement, [name]);
      return (result as UserAccount[])[0];
    };
    addUser = async (user: UserRegistration): Promise<MutationResult> => {
      // 获取独立连接以支持事务
      const conn = await connection.getConnection();
      try {
        // 开始事务
        await conn.beginTransaction();

        const { name, password, nickname } = user;
        const normalizedNickname = validateOptionalNickname(nickname);

        // 第一步：插入用户表
        const statement1 = 'INSERT INTO "user" (name, password) VALUES (?, ?) RETURNING id;';
        const [result] = await conn.execute(statement1, [name, password]);

        // 第二步：插入用户信息表，关联新用户ID
        const statement2 = 'INSERT INTO profile (user_id, nickname) VALUES (?, ?);';
        const inserted = result as MutationResult;
        await conn.execute(statement2, [inserted.insertId, normalizedNickname]);

        // 提交事务：两条SQL一起生效
        await conn.commit();

        return inserted; // 返回用户表插入结果
      } catch (error) {
        // 回滚事务：撤销所有操作
        await conn.rollback();
        throw error; // 抛出错误让上层处理
      } finally {
        // 释放连接回连接池
        conn.release();
      }

      // try {
      //   const { name, password } = user;
      //   const statement = 'INSERT INTO user (name,password) VALUES (?,?);';
      //   const [result] = await connection.execute(statement, [name, password]);
      //   if (result.affectedRows) {
      //     try {
      //       const statement = 'INSERT INTO profile (user_id) VALUES (?);';
      //       await connection.execute(statement, [result.insertId]);
      //       return result; //把插入用户表成功的结果返回,而非用户信息表
      //     } catch (error) {
      //       console.log(error);
      //     }
      //   }
      // } catch (error) {
      //   console.log(error);
      // }
    };
    updateAvatarUrl = async (avatarUrl: string, userId: unknown, conn: QueryExecutor | null = null): Promise<MutationResult> => {
      const statement = `UPDATE profile SET avatar_url = ? WHERE user_id = ?;`;
      const execute = conn ? conn.execute.bind(conn) : connection.execute.bind(connection);
      const [result] = await execute(statement, [avatarUrl, userId]);
      return result as MutationResult;
    };
    getProfileById = async (userId: UserId): Promise<UserProfile | undefined> => {
      const statement = buildGetProfileByIdSql();
      const [result] = await connection.execute(statement, [userId]);
      return hydrateAvatarUrls((result as UserProfile[])[0], baseURL);
    };
    updateProfileById = async (userId: unknown, profile: unknown): Promise<MutationResult | null> => {
      const fields = profile as Record<string, unknown>;
      const keys = Object.keys(fields);
      if (keys.length === 0) return null;

      const unsupportedKey = keys.find((key) => !PROFILE_COLUMN_BY_API_KEY[key]);
      if (unsupportedKey) {
        throw new BusinessError('个人资料字段不受支持', 400);
      }

      const updateItem = keys.map((key) => `${PROFILE_COLUMN_BY_API_KEY[key]} = ?`).join(', ');
      const updateValues = keys.map((key) => (key === 'nickname' ? validateOptionalNickname(fields[key]) : fields[key]));
      const statement = `UPDATE profile SET ${updateItem} WHERE user_id = ?;`;

      const [result] = await connection.execute(statement, [...updateValues, userId]);
      return result as MutationResult;
    };

    // getCommentById = async (userId, offset, limit) => {
    //   try {
    //     const statement = `
    //     SELECT c.id, a.title,c.content, c.comment_id commentId, c.create_at createAt,
    //     JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) user,
    //     COUNT(cl.user_id) likes
    //     FROM comment c
    //     LEFT JOIN article a ON c.article_id = a.id
    //     LEFT JOIN user u ON u.id = c.user_id
    //     LEFT JOIN profile p ON u.id = p.user_id
    //     LEFT JOIN comment_like cl ON c.id = cl.comment_id
    //     WHERE u.id LIKE '%${userId}%'
    //     GROUP BY c.id
    //     ORDER BY c.update_at DESC;
    //     LIMIT ?,?;
    //     `;
    //     // const statement = `
    //     // SELECT a.id id,a.title title,c.content content,c.create_at createAt
    //     // FROM comment c
    //     // LEFT JOIN article a
    //     // ON c.article_id = a.id
    //     // WHERE c.user_id = ?
    //     // LIMIT ?,?;
    //     // `;
    //     const [result] = await connection.execute(statement, [userId, offset, limit]);
    //     return result;
    //   } catch (error) {
    //     console.log(error);
    //   }
    // };

    getCommentById = async (userId: UserId, offset: string | number, limit: string | number): Promise<UserComment[]> => {
      const statement = buildGetCommentByIdSql();
      const executeParams = buildGetCommentByIdExecuteParams(userId, String(offset), String(limit));
      const [result] = await connection.execute(statement, executeParams);
      return hydrateAvatarUrls(result as UserComment[], baseURL);
    };

    hasLike = async (tableName: string, dataId: unknown, userId: unknown): Promise<boolean> => {
      const whiteList = ['article', 'comment', 'video'];
      if (!whiteList.includes(tableName)) return false;

      const statement = `SELECT * FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return Boolean((result as unknown[])[0]);
    };

    changeLike = async (tableName: string, dataId: unknown, userId: unknown, isLike: unknown): Promise<MutationResult | null> => {
      const whiteList = ['article', 'comment', 'video'];
      if (!whiteList.includes(tableName)) return null;

      const statement = !isLike
        ? `INSERT INTO ${tableName}_like (${tableName}_id,user_id) VALUES (?,?);`
        : `DELETE FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return result as MutationResult;
    };

    // 优化：点赞/取消点赞切换，减少数据库查询
    toggleLike = async (tableName: string, dataId: unknown, userId: unknown): Promise<{ isLiked: boolean; action: LikeAction }> => {
      const whiteList = ['article', 'comment', 'video'];
      if (!whiteList.includes(tableName)) {
        throw new BusinessError('非法的表名', 400);
      }

      // 先尝试删除
      const deleteStmt = `DELETE FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [deleteResult] = await connection.execute(deleteStmt, [dataId, userId]);

      // 如果删除了行，说明之前已点赞，现在取消
      if ((deleteResult as Pick<MutationResult, 'affectedRows'>).affectedRows > 0) {
        return { isLiked: false, action: 'unliked' };
      }

      // 如果没删除任何行，说明之前未点赞，现在添加
      const insertStmt = `INSERT INTO ${tableName}_like (${tableName}_id, user_id) VALUES (?, ?);`;
      await connection.execute(insertStmt, [dataId, userId]);
      return { isLiked: true, action: 'liked' };
    };

    getLikedById = async (userId: UserId): Promise<UserLiked | undefined> => {
      const statement = buildGetLikedByIdSql();
      const [result] = await connection.execute(statement, [userId]);
      return (result as UserLiked[])[0];
    };

    hasFollowed = async (userId: unknown, followerId: unknown): Promise<boolean> => {
      const statement = `SELECT * FROM user_follow WHERE user_id = ? AND follower_id= ?;`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return Boolean((result as unknown[])[0]);
    };

    follow = async (userId: unknown, followerId: unknown): Promise<MutationResult> => {
      const statement = `INSERT INTO user_follow (user_id,follower_id) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result as MutationResult;
    };

    unfollow = async (userId: unknown, followerId: unknown): Promise<MutationResult> => {
      const statement = `DELETE FROM user_follow WHERE user_id = ? AND follower_id = ?;`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result as MutationResult;
    };

    // 优化：关注/取关切换，减少数据库查询
    toggleFollow = async (userId: UserId, followerId: unknown): Promise<ToggleFollowResult> => {
      const conn = await connection.getConnection();
      let notificationResult: NotificationResult = { created: false, notification: null };

      try {
        await conn.beginTransaction();

        // 先尝试删除
        const deleteStmt = `DELETE FROM user_follow WHERE user_id = ? AND follower_id = ?;`;
        const [deleteResult] = await conn.execute(deleteStmt, [userId, followerId]);

        // 如果删除了行，说明之前已关注，现在取关；取关不产生负反馈通知。
        if ((deleteResult as Pick<MutationResult, 'affectedRows'>).affectedRows > 0) {
          const result: ToggleFollowResult = {
            isFollowed: false,
            action: 'unfollowed',
            notificationCreated: false,
            notification: null,
          };
          await conn.commit();
          return result;
        }

        // 如果没删除任何行，说明之前未关注，现在添加
        const insertStmt = `INSERT INTO user_follow (user_id, follower_id) VALUES (?, ?);`;
        await conn.execute(insertStmt, [userId, followerId]);

        notificationResult = await notificationService.createFollowNotification(
          {
            recipientId: userId,
            actorId: followerId,
          },
          { conn },
        );

        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }

      if (notificationResult.created && notificationResult.notification) {
        try {
          await publishNotificationCreated(notificationResult.notification);
        } catch (error) {
          console.warn('⚠️ 用户关注通知实时推送失败，将由 REST 同步兜底:', error instanceof Error ? error.message : String(error));
        }
      }

      return {
        isFollowed: true,
        action: 'followed',
        notificationCreated: notificationResult.created,
        notification: notificationResult.notification,
      };
    };

    getFollowInfo = async (userId: UserId): Promise<UserFollow | undefined> => {
      const statement = buildGetFollowInfoSql();
      const [result] = await connection.execute(statement, [userId]);
      return hydrateAvatarUrls((result as UserFollow[])[0], baseURL);
    };

    getArticleByCollectId = async (userId: UserId, collectId: CollectionIdInput, offset: string | number, limit: string | number): Promise<CollectedArticle[]> => {
      const statement = buildGetArticleByCollectIdSql();
      const executeParams = buildGetArticleByCollectIdExecuteParams(userId, collectId, String(offset), String(limit));
      const [result] = await connection.execute(statement, executeParams);
      return result as CollectedArticle[];
    };
    userReport = async (userId: number, reportOptions: string, articleId: unknown, commentId?: unknown): Promise<MutationResult> => {
      const statement = `INSERT INTO report (user_id,content,${articleId ? 'article_id' : 'comment_id'}) VALUES (?,?,?);`;
      console.log(statement);
      const [result] = await connection.execute(statement, [userId, reportOptions, articleId ? articleId : commentId]);
      return result as MutationResult;
    };
    // userFeedback = async (userId, content) => {
    //   try {
    //     const statement = `INSERT INTO feedback (user_id,content) VALUES (?,?);`;
    //     const [result] = await connection.execute(statement, [userId, content]);
    //     return result;
    //   } catch (error) {
    //     console.log(error);
    //   }
    // };
    // getReplyByUserId = async (userId) => {
    //   try {
    //     const statement = `
    //     SELECT f.id,u.name,f.content,a.name admin,f.reply,f.create_at createAt
    //     FROM feedback f
    //     LEFT JOIN user u ON u.id = f.user_id
    //     LEFT JOIN admin a ON a.id = f.admin_id
    //     WHERE f.user_id = ? AND f.reply IS NOT NULL
    //     ORDER BY f.create_at;`;
    //     const [result] = await connection.execute(statement, [userId]);
    //     return result;
    //   } catch (error) {
    //     console.log(error);
    //   }
    // };
    getHotUsers = async (): Promise<HotUser[]> => {
      const statement = buildGetHotUsersSql();
      const [result] = await connection.execute(statement);
      return hydrateAvatarUrls(result as HotUser[], baseURL);
    };
  })();
}
