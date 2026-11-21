import { extname } from 'node:path';
import { createFactory } from 'hono/factory';
import { z } from 'zod';
import Result from '../app/Result.js';
import { describeArticleVideo } from '../service/articleMedia.service.js';
import { resolveArticleTags } from '../service/articleTags.service.js';
import type { ArticleLikeService, ArticleService, FileLookup } from '../service/article/article.types.js';
import type { HistoryService } from '../service/history/history.service.js';
import type { TagService } from '../service/tag/tag.service.js';
import { parseDraftInteger, structuredObject } from '../http/articleDraftInput.js';
import { isLocalMediaFilename, localFileResponse, openLocalMedia } from '../http/fileResponseBody.js';
import { bodyFields, pagination, queryValue } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

interface ArticleControllerDependencies {
  service: ArticleService;
  likeService: ArticleLikeService;
  fileService: FileLookup;
  historyService: Pick<HistoryService, 'addHistory'>;
  tagService: Pick<TagService, 'getTagByName' | 'addTag'>;
  imageRoot: string;
  videoRoot: string;
}

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: articleHandlers } = createFactory<AppEnv, '/article/:articleId' | `/article/:articleId/${string}`>();
const { createHandlers: mediaHandlers } = createFactory<AppEnv, '/article/images/:filename' | '/article/video/:filename'>();
const articleTags = z.union([z.string(), z.array(z.unknown())]);
const blockedText = '文章已被封禁';

function parseArticleInput(body: unknown) {
  const { title, contentJson = null, draftId: rawDraftId } = bodyFields(body);
  const hasDraftId = rawDraftId != null && rawDraftId !== '';
  const draftId = hasDraftId ? parseDraftInteger(rawDraftId, 1) : null;
  if (hasDraftId && draftId === null) return { ok: false as const, message: '参数错误: draftId 必须是正整数' };

  const parsed = structuredObject.nullable().safeParse(contentJson);
  if (!parsed.success) return { ok: false as const, message: '参数错误: contentJson 必须是对象' };
  if (parsed.data === null && draftId === null) return { ok: false as const, message: '参数错误: contentJson 不能为空' };
  return { ok: true as const, title, draftId, contentJson: parsed.data };
}

export function createArticleController({
  service, likeService, fileService, historyService, tagService, imageRoot, videoRoot,
}: ArticleControllerDependencies) {
  return {
    getList: createHandlers(async c => {
      const search = new URL(c.req.url).searchParams;
      const { offset, limit } = pagination(search);
      const tagId = queryValue(search, 'tagId');
      const userId = queryValue(search, 'userId');
      const pageOrder = queryValue(search, 'pageOrder') === 'hot' ? 'hot' : 'date';
      const idList = queryValue(search, 'idList');
      const keywords = queryValue(search, 'keywords');
      const collectedIds: unknown = idList?.length ? JSON.parse(String(idList)) : [];

      const result = await service.getArticleList(offset, limit, tagId, userId, pageOrder, collectedIds, keywords);
      for (const article of result) {
        if (article.status) {
          article.title = blockedText;
          article.excerpt = blockedText;
        } else article.excerpt = typeof article.excerpt === 'string' ? article.excerpt.slice(0, 50) : '';
        delete article.content;
      }

      const total = await service.getTotal(tagId, userId, collectedIds, keywords);
      return legacyJson(c, Result.success({ result, total }));
    }),
    getRecommendList: createHandlers(async c => {
      const { offset, limit } = pagination(new URL(c.req.url).searchParams);
      return legacyJson(c, Result.success(await service.getRecommendArticleList(offset, limit)));
    }),
    search: createHandlers(async c => {
      const keywords = queryValue(new URL(c.req.url).searchParams, 'keywords');
      return legacyJson(c, Result.success(await service.getArticlesByKeyWords(keywords)));
    }),
    getRandomTocArticle: createHandlers(async c => legacyJson(c, Result.success(await service.getRandomTocArticle()))),
    getDetail: articleHandlers(async c => {
      const articleId = c.req.param('articleId');
      const article = await service.getArticleById(articleId);
      const userId = authUserId(c.get('user'));
      if (userId) {
        try {
          await historyService.addHistory(userId, articleId);
        } catch (error) {
          console.log('添加浏览记录失败:', error);
        }
      }
      if (article.status) {
        article.title = blockedText;
        article.excerpt = blockedText;
        article.content = blockedText;
        article.contentHtml = blockedText;
        article.contentJson = null;
        article.images = [];
        article.videos = [];
      }
      return legacyJson(c, Result.success(article));
    }),
    getArticleLikedById: articleHandlers(async c =>
      legacyJson(c, Result.success(await service.getArticleLikedById(c.req.param('articleId')))),
    ),
    addArticle: createHandlers(async c => {
      const input = parseArticleInput(c.get('parsedBody'));
      if (!input.ok) return legacyJson(c, Result.fail(input.message));
      const result = await service.addArticle(authUserId(c.get('user')), input.title, input.draftId, input.contentJson);
      return legacyJson(c, Result.success(result));
    }),
    likeArticle: articleHandlers(async c => {
      const articleId = c.req.param('articleId');
      const { isLiked } = await likeService.toggleArticleLike(articleId, authUserId(c.get('user')));
      const { likes } = await service.getArticleLikedById(articleId);
      return legacyJson(c, Result.success({ liked: isLiked, likes: likes || 0 }));
    }),
    changeTag: articleHandlers(async c => {
      const articleId = c.req.param('articleId');
      const parsed = articleTags.safeParse(bodyFields(c.get('parsedBody')).tags);
      if (!parsed.success) throw new TypeError('tags is not iterable');
      const tags = await resolveArticleTags(parsed.data, tagService);
      await service.clearTag(articleId);
      if (!tags.length) return legacyJson(c, Result.success('标签已清空'));
      return legacyJson(c, { data: await service.batchAddTags(articleId, tags.map(tag => tag.id)), code: '标签保存成功' });
    }),
    viewArticle: articleHandlers(async c => legacyJson(c, Result.success(await service.addView(c.req.param('articleId'))))),
    update: articleHandlers(async c => {
      const input = parseArticleInput(c.get('parsedBody'));
      if (!input.ok) return legacyJson(c, Result.fail(input.message));
      const result = await service.update(authUserId(c.get('user')), input.title, c.req.param('articleId'), input.draftId, input.contentJson);
      return legacyJson(c, Result.success(result));
    }),
    delete: articleHandlers(async c => {
      const articleId = c.req.param('articleId');
      const { result, localCleanup } = await service.delete(articleId, authUserId(c.get('user')));
      if (localCleanup?.pendingIds?.length) {
        console.warn(`文章 ${articleId} 的 ${localCleanup.pendingIds.length} 个本地文件已进入持久化重试队列`);
      }
      return legacyJson(c, Result.success(result));
    }),
    getFileInfo: mediaHandlers(async c => {
      let filename = c.req.param('filename');
      const missing = () => c.req.method === 'HEAD' ? c.body(null, 404) : c.notFound();
      if (!isLocalMediaFilename(filename)) return missing();
      const file = await fileService.getFileByFilename(filename);
      if (!file) return missing();
      if (queryValue(new URL(c.req.url).searchParams, 'type') === 'small') {
        const extension = extname(filename);
        filename = filename.replace(extension, `-small${extension}`);
      }
      const asset = await openLocalMedia(imageRoot, filename);
      if (!asset) return missing();
      return localFileResponse(c, asset, file.mimetype);
    }),
    getVideoInfo: mediaHandlers(async c => {
      try {
        const filename = c.req.param('filename');
        const asset = await openLocalMedia(videoRoot, filename);
        if (!asset) return legacyJson(c, Result.fail('视频文件不存在'), 404);
        const file = describeArticleVideo(filename, asset.size, c.req.header('range'));
        if (file.status === 416) {
          await asset.handle.close();
          c.header('Content-Range', file.contentRange);
          return legacyJson(c, Result.fail(file.message), 416);
        }
        c.header('Content-Length', String(file.length));
        if (file.status === 206) {
          c.header('Content-Range', file.contentRange);
          c.header('Accept-Ranges', 'bytes');
        }
        return localFileResponse(c, asset, file.contentType, file.status, file.range);
      } catch (error) {
        console.error('getVideoInfo error:', error);
        return legacyJson(c, Result.fail(`获取视频失败: ${error instanceof Error ? error.message : undefined}`), 500);
      }
    }),
  };
}
