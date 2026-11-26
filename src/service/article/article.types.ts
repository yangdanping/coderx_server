import type { DatabaseAdapter, DatabaseTransaction, QueryExecutor } from '../../app/database/database.types.js';

export type ArticleTransaction = DatabaseTransaction;
export type ArticleDatabase = DatabaseAdapter;

export interface MediaRuntimeDependencies {
  database: ArticleDatabase;
  imageRoot: string;
  videoRoot: string;
  publicApiOrigin: string;
  readMode: string;
  writeMode: string;
  writePaused: boolean | string;
  bucket: string;
  cdnBaseUrl: string;
  hardLimitBytes: number;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface MediaRuntime {
  promotePublishedImages(payload: { articleId?: number | string | null; images: readonly unknown[] }): Promise<unknown>;
  promotePublishedVideos(payload: { articleId?: number | string | null; videos: readonly unknown[] }): Promise<unknown>;
  resolveImageUrl(fileId: number, options?: { variant?: 'original' | 'small' }): Promise<string | null>;
  resolveVideoUrl(fileId: number): Promise<string | null>;
  resolveVideoPosterUrl(fileId: number): Promise<string | null>;
  deleteR2ObjectsForFiles(fileIds: (number | string)[]): Promise<unknown>;
  close(): void;
}

type CleanupMediaRow = { file_type?: string | null; filename?: string | null; poster?: string | null };
type CleanupEntry = { storageArea: 'image' | 'video'; filename: string };
type CleanupSummary = { examined: number; deleted: number; missing: number; failed: number; pendingIds: number[] };

export interface ArticleCleanup {
  buildLocalCleanupEntries(rows: CleanupMediaRow[]): CleanupEntry[];
  enqueueInTransaction(conn: ArticleTransaction, entries: CleanupEntry[]): Promise<number[]>;
  processPending(options: { ids: number[] }): Promise<CleanupSummary>;
}

export interface ArticleServiceDependencies {
  connection: ArticleDatabase;
  baseURL: string;
  redirectURL: string;
  mediaRuntime: Pick<MediaRuntime, 'resolveImageUrl' | 'resolveVideoUrl' | 'resolveVideoPosterUrl' | 'deleteR2ObjectsForFiles'>;
  localMediaCleanup: ArticleCleanup;
}

export type ArticleQueryValue = string | string[] | undefined;
export type ArticlePageOrder = 'date' | 'hot';
export type ArticlePageValue = string | number;

export interface ArticleRow extends Record<string, unknown> {
  id?: number | string;
  title?: string | null;
  excerpt?: string | null;
  status?: number | string | boolean | null;
  coverFileId?: number | string | null;
  cover?: string | null;
  contentJson?: unknown;
  images?: unknown;
  videos?: unknown;
}

export interface ArticleService {
  addArticle(userId: unknown, title: unknown, draftId: number | null, contentJson: Record<string, unknown> | null): Promise<unknown>;
  addView(articleId: string): Promise<unknown>;
  getArticleById(articleId: string): Promise<ArticleRow>;
  getArticleList(offset: ArticlePageValue, limit: ArticlePageValue, tagId: ArticleQueryValue, userId: ArticleQueryValue, pageOrder: ArticlePageOrder, idList: unknown, keywords: ArticleQueryValue): Promise<ArticleRow[]>;
  getTotal(tagId: ArticleQueryValue, userId: ArticleQueryValue, idList: unknown, keywords: ArticleQueryValue): Promise<number | string>;
  getRecommendArticleList(offset: ArticlePageValue, limit: ArticlePageValue): Promise<unknown>;
  getRandomTocArticle(): Promise<unknown>;
  getArticlesByKeyWords(keywords: ArticleQueryValue): Promise<unknown>;
  getArticleLikedById(articleId: string): Promise<{ likes: number | string }>;
  update(userId: unknown, title: unknown, articleId: string, draftId: number | null, contentJson: Record<string, unknown> | null): Promise<unknown>;
  delete(articleId: string, userId: unknown): Promise<{ result: unknown; localCleanup: CleanupSummary }>;
  clearTag(articleId: string): Promise<unknown>;
  batchAddTags(articleId: string, tagIds: number[]): Promise<unknown>;
}

export interface DraftServiceDependencies {
  connection: ArticleDatabase;
  baseURL: string;
  mediaRuntime: Pick<MediaRuntime, 'resolveImageUrl'>;
}

export interface DraftPayload {
  articleId: number | null;
  title: unknown;
  content: Record<string, unknown>;
  meta: Record<string, unknown>;
  version: number;
}

export interface DraftService {
  upsertDraft(userId: unknown, payload: DraftPayload): Promise<unknown>;
  getDraft(userId: unknown, articleId: number | null): Promise<unknown>;
  deleteDraft(userId: unknown, draftId: number): Promise<{ id: number }>;
}

export interface ArticleLikeServiceDependencies {
  connection: ArticleDatabase;
  notificationService: {
    createArticleLikeNotification(
      payload: { recipientId: number | string; actorId: unknown; articleId: string },
      options: { conn: ArticleTransaction },
    ): Promise<{ created: boolean; notification: unknown }>;
  };
  publishNotificationCreated(notification: unknown): Promise<unknown>;
}

export interface ArticleLikeService {
  toggleArticleLike(articleId: string, userId: unknown): Promise<{ isLiked: boolean }>;
}

export interface FileLookupDependencies {
  connection: QueryExecutor;
}

export interface FileLookup {
  getFileByFilename(filename: string): Promise<{ mimetype: string } | undefined>;
}
