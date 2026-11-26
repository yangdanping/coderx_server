import type { ArticleDatabase, MediaRuntime } from './article/article.types.js';

export interface FlowServiceDependencies {
  database: ArticleDatabase;
  mediaRuntime: Pick<MediaRuntime, 'resolveImageUrl' | 'promotePublishedImages'>;
  logger: Pick<Console, 'error'>;
  publicApiOrigin: string;
}

export interface CreateFlowInput {
  clientRequestId: string;
  content: Record<string, unknown>;
  mediaIds: number[];
  draft: { id: number; version: number } | null;
}

export interface FlowItem {
  id: number;
  author: { id: number; name: string; username: string; avatarUrl: string };
  body: string;
  bodyHtml: string;
  media: { id: number; url: string; thumbnailUrl: string; title: string }[];
  likes: number;
  comments: number;
  liked: boolean;
  createdAt: Date | string | undefined;
}

export interface FlowService {
  createFlow(userId: unknown, input: CreateFlowInput): Promise<FlowItem>;
  getFlowFeed(page: number, pageSize: number): Promise<{ items: FlowItem[]; total: number; page: number; pageSize: number }>;
  getFlowDetail(flowId: number): Promise<FlowItem>;
}

export interface FlowDraftPayload {
  content: Record<string, unknown>;
  meta: Record<string, unknown>;
  version: number;
}

export interface FlowDraft {
  id: number;
  userId: number;
  draftType: 'flow';
  articleId: null;
  title: null;
  content: unknown;
  meta: unknown;
  version: number;
  createAt: Date | string;
  updateAt: Date | string;
  images: {
    id: number;
    url: string;
    thumbnailUrl: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
  }[];
}

export interface FlowDraftService {
  upsertFlowDraft(userId: unknown, payload: FlowDraftPayload): Promise<FlowDraft>;
  getFlowDraft(userId: unknown): Promise<FlowDraft | null>;
  deleteFlowDraft(userId: unknown, draftId: number): Promise<{ id: number }>;
}
