import { createAiChatService } from './service/ai/ai.service.js';
import { registerAiRoutes } from './router/ai.router.js';
import { serve } from '@hono/node-server';
import { createHttpApp } from './http/app.js';
import { buildAllowedOrigins } from './constants/corsOrigins.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMediaConfig } from './app/config.js';
import { parseRuntimeConfig } from './app/runtime.config.js';
import { createShutdown } from './app/shutdown.js';
import { createPgClient, createPgReadinessCheck } from './app/database/pg.factory.js';
import { createTagService } from './service/tag/tag.service.js';
import { createAuthMiddleware } from './middleware/auth.middleware.js';
import { mediaImageUpload } from './middleware/mediaImage.middleware.js';
import { createDiskUpload } from './middleware/diskUpload.middleware.js';
import { mediaMutationMaintenance } from './middleware/mediaMaintenance.middleware.js';
import { registerTagRoutes } from './router/tag.router.js';
import { registerMediaRoutes } from './router/media.router.js';
import { createMediaImageUploadService } from './service/mediaImage/mediaImage.service.js';
import { createMediaImageUrlResolver } from './service/mediaImage/mediaImageUrl.service.js';
import { createMediaImageDeletionService } from './service/mediaImage/mediaImageDeletion.service.js';
import { registerAvatarRoutes } from './router/avatar.router.js';
import { registerImageRoutes } from './router/image.router.js';
import { registerVideoRoutes } from './router/video.router.js';
import { createImageService } from './service/image/image.service.js';
import { createVideoService } from './service/video.factory.js';
import { createVideoOperations } from './service/videoOperations.factory.js';
import type { ArticleCleanup } from './service/article/article.types.js';
import { IMAGE_TYPE_LIMIT_MESSAGE, MAX_IMAGE_BATCH_COUNT, MAX_IMAGE_FILE_SIZE, MAX_VIDEO_FILE_SIZE, VIDEO_TYPE_LIMIT_MESSAGE } from './constants/upload.js';
import { registerUserRoutes } from './router/user.router.js';
import { registerOAuthRoutes } from './router/oauth.router.js';
import { createUserService } from './service/user.factory.js';
import { createOAuthService } from './service/oauth/oauth.service.js';
import { createAvatarLookup, createAvatarMutationService } from './service/avatar/avatar.service.js';
import { createSignUserToken } from './service/user/userToken.service.js';
import { createNotificationService } from './service/notification.factory.js';
import { createNotificationPublisher } from './socket/notification/notificationPublisher.js';
import { registerHistoryRoutes } from './router/history.router.js';
import { registerCollectRoutes } from './router/collect.router.js';
import { registerNotificationRoutes } from './router/notification.router.js';
import { createAuthService } from './service/auth/auth.service.js';
import { createHistoryService } from './service/history/history.service.js';
import { createCollectService } from './service/collect/collect.service.js';
import { registerArticleRoutes } from './router/article.router.js';
import { registerCommentRoutes } from './router/comment.router.js';
import { registerDraftRoutes } from './router/draft.router.js';
import { registerFlowRoutes } from './router/flow.router.js';
import { registerFlowDraftRoutes } from './router/flowDraft.router.js';
import { createArticleService } from './service/article.factory.js';
import { createArticleLikeService } from './service/articleLike.factory.js';
import { createCommentService } from './service/comment.factory.js';
import { createCommentLikeService } from './service/commentLike.factory.js';
import { createDraftService } from './service/draft.factory.js';
import { createFlowService } from './service/flow.factory.js';
import { createFileService } from './service/file.factory.js';
import { LocalMediaCleanupService, buildLocalCleanupEntries } from './service/localMediaCleanup.service.js';
import { createMediaRuntime } from './service/mediaRuntime.factory.js';

type Jobs = { start(): void | Promise<void>; stop(): void | Promise<void> };
type Runtime = ReturnType<typeof parseRuntimeConfig>;
export type CandidateContext = { config: Runtime; privateKey: Buffer; publicKey: Buffer };
type CandidateServer = ReturnType<typeof serve> & { runtimeContext: CandidateContext };
interface Options {
  createJobs?: () => Jobs | null;
  serveHttp?: typeof serve;
  createApp?: typeof createHttpApp;
  createNotificationClient?: Parameters<typeof createNotificationPublisher>[0]['createClient'];
  onShutdownError?: (error: unknown) => void;
}

export async function startServer(options: Options = {}) {
  const runtime = parseRuntimeConfig();
  const media = readMediaConfig();
  const context = { config: runtime, privateKey: readFileSync(runtime.privateKeyPath), publicKey: readFileSync(runtime.publicKeyPath) };
  const { default: { requestLogger, sqlLogger } } = await import('./app/logger.js');
  const database = createPgClient(process.env, sqlLogger);
  const notifications = createNotificationPublisher({
    redisUrl: process.env.REDIS_URL,
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'coderx',
    logError: () => requestLogger.error('Redis notification connection failed'),
    createClient: options.createNotificationClient,
  });
  let server: CandidateServer | undefined;
  let jobs: Jobs | null = null;
  let serverClosed: Promise<void> | undefined;
  let mediaRuntime: ReturnType<typeof createMediaRuntime> | undefined;
  let videoOperations: ReturnType<typeof createVideoOperations> | undefined;
  const closeServer = () => {
    const listener = server;
    return serverClosed ??= listener?.listening
      ? new Promise<void>((done, fail) => listener.close(error => error ? fail(error) : done()))
      : Promise.resolve();
  };
  const stop = createShutdown(
    [() => database.end(), () => mediaRuntime?.close()],
    [{ async stop() { await closeServer(); await videoOperations?.stop(); } }, { stop: () => jobs?.stop() }, { stop: notifications.close }],
    runtime.shutdownTimeoutMs,
  );
  const reportError = options.onShutdownError ?? ((error: unknown) => { console.error('Shutdown failed:', error); process.exitCode = 1; });
  let finishing: Promise<void> | undefined;
  const requestShutdown = () => {
    finishing ??= stop().catch(reportError).finally(() => {
      process.removeListener('SIGINT', requestShutdown);
      process.removeListener('SIGTERM', requestShutdown);
    });
  };

  try {
    const imageRoot = join(runtime.mediaRoot, 'img');
    const avatarRoot = join(runtime.mediaRoot, 'avatar');
    const videoRoot = join(runtime.mediaRoot, 'video');
    const articleMedia = createMediaRuntime({
      database, imageRoot, videoRoot,
      publicApiOrigin: runtime.publicApiOrigin,
      readMode: runtime.mediaReadMode,
      writeMode: media.writeMode,
      writePaused: media.writePaused,
      bucket: runtime.r2Bucket,
      cdnBaseUrl: runtime.mediaCdnBaseUrl,
      hardLimitBytes: runtime.r2HardLimitBytes,
      accountId: media.accountId,
      accessKeyId: media.accessKeyId,
      secretAccessKey: media.secretAccessKey,
    });
    mediaRuntime = articleMedia;
    const cleanup = new LocalMediaCleanupService({ database, roots: { image: imageRoot, video: videoRoot } });
    const localMediaCleanup: ArticleCleanup = {
      buildLocalCleanupEntries,
      enqueueInTransaction: (conn, entries) => cleanup.enqueueInTransaction(conn, entries),
      processPending: options => cleanup.processPending(options),
    };
    const video = createVideoOperations({
      service: createVideoService({ connection: database, mediaRuntime: articleMedia, localMediaCleanup, logger: requestLogger }),
      mediaRuntime: articleMedia,
      baseURL: runtime.publicApiOrigin,
      videoRoot,
      logger: requestLogger,
    });
    videoOperations = video;
    const app = (options.createApp ?? createHttpApp)({
      developmentErrors: process.env.NODE_ENV !== 'production',
      logRequest: record => requestLogger.info(JSON.stringify(record)),
      buildId: runtime.buildId,
      allowedOrigins: buildAllowedOrigins(runtime.frontendUrl),
      checkReady: createPgReadinessCheck(process.env),
      registerRoutes(app) {
        const authService = createAuthService(database);
        const { verifyAuth, verifyPermission, verifyStatus } = createAuthMiddleware({
          publicKey: context.publicKey,
          checkPermission: authService.checkPermission,
          async checkStatus(userId) {
            try {
              return await authService.checkStatus(userId);
            } catch {
              // Koa logs lookup failures and treats them as an undefined status.
              requestLogger.error('User moderation status lookup failed');
            }
          },
        });
        const moderation = { verifyAuth, verifyPermission, verifyStatus };
        const maintenance = mediaMutationMaintenance(() => runtime.mediaMutationsPaused);
        registerAiRoutes(app, {
          auth: verifyAuth,
          service: createAiChatService({
            logEvent: event => requestLogger.error(`AI chat ${event}`),
            baseURL: `${process.env.OLLAMA_HOST}:${process.env.OLLAMA_PORT}/v1`,
            allowedModels: (process.env.AI_ALLOWED_MODELS || '').split(',').map(value => value.trim()).filter(Boolean),
            supportsTools: ['1', 'true', 'yes', 'on'].includes((process.env.AI_ENABLE_TOOLS || '').toLowerCase()),
          }),
        });
        const signToken = createSignUserToken(context.privateKey);
        const notificationService = createNotificationService(database, runtime.publicApiOrigin);
        const userService = createUserService({
          connection: database,
          baseURL: runtime.publicApiOrigin,
          notificationService,
          publishNotificationCreated: notifications.publishNotificationCreated,
        });
        registerUserRoutes(app, {
          service: userService,
          getAvatarById: createAvatarLookup(database),
          avatarRoot,
          verifyAuth,
          signToken,
        });
        registerAvatarRoutes(app, {
          service: createAvatarMutationService({
            database, publicApiOrigin: runtime.publicApiOrigin, avatarRoot,
            updateAvatarUrl: userService.updateAvatarUrl,
          }),
          verifyAuth,
          uploadAvatar: createDiskUpload({ root: avatarRoot, field: 'avatar' }),
        });
        registerOAuthRoutes(app, {
          service: createOAuthService(database),
          frontendUrl: process.env.FRONTEND_URL,
          googleClientId: process.env.GOOGLE_CLIENT_ID,
          signToken,
        });
        const tagService = createTagService(database);
        const historyService = createHistoryService(database, runtime.publicApiOrigin, runtime.frontendUrl);
        registerTagRoutes(app, { service: tagService, verifyAuth });
        registerHistoryRoutes(app, { service: historyService, verifyAuth });
        registerCollectRoutes(app, { service: createCollectService(database), verifyAuth, verifyPermission });
        registerNotificationRoutes(app, { service: notificationService, verifyAuth });
        const interactionDependencies = {
          connection: database,
          baseURL: runtime.publicApiOrigin,
          notificationService,
          publishNotificationCreated: notifications.publishNotificationCreated,
        };
        registerCommentRoutes(app, {
          service: createCommentService(interactionDependencies),
          likeService: createCommentLikeService(interactionDependencies),
          ...moderation,
        });
        const articleDependencies = {
          connection: database,
          mediaRuntime: articleMedia,
          baseURL: runtime.publicApiOrigin,
        };
        const draftService = createDraftService(articleDependencies);
        registerDraftRoutes(app, { service: draftService, verifyAuth });
        registerFlowRoutes(app, {
          service: createFlowService({ database, mediaRuntime: articleMedia, logger: requestLogger, publicApiOrigin: runtime.publicApiOrigin }),
          maintenance, verifyAuth, verifyStatus,
        });
        registerFlowDraftRoutes(app, { service: draftService, verifyAuth });
        registerArticleRoutes(app, {
          service: createArticleService({
            ...articleDependencies,
            redirectURL: runtime.frontendUrl,
            localMediaCleanup,
          }),
          likeService: createArticleLikeService(interactionDependencies),
          fileService: createFileService({ connection: database }),
          imageRoot, videoRoot, tagService, historyService, maintenance,
          ...moderation,
        });
        registerImageRoutes(app, {
          service: createImageService({ database, mediaRuntime: articleMedia, localMediaCleanup }),
          publicApiOrigin: runtime.publicApiOrigin,
          maintenance, verifyAuth,
          uploadImage: createDiskUpload({
            root: imageRoot, field: 'img', maxCount: MAX_IMAGE_BATCH_COUNT, maxBytes: MAX_IMAGE_FILE_SIZE,
            mimePrefix: 'image/', mimeError: IMAGE_TYPE_LIMIT_MESSAGE,
          }),
        });
        registerVideoRoutes(app, {
          operations: video,
          maintenance, verifyAuth,
          uploadVideo: createDiskUpload({
            root: videoRoot, field: 'video', maxBytes: MAX_VIDEO_FILE_SIZE,
            mimePrefix: 'video/', mimeError: VIDEO_TYPE_LIMIT_MESSAGE,
          }),
        });

        const resolveImageUrl = createMediaImageUrlResolver(database, {
          imageRoot,
          publicApiOrigin: runtime.publicApiOrigin,
          readMode: runtime.mediaReadMode,
          bucket: runtime.r2Bucket,
          cdnBaseUrl: runtime.mediaCdnBaseUrl,
          hardLimitBytes: runtime.r2HardLimitBytes,
        });
        registerMediaRoutes(app, {
          service: {
            ...createMediaImageUploadService({ database, imageRoot, publicApiOrigin: runtime.publicApiOrigin, resolveImageUrl }),
            deletePendingImage: createMediaImageDeletionService({ database, mediaRuntime: articleMedia, localMediaCleanup }),
          },
          maintenance,
          verifyAuth,
          uploadImage: mediaImageUpload,
        });
      },
    });
    const listener = (options.serveHttp ?? serve)({ fetch: app.fetch, hostname: runtime.host, port: runtime.port }) as CandidateServer;
    server = listener;
    listener.runtimeContext = context;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { listener.off('listening', onListening); reject(error); };
      const onListening = () => { listener.off('error', onError); resolve(); };
      listener.once('listening', onListening);
      listener.once('error', onError);
    });
    if (runtime.backgroundJobsEnabled) {
      if (options.createJobs) {
        jobs = options.createJobs();
      } else {
        const [{ createBackgroundJobs }, { createTask }] = await Promise.all([
          import('./tasks/cleanOrphanFiles.js'),
          import('node-cron'),
        ]);
        jobs = createBackgroundJobs(true, () => ({
          cron: { createTask },
          connection: database,
          mediaRuntime: articleMedia,
          localMediaCleanup: {
            buildLocalCleanupEntries,
            enqueueInTransaction: cleanup.enqueueInTransaction.bind(cleanup),
            processPending: cleanup.processPending.bind(cleanup),
          },
        }));
      }
      await jobs?.start();
    }
    process.on('SIGINT', requestShutdown);
    process.on('SIGTERM', requestShutdown);
    listener.once('close', requestShutdown);
    return listener;
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Startup cleanup failed');
    }
    throw error;
  }
}
