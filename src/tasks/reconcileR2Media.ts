import type { QueryExecutor, SqlRow } from '../app/database/database.types.js';
import type { MediaObjectRow } from '../service/mediaObject.service.js';
import { inspectLocalFile } from '../service/mediaPromotion.service.js';
import type { R2MediaListOptions, R2MediaMetadata } from '../storage/r2MediaStore.js';
import type { MediaBatch, MediaCandidate, PublishedMediaCatalog } from './mediaCatalog.js';

type TransitionIdentity = Pick<MediaObjectRow, 'id' | 'objectKey' | 'sizeBytes' | 'sha256'>;
type MediaIdentity = { sizeBytes: number; sha256: string | null };
type ListedObject = Pick<R2MediaMetadata, 'key' | 'sizeBytes'>;
type MediaScope = { fileId?: number; variant?: string; articleId?: number | null; flowId?: number };
type IssueDetails = {
  message?: string;
  status?: string;
  headMatchesRow?: boolean;
  provider?: string;
};
type ReconciliationIssue = MediaScope & IssueDetails & { code: string };

interface ReconciliationStore {
  head(key: string): Promise<MediaIdentity | null>;
  list(options: R2MediaListOptions): Promise<{ objects: ListedObject[]; continuationToken: string | null }>;
}

interface ReconciliationOptions extends MediaBatch {
  catalog?: PublishedMediaCatalog;
  database?: QueryExecutor;
  mediaObjectService?: {
    markReady(mediaObject: TransitionIdentity): Promise<unknown>;
    markFailed(mediaObject: TransitionIdentity, error: Error): Promise<unknown>;
    markVerificationFailed(mediaObject: TransitionIdentity, error: Error): Promise<unknown>;
  };
  r2Store?: ReconciliationStore;
  inspector?: (localPath: string) => Promise<{ sizeBytes: number; sha256: string }>;
  repair?: boolean;
  pendingOlderThanMs?: number | string;
}

function errorMessage(error: unknown) {
  return String((error instanceof Error && error.message) || error).slice(0, 500);
}

function readHead(store: ReconciliationStore, objectKey: string | null) {
  if (objectKey === null) throw new TypeError('R2 media key must be a relative object key');
  return store.head(objectKey);
}

export const DEFAULT_PENDING_OLDER_THAN_MS = 30 * 60 * 1_000;

function normalizeMediaRow(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Media object query returned an invalid row');
  const row = value as SqlRow;
  const objectKey = row.objectKey ?? row.object_key ?? null;
  const localPath = row.localPath ?? row.local_path ?? null;
  const updatedAt = row.updatedAt ?? row.updated_at ?? null;
  return {
    id: Number(row.id),
    fileId: Number(row.fileId ?? row.file_id),
    provider: String(row.provider),
    variant: String(row.variant),
    objectKey: typeof objectKey === 'string' ? objectKey : null,
    localPath: typeof localPath === 'string' ? localPath : null,
    sizeBytes: Number(row.sizeBytes ?? row.size_bytes),
    sha256: String(row.sha256),
    status: String(row.status),
    updatedAt: typeof updatedAt === 'string' || typeof updatedAt === 'number' || updatedAt instanceof Date ? updatedAt : null,
  };
}

function identityMatches(actual: MediaIdentity | null, expected: MediaIdentity) {
  return !!actual && actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256;
}

function mediaIdentity(fileId: number, variant: string) {
  return `${fileId}:${variant}`;
}

function issue(code: string, media: MediaScope = {}, details: IssueDetails & MediaScope = {}): ReconciliationIssue {
  return {
    code,
    ...(media.fileId != null ? { fileId: media.fileId } : {}),
    ...(media.variant ? { variant: media.variant } : {}),
    ...(Object.hasOwn(media, 'articleId') ? { articleId: media.articleId } : {}),
    ...(media.flowId != null ? { flowId: media.flowId } : {}),
    ...details,
  };
}

function mediaScope(media: MediaScope): MediaScope {
  return {
    ...(Object.hasOwn(media, 'articleId') ? { articleId: media.articleId } : {}),
    ...(media.flowId != null ? { flowId: media.flowId } : {}),
  };
}

export async function listAllR2Objects(r2Store: Pick<ReconciliationStore, 'list'>) {
  const objects: ListedObject[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await r2Store.list({ continuationToken, maxKeys: 1_000 });
    objects.push(...page.objects);
    continuationToken = page.continuationToken || undefined;
  } while (continuationToken);
  return objects.sort((left, right) => left.key.localeCompare(right.key));
}

export async function reconcileR2Media({
  catalog,
  database,
  mediaObjectService,
  r2Store,
  inspector = inspectLocalFile,
  repair = false,
  pendingOlderThanMs = DEFAULT_PENDING_OLDER_THAN_MS,
  articleId,
  afterFileId = 0,
  limit = 10_000,
}: ReconciliationOptions = {}) {
  if (!catalog || typeof catalog.listPublishedFiles !== 'function') throw new TypeError('catalog is required');
  if (!database || typeof database.execute !== 'function') throw new TypeError('database is required');
  if (!mediaObjectService || typeof mediaObjectService.markReady !== 'function') throw new TypeError('mediaObjectService is required');
  if (!r2Store || typeof r2Store.head !== 'function' || typeof r2Store.list !== 'function') throw new TypeError('r2Store is required');
  const normalizedPendingAge = Number(pendingOlderThanMs);
  if (!Number.isSafeInteger(normalizedPendingAge) || normalizedPendingAge <= 0) {
    throw new TypeError('pendingOlderThanMs must be a positive safe integer');
  }

  const files = await catalog.listPublishedFiles({ articleId, afterFileId, limit });
  const scopeCoverageComplete = articleId == null && Number(afterFileId || 0) === 0 && files.length < Number(limit);
  const discovered = await catalog.discoverVariants(files);
  const actualByIdentity = new Map<string, { candidate: MediaCandidate; sizeBytes: number; sha256: string }>();
  const issues: ReconciliationIssue[] = [];
  for (const candidate of discovered.candidates) {
    try {
      const inspected = await inspector(candidate.localPath);
      actualByIdentity.set(mediaIdentity(candidate.fileId, candidate.variant), { candidate, ...inspected });
    } catch (error) {
      issues.push(issue('LOCAL_INSPECTION_FAILED', candidate, { message: errorMessage(error) }));
    }
  }

  const [rawRows] = await database.execute(
    `
      SELECT
        mo.id,
        mo.file_id AS "fileId",
        mo.provider,
        mo.variant,
        mo.object_key AS "objectKey",
        mo.local_path AS "localPath",
        mo.size_bytes AS "sizeBytes",
        mo.sha256,
        mo.status,
        mo.updated_at AS "updatedAt"
      FROM media_object mo
      ORDER BY mo.id ASC;
    `,
  );
  if (!Array.isArray(rawRows)) throw new TypeError('Media object query did not return rows');
  const rows = rawRows.map(normalizeMediaRow);
  const rowsByIdentityAndProvider = new Map(rows.map((row) => [`${row.provider}:${mediaIdentity(row.fileId, row.variant)}`, row]));
  const r2Rows = rows.filter((row) => row.provider === 'r2' && row.objectKey);
  let repaired = 0;

  for (const [identity, actual] of actualByIdentity) {
    const localRow = rowsByIdentityAndProvider.get(`local:${identity}`);
    if (!localRow) {
      issues.push(issue('LOCAL_ROW_MISSING', actual.candidate));
    } else if (localRow.status !== 'ready' || localRow.localPath !== actual.candidate.localPath || !identityMatches(localRow, actual)) {
      issues.push(issue('LOCAL_ROW_MISMATCH', actual.candidate));
    }

    const r2Row = rowsByIdentityAndProvider.get(`r2:${identity}`);
    if (!r2Row) {
      issues.push(issue('R2_ROW_MISSING', actual.candidate));
      continue;
    }
    let head;
    try {
      head = await readHead(r2Store, r2Row.objectKey);
    } catch (error) {
      issues.push(issue('R2_HEAD_FAILED', r2Row, { ...mediaScope(actual.candidate), message: errorMessage(error) }));
      continue;
    }
    const headMatchesRow = identityMatches(head, r2Row);
    const rowMatchesLocal = identityMatches(r2Row, actual);
    if (!rowMatchesLocal) {
      issues.push(issue('R2_LOCAL_IDENTITY_MISMATCH', r2Row, mediaScope(actual.candidate)));
    }

    if (r2Row.status === 'pending') {
      const updatedAt = new Date(r2Row.updatedAt ?? 0).getTime();
      const stale = Number.isFinite(updatedAt) && Date.now() - updatedAt >= normalizedPendingAge;
      if (!stale) {
        issues.push(issue('R2_PENDING_FRESH', r2Row, mediaScope(actual.candidate)));
        continue;
      }
      const recoverable = headMatchesRow && rowMatchesLocal;
      issues.push(issue(recoverable ? 'R2_PENDING_STALE_MATCH' : 'R2_PENDING_STALE_MISSING_OR_MISMATCH', r2Row, mediaScope(actual.candidate)));
      if (repair) {
        try {
          if (recoverable) {
            await mediaObjectService.markReady(r2Row);
          } else {
            await mediaObjectService.markFailed(r2Row, new Error(`Stale R2 pending object ${r2Row.objectKey} is missing or mismatched`));
          }
          repaired += 1;
        } catch (error) {
          issues.push(issue('R2_REPAIR_FAILED', r2Row, { ...mediaScope(actual.candidate), message: errorMessage(error) }));
        }
      }
      continue;
    }

    if (r2Row.status === 'ready' && (!headMatchesRow || !rowMatchesLocal)) {
      if (!headMatchesRow) issues.push(issue(head ? 'R2_HEAD_MISMATCH' : 'R2_HEAD_MISSING', r2Row, mediaScope(actual.candidate)));
      else issues.push(issue('R2_READY_NOT_CURRENT_LOCAL', r2Row, mediaScope(actual.candidate)));
      if (repair) {
        try {
          await mediaObjectService.markVerificationFailed(r2Row, new Error(`Ready R2 object ${r2Row.objectKey} is missing or mismatched`));
          repaired += 1;
        } catch (error) {
          issues.push(issue('R2_REPAIR_FAILED', r2Row, { ...mediaScope(actual.candidate), message: errorMessage(error) }));
        }
      }
    } else if (r2Row.status === 'failed') {
      issues.push(issue('R2_ROW_FAILED', r2Row, mediaScope(actual.candidate)));
    } else if (r2Row.status === 'deleting') {
      issues.push(issue('R2_ROW_DELETING', r2Row, mediaScope(actual.candidate)));
    }
  }

  for (const missing of discovered.missingAssets) {
    const identity = mediaIdentity(missing.fileId, missing.variant);
    const r2Row = rowsByIdentityAndProvider.get(`r2:${identity}`);
    if (!r2Row) {
      issues.push(issue('R2_ROW_MISSING_FOR_MISSING_LOCAL', missing));
      continue;
    }
    let head;
    try {
      head = await readHead(r2Store, r2Row.objectKey);
    } catch (error) {
      issues.push(issue('R2_HEAD_FAILED_FOR_MISSING_LOCAL', r2Row, { message: errorMessage(error) }));
      continue;
    }
    if (r2Row.status === 'ready' && identityMatches(head, r2Row)) {
      issues.push(issue('LOCAL_FILE_MISSING_R2_READY', r2Row));
    } else {
      issues.push(issue('LOCAL_FILE_MISSING_R2_NOT_READY', r2Row, { status: r2Row.status, headMatchesRow: identityMatches(head, r2Row) }));
    }
  }

  const publishedIdentities = new Set(actualByIdentity.keys());
  for (const missing of [...discovered.missingAssets, ...discovered.optionalMissingAssets]) {
    publishedIdentities.add(mediaIdentity(missing.fileId, missing.variant));
  }
  const databaseRowsWithoutPublishedMedia = scopeCoverageComplete
    ? rows
        .filter((row) => !publishedIdentities.has(mediaIdentity(row.fileId, row.variant)))
        .map((row) => ({ id: row.id, fileId: row.fileId, provider: String(row.provider), variant: String(row.variant), status: row.status }))
    : [];
  for (const row of databaseRowsWithoutPublishedMedia) issues.push(issue('MEDIA_ROW_WITHOUT_PUBLISHED_LOCAL', row, { provider: row.provider }));

  const listedObjects = await listAllR2Objects(r2Store);
  const knownR2Keys = new Set(r2Rows.map((row) => row.objectKey));
  const r2ObjectsWithoutDatabase = listedObjects.filter((object) => !knownR2Keys.has(object.key)).map((object) => ({ key: object.key, sizeBytes: object.sizeBytes }));

  return {
    snapshotAt: new Date().toISOString(),
    repair: repair === true,
    scope: 'published',
    scopeCoverageComplete,
    examinedFiles: files.length,
    expectedObjects: discovered.candidates.length,
    databaseRows: rows.length,
    listedR2Objects: listedObjects.length,
    repaired,
    missingAssets: discovered.missingAssets,
    invalidRows: discovered.invalidRows,
    databaseRowsWithoutPublishedMedia,
    r2ObjectsWithoutDatabase,
    issues,
    nextAfterFileId: files.at(-1)?.id ?? Number(afterFileId || 0),
  };
}
