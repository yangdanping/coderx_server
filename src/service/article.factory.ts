import { readInsertedId } from '../app/database/queryResult.js';
import type { MutationResult } from '../app/database/database.types.js';
import { MEDIA_VARIANT } from '../constants/mediaStorage.js';
import BusinessError from '../errors/BusinessError.js';
import { docToExcerpt, docToHtml, hydrateStructuredContentMediaSources, resolveStructuredArticleContent } from '../utils/articleContent.js';
import { hydrateAvatarUrls } from '../utils/publicAssetUrls.js';
import type {
  ArticlePageOrder,
  ArticlePageValue,
  ArticleQueryValue,
  ArticleRow,
  ArticleService as ArticleServicePort,
  ArticleServiceDependencies,
  ArticleTransaction,
} from './article/article.types.js';
import {
  buildAddArticleSql,
  buildArticleListExecuteParams,
  buildArticleListQueryParams,
  buildGetArticleByIdSql,
  buildGetArticleListOptimizedSql,
  buildGetArticleListSql,
  buildGetTotalSql,
  buildGetArticlesByKeyWordsExecuteParams,
  buildGetArticlesByKeyWordsSql,
  buildGetRecommendArticleListExecuteParams,
  buildGetRecommendArticleListSql,
  buildGetRandomTocArticleSql,
} from './sql/article.sql.js';
import { DRAFT_TYPE, buildFindDraftForConsumeSql, buildConsumeDraftSql } from './sql/draft.sql.js';

type ArticleId = number | string;

interface ArticleMediaRow {
  id: ArticleId;
  filename: string;
  file_type: 'image' | 'video' | null;
  poster: string | null;
  transcode_status: string | null;
}

interface ArticleSearchRow {
  id: ArticleId;
  title: string;
  articleUrl: string;
}

interface RecommendedArticleRow extends ArticleSearchRow {
  views: number | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createArticleService({ connection, baseURL, redirectURL, mediaRuntime, localMediaCleanup }: ArticleServiceDependencies) {
  function normalizePositiveId(value: unknown) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }

    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }

    return null;
  }

  function normalizeOptionalDraftId(draftId: unknown) {
    if (draftId === undefined || draftId === null || draftId === '') {
      return null;
    }

    const normalizedDraftId = normalizePositiveId(draftId);
    if (normalizedDraftId === null) {
      throw new BusinessError('参数错误: draftId 必须是正整数', 400);
    }

    return normalizedDraftId;
  }

  async function lockDraftForConsume(conn: ArticleTransaction, { draftId, userId, articleId }: { draftId: number; userId: unknown; articleId: ArticleId | null }) {
    const hasArticleId = articleId != null && articleId !== '';
    const statement = buildFindDraftForConsumeSql({ hasArticleId, draftType: DRAFT_TYPE.ARTICLE });
    const params = hasArticleId ? [draftId, userId, articleId] : [draftId, userId];
    const [rows] = await conn.execute(statement, params);
    const draft = (rows as { content: unknown }[])[0];
    if (!draft) {
      throw new BusinessError('草稿不存在', 404);
    }
    return draft;
  }

  async function consumeDraftInTx(conn: ArticleTransaction, draftId: number, userId: unknown, consumedArticleId: unknown) {
    const statement = buildConsumeDraftSql(DRAFT_TYPE.ARTICLE);
    const [meta] = await conn.execute(statement, [draftId, userId, consumedArticleId]);
    if (!isRecord(meta) || typeof meta.affectedRows !== 'number' || !Number.isSafeInteger(meta.affectedRows) || meta.affectedRows < 1) {
      throw new BusinessError('草稿不存在', 404);
    }
  }

  function buildImageLookupByRows(rows: unknown) {
    const safeRows: unknown[] = Array.isArray(rows) ? rows : [];
    return safeRows.reduce<Partial<Record<number, { url: string }>>>((lookup, row) => {
      if (!isRecord(row)) return lookup;
      const imageId = normalizePositiveId(row.id);
      const url = typeof row.url === 'string' ? row.url : '';
      if (imageId && url) {
        lookup[imageId] = { url };
      }
      return lookup;
    }, {});
  }

  function buildVideoLookupByRows(rows: unknown) {
    const safeRows: unknown[] = Array.isArray(rows) ? rows : [];
    return safeRows.reduce<Partial<Record<number, { url: string; poster: string | null }>>>((lookup, row) => {
      if (!isRecord(row)) return lookup;
      const videoId = normalizePositiveId(row.id);
      const url = typeof row.url === 'string' ? row.url : '';
      if (videoId && url) {
        lookup[videoId] = {
          url,
          poster: typeof row?.poster === 'string' ? row.poster : null,
        };
      }
      return lookup;
    }, {});
  }

  async function buildArticleDerivedFields(structuredContent: unknown) {
    const normalizedStructuredContent = resolveStructuredArticleContent(structuredContent, null);
    if (!normalizedStructuredContent) {
      throw new BusinessError('参数错误: contentJson 不能为空', 400);
    }

    return {
      contentJson: normalizedStructuredContent,
      excerpt: docToExcerpt(normalizedStructuredContent),
    };
  }

  async function hydrateArticleDerivedFields(article: ArticleRow) {
    if (Array.isArray(article.images)) {
      article.images = await Promise.all(
        article.images.map(async (image: unknown) => {
          if (!isRecord(image)) return image;
          const imageId = normalizePositiveId(image.id);
          if (!imageId) return image;
          const resolvedUrl = await mediaRuntime.resolveImageUrl(imageId, {
            variant: MEDIA_VARIANT.ORIGINAL,
          });
          return resolvedUrl ? { ...image, url: resolvedUrl } : image;
        }),
      );
    }
    if (Array.isArray(article.videos)) {
      article.videos = await Promise.all(
        article.videos.map(async (video: unknown) => {
          if (!isRecord(video)) return video;
          const videoId = normalizePositiveId(video.id);
          if (!videoId) return video;
          const [resolvedUrl, resolvedPoster] = await Promise.all([mediaRuntime.resolveVideoUrl(videoId), mediaRuntime.resolveVideoPosterUrl(videoId)]);
          return {
            ...video,
            ...(resolvedUrl ? { url: resolvedUrl } : {}),
            poster: resolvedPoster || null,
          };
        }),
      );
    }
    const structuredContent = resolveStructuredArticleContent(article?.contentJson, null);
    const mediaContext = {
      imagesById: buildImageLookupByRows(article.images),
      videosById: buildVideoLookupByRows(article.videos),
    };

    if (!structuredContent) {
      article.contentHtml = '';
      article.excerpt = article.excerpt || '';
      return hydrateAvatarUrls(article, baseURL);
    }

    article.contentJson = hydrateStructuredContentMediaSources(structuredContent, mediaContext);
    article.contentHtml = docToHtml(article.contentJson, mediaContext);
    article.excerpt = article.excerpt || docToExcerpt(structuredContent) || '';
    return hydrateAvatarUrls(article, baseURL);
  }

  async function hydrateArticleListMedia(articles: ArticleRow[]) {
    await Promise.all(
      articles.map(async (article) => {
        const coverFileId = normalizePositiveId(article?.coverFileId);
        if (coverFileId) {
          article.cover = await mediaRuntime.resolveImageUrl(coverFileId, {
            variant: MEDIA_VARIANT.SMALL,
          });
        } else {
          article.cover = null;
        }
        delete article.coverFileId;
      }),
    );
    return articles;
  }

  class ArticleService implements ArticleServicePort {
    /**
     * 新增文章，并在同一事务内完成正文派生字段写入与可选草稿消费。
     *
     * 处理流程：
     * 1. 规范化并校验 `draftId`。
     * 2. 开启事务；当传入 `draftId` 时，先锁定这份可消费的 active 草稿，避免并发重复发布。
     * 3. 以请求体中的 `contentJson` 为优先正文；若未传则回退到已锁定草稿中的 `content`。
     * 4. 基于结构化正文派生写库字段：`contentJson` 本身，以及列表/历史/收藏等场景使用的 `excerpt` 摘要。
     * 5. 写入 `article` 表；若本次是从草稿发布，则把对应草稿标记为已消费并回填 `consumedArticleId`。
     * 6. 任一步骤失败都会回滚事务，确保文章写入与草稿消费状态保持一致。
     *
     * 注意：
     * - 该方法只接收结构化正文，不负责把 Markdown/HTML 转成 JSON。
     * - `excerpt` 不由调用方传入，而是由服务端从最终采用的 `contentJson` 自动派生。
     *
     * @param {number|string} userId 发布文章的用户 ID。
     * @param {string} title 文章标题。
     * @param {number|string|null} [draftId=null] 可选草稿 ID；传入时表示从该草稿发布。
     * @param {Record<string, unknown>|null} [contentJson=null] 可选结构化正文；为空时会尝试使用草稿内容。
     * @returns {Promise<object>} 数据库插入结果，通常包含新文章 ID 等写入信息。
     * @throws {BusinessError} 当 `draftId` 非法、草稿不存在、或最终无法解析出有效 `contentJson` 时抛出。
     * @throws {Error} 当数据库写入或事务执行失败时抛出原始错误。
     */
    addArticle = async (userId: unknown, title: unknown, draftId: unknown = null, contentJson: unknown = null) => {
      const normalizedDraftId = normalizeOptionalDraftId(draftId);
      const conn = await connection.getConnection();
      try {
        await conn.beginTransaction();
        let lockedDraft = null;
        if (normalizedDraftId != null) {
          lockedDraft = await lockDraftForConsume(conn, { draftId: normalizedDraftId, userId, articleId: null });
        }
        const derivedFields = await buildArticleDerivedFields(resolveStructuredArticleContent(contentJson, lockedDraft?.content));
        const statement = buildAddArticleSql();
        const [inserted] = await conn.execute(statement, [
          userId,
          title,
          derivedFields.contentJson ? JSON.stringify(derivedFields.contentJson) : null,
          derivedFields.excerpt || null,
        ]);
        const articleId = readInsertedId(inserted);
        if (normalizedDraftId != null) {
          await consumeDraftInTx(conn, normalizedDraftId, userId, articleId);
        }
        await conn.commit();
        return inserted;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    };

    /**
     * 增加浏览量
     *
     * 🧪 测试开关：切换下面两行 SQL 来验证全局错误中间件
     * - 正确 SQL：UPDATE article SET views = views + 1 WHERE id = ?
     * - 错误 SQL：故意拼错表名 "articl"（少个 e），触发数据库错误
     */
    addView = async (articleId: ArticleId) => {
      // ✅ 正确的 SQL（生产环境使用）
      const statement = 'UPDATE article SET views = views + 1 WHERE id = ?;';

      // ❌ 错误的 SQL（测试用：表名拼错，会触发 ER_NO_SUCH_TABLE 错误）
      // const statement = 'UPDATE articl SET views = views + 1 WHERE id = ?;';

      const [result] = await connection.execute(statement, [articleId]);
      return result as MutationResult;
    };

    /**
     * 根据 ID 获取文章详情
     * 重构说明：查询结果为空时抛出 BusinessError，便于 Controller 统一处理
     */
    getArticleById = async (articleId: ArticleId) => {
      const statement = buildGetArticleByIdSql(baseURL, redirectURL);
      const [result] = await connection.execute(statement, [articleId]);

      const article = (result as ArticleRow[])[0];
      if (!article) {
        throw new BusinessError('文章不存在', 404);
      }
      return hydrateArticleDerivedFields(article);
    };
    /**
     * 通过性能对比测试开关：切换getArticleList和getArticleListOptimized方法来对比性能差异
     */
    getArticleList = async (
      offset: ArticlePageValue,
      limit: ArticlePageValue,
      tagId: ArticleQueryValue = '',
      userId: ArticleQueryValue = '',
      pageOrder: ArticlePageOrder = 'date',
      idList: unknown = [],
      keywords: ArticleQueryValue = '',
    ) => {
      // return await this.getArticleListOptimized(offset, limit, tagId, userId, pageOrder, idList, keywords); // 🔧 取消注释以使用优化版本

      const queryParams = buildArticleListQueryParams(tagId, userId, idList, keywords);
      const statement = buildGetArticleListSql(baseURL, redirectURL, {
        tagId,
        userId,
        idList,
        keywords,
        pageOrder,
      });
      const executeParams = buildArticleListExecuteParams(queryParams, offset, limit);
      const [result] = await connection.execute(statement, executeParams);
      const articles = await hydrateArticleListMedia(result as ArticleRow[]);
      return hydrateAvatarUrls(articles, baseURL);
    };

    /**
     * ✅ 优化版本：使用 LEFT JOIN + 预聚合替代相关子查询
     *
     * 核心优化点：
     * 1. 将 4 个相关子查询改为预聚合 + LEFT JOIN
     * 2. 聚合查询只执行一次，然后通过 JOIN 关联结果
     * 3. 性能提升：O(n²) → O(n)，在大数据量下差异明显
     *
     * 性能对比（假设 20 条文章）：
     * - 旧版：1 + 20×4 = 81 次查询
     * - 新版：1 + 4 = 5 次查询（主查询 + 4 个预聚合子查询）
     */
    getArticleListOptimized = async (
      offset: ArticlePageValue,
      limit: ArticlePageValue,
      tagId: ArticleQueryValue = '',
      userId: ArticleQueryValue = '',
      pageOrder: ArticlePageOrder = 'date',
      idList: unknown = [],
      keywords: ArticleQueryValue = '',
    ) => {
      const queryParams = buildArticleListQueryParams(tagId, userId, idList, keywords);
      const statement = buildGetArticleListOptimizedSql(baseURL, redirectURL, {
        tagId,
        userId,
        idList,
        keywords,
        pageOrder,
      });
      const executeParams = buildArticleListExecuteParams(queryParams, offset, limit);
      const [result] = await connection.execute(statement, executeParams);
      const articles = await hydrateArticleListMedia(result as ArticleRow[]);
      return hydrateAvatarUrls(articles, baseURL);
    };

    getTotal = async (tagId: ArticleQueryValue = '', userId: ArticleQueryValue = '', idList: unknown = [], keywords: ArticleQueryValue = '') => {
      const queryParams = buildArticleListQueryParams(tagId, userId, idList, keywords);
      const statement = buildGetTotalSql({ tagId, userId, idList, keywords });
      const [result] = await connection.execute(statement, queryParams);
      const { total } = (result as { total: number | string }[])[0];
      return total;
    };
    update = async (userId: unknown, title: unknown, articleId: ArticleId, draftId: unknown = null, contentJson: unknown = null) => {
      const normalizedDraftId = normalizeOptionalDraftId(draftId);
      const conn = await connection.getConnection();
      try {
        await conn.beginTransaction();
        let lockedDraft = null;
        if (normalizedDraftId != null) {
          lockedDraft = await lockDraftForConsume(conn, { draftId: normalizedDraftId, userId, articleId });
        }
        const derivedFields = await buildArticleDerivedFields(resolveStructuredArticleContent(contentJson, lockedDraft?.content));
        const statement = `UPDATE article SET title = ?,content = ?::jsonb,excerpt = ? WHERE id = ?;`;
        const [updated] = await conn.execute(statement, [
          title,
          derivedFields.contentJson ? JSON.stringify(derivedFields.contentJson) : null,
          derivedFields.excerpt || null,
          articleId,
        ]);
        const result = updated as MutationResult;
        if (result.affectedRows < 1) {
          throw new BusinessError('文章不存在', 404);
        }
        if (normalizedDraftId != null) {
          await consumeDraftInTx(conn, normalizedDraftId, userId, articleId);
        }
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    };
    delete = async (articleId: unknown, userId: unknown) => {
      const normalizedArticleId = normalizePositiveId(articleId);
      const normalizedUserId = normalizePositiveId(userId);
      if (normalizedArticleId === null || normalizedUserId === null) {
        throw new BusinessError('参数错误: articleId 和 userId 必须是正整数', 400);
      }
      // 获取独立连接以支持事务
      const conn = await connection.getConnection();
      let imagesToDelete: Pick<ArticleMediaRow, 'id' | 'filename'>[];
      let videosToDelete: Pick<ArticleMediaRow, 'id' | 'filename' | 'poster'>[];
      let cleanupIds: number[];
      let result: MutationResult;

      try {
        // 开始事务
        await conn.beginTransaction();

        // 所有会同时触碰 article/file 的事务统一按 article -> file 顺序取锁，
        // 避免与视频关联更新形成锁顺序反转；服务层同时兜底校验文章归属。
        const [ownedArticles] = await conn.execute('SELECT id FROM article WHERE id = ? AND user_id = ? FOR UPDATE;', [normalizedArticleId, normalizedUserId]);
        if (!(ownedArticles as { id: ArticleId }[])[0]) {
          throw new BusinessError('文章不存在或无权删除', 403);
        }

        // 1. 锁定文章的全部逻辑媒体，阻止 promotion 在删除检查之后再创建 pending 行
        const statement1 = `
          SELECT f.id, f.filename, f.file_type, vm.poster, vm.transcode_status
          FROM file f
          LEFT JOIN video_meta vm ON f.id = vm.file_id
          WHERE f.article_id = ?
            AND (f.file_type IN ('image', 'video') OR f.file_type IS NULL)
          ORDER BY f.id ASC
          FOR UPDATE OF f;
        `;
        const [mediaResult] = await conn.execute(statement1, [normalizedArticleId]);
        const mediaRows = mediaResult as ArticleMediaRow[];
        const processingVideo = mediaRows.find((file) => file.file_type === 'video' && (file.transcode_status === 'pending' || file.transcode_status === 'processing'));
        if (processingVideo) {
          throw new BusinessError(`视频仍在处理中，请稍后重试删除文章（视频 ID: ${processingVideo.id}）`, 409);
        }
        imagesToDelete = mediaRows.filter((file) => file.file_type !== 'video').map((file) => ({ id: file.id, filename: file.filename }));
        videosToDelete = mediaRows.filter((file) => file.file_type === 'video').map((file) => ({ id: file.id, filename: file.filename, poster: file.poster }));

        console.log(`删除文章 ${articleId}:`, {
          图片数量: imagesToDelete.length,
          视频数量: videosToDelete.length,
        });

        // 2. 先幂等删除 R2 图片、视频和封面；失败则保留数据库与本地文件供安全重试
        await mediaRuntime.deleteR2ObjectsForFiles(mediaRows.map((file) => file.id));

        // 与业务删除同事务保存精确文件名；后续 unlink 失败/崩溃仍能从 outbox 重试。
        cleanupIds = await localMediaCleanup.enqueueInTransaction(conn, localMediaCleanup.buildLocalCleanupEntries(mediaRows));

        // 3. 删除 file 表中的所有关联记录（包括图片和视频）
        const statement2 = 'DELETE FROM file WHERE article_id = ?;';
        await conn.execute(statement2, [normalizedArticleId]);

        // 4. 删除文章（数据库会自动级联删除其他关联表：article_tag、article_like、article_collect、comment 等）
        const statement3 = 'DELETE FROM article WHERE id = ? AND user_id = ?;';
        const [deleted] = await conn.execute(statement3, [normalizedArticleId, normalizedUserId]);
        result = deleted as MutationResult;
        if (result.affectedRows !== 1) {
          throw new Error('delete article: locked article row was not deleted');
        }

        // 5. 提交事务
        await conn.commit();
      } catch (error) {
        // 回滚事务
        await conn.rollback();
        console.error('删除文章失败:', error);
        throw error;
      } finally {
        // 释放连接
        conn.release();
      }

      let localCleanup;
      try {
        localCleanup = await localMediaCleanup.processPending({ ids: cleanupIds });
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
        console.error('article delete local cleanup deferred for retry:', message);
        localCleanup = { examined: 0, deleted: 0, missing: 0, failed: cleanupIds.length, pendingIds: cleanupIds };
      }
      return { result, imagesToDelete, videosToDelete, localCleanup };
    };
    hasTag = async (articleId: ArticleId, tagId: ArticleId) => {
      const statement = `SELECT * FROM article_tag WHERE article_id = ? AND tag_id = ?;`;
      const [result] = await connection.execute(statement, [articleId, tagId]);
      return Boolean((result as unknown[])[0]);
    };
    addTag = async (articleId: ArticleId, tagId: ArticleId) => {
      const statement = `INSERT INTO article_tag (article_id,tag_id) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [articleId, tagId]);
      return result as MutationResult;
    };
    clearTag = async (articleId: ArticleId) => {
      const statement = `DELETE FROM article_tag WHERE article_id = ?;`;
      const [result] = await connection.execute(statement, [articleId]);
      return result as MutationResult;
    };
    /**
     * 重构说明：
     * 1. 批量插入使用 (?, ?) 占位符。
     * 2. 将数据展开为一维数组传递给 execute，确保安全性。
     */
    batchAddTags = async (articleId: ArticleId, tagIds: ArticleId[] | null | undefined) => {
      if (!tagIds || tagIds.length === 0) return null;
      const placeholders = tagIds.map(() => '(?, ?)').join(',');
      const queryParams: ArticleId[] = [];
      tagIds.forEach((tagId) => {
        queryParams.push(articleId, tagId);
      });
      const statement = `INSERT INTO article_tag (article_id,tag_id) VALUES ${placeholders};`;
      const [result] = await connection.execute(statement, queryParams);
      return result as MutationResult;
    };

    // getArticlesByKeyWords = async (keywords: ArticleQueryValue) => {
    //   try {
    //     const statement = `
    //     SELECT a.id,a.title,
    //     CONCAT('${redirectURL}/article/',a.id) articleUrl
    //     FROM article a where title LIKE '%${keywords}%' LIMIT 0,10`;
    //     const [result] = await connection.execute(statement);
    //     console.log('result', result);
    //     return result;
    //   } catch (error) {
    //     console.log(error);
    //   }
    // };

    /**
     * 重构说明：
     * 1. 使用 ? 占位符处理 LIKE 查询。
     */
    getArticlesByKeyWords = async (keywords: ArticleQueryValue) => {
      const statement = buildGetArticlesByKeyWordsSql(redirectURL);
      const params = buildGetArticlesByKeyWordsExecuteParams(keywords);
      const [result] = await connection.execute(statement, params);
      return result as ArticleSearchRow[];
    };
    findFileById = async (articleId: ArticleId) => {
      const statement = `SELECT f.filename FROM file f WHERE f.article_id = ?;`;
      const [result] = await connection.execute(statement, [articleId]);
      return result as { filename: string }[];
    };
    getArticleLikedById = async (articleId: ArticleId) => {
      const statement = `SELECT COUNT(al.user_id) likes FROM article a
        LEFT JOIN article_like al ON a.id = al.article_id
        WHERE a.id = ?;`;
      const [result] = await connection.execute(statement, [articleId]);
      return (result as { likes: number | string }[])[0];
    };
    getRecommendArticleList = async (offset: ArticlePageValue, limit: ArticlePageValue) => {
      const statement = buildGetRecommendArticleListSql(redirectURL);
      const params = buildGetRecommendArticleListExecuteParams(offset, limit);
      const [result] = await connection.execute(statement, params);
      return result as RecommendedArticleRow[];
    };

    getRandomTocArticle = async () => {
      const statement = buildGetRandomTocArticleSql();
      const [result] = await connection.execute(statement, []);
      const article = (result as { id: ArticleId }[])[0];
      if (!article) {
        throw new BusinessError('暂无可体验目录的文章', 404);
      }
      return article;
    };
  }
  return new ArticleService();
}
