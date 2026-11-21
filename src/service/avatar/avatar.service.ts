import { readdir, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ArticleDatabase, ArticleTransaction } from '../article/article.types.js';
import { buildAddAvatarSql } from '../sql/avatar.sql.js';

type AvatarDatabase = Pick<ArticleDatabase, 'execute'>;

export type AvatarMetadata = { mimetype: string; filename: string };
type AvatarRow = AvatarMetadata & { id: number | string };
type AvatarUpload = AvatarMetadata & { size: number; path: string };
type AvatarInsertResult = { affectedRows?: number; insertId?: number | string };

export function createAvatarLookup(connection: AvatarDatabase) {
  return async function getAvatarById(userId: string): Promise<AvatarMetadata | undefined> {
    const [rows] = await connection.execute('SELECT * FROM avatar WHERE user_id = ?;', [userId]);
    return (rows as AvatarMetadata[]).at(-1);
  };
}

export function createAvatarRepository(database: AvatarDatabase) {
  return {
    getAvatarById: createAvatarLookup(database),
    async addAvatar(userId: unknown, filename: string, mimetype: string, size: number, conn: AvatarDatabase | null = null) {
      const [result] = await (conn ?? database).execute(buildAddAvatarSql(), [userId, filename, mimetype, size]);
      return result as AvatarInsertResult;
    },
    async findAvatarById(userId: unknown) {
      const [rows] = await database.execute('SELECT * FROM avatar ar WHERE ar.user_id = ?;', [userId]);
      return (rows as AvatarRow[])[0];
    },
    async deleteAvatar(avatarId: number | string, conn: AvatarDatabase | null = null) {
      const [result] = await (conn ?? database).execute('DELETE FROM avatar ar WHERE ar.id = ?;', [avatarId]);
      return result;
    },
  };
}

interface AvatarMutationOptions {
  database: ArticleDatabase;
  avatarRoot: string;
  publicApiOrigin: string;
  updateAvatarUrl(avatarUrl: string, userId: unknown, conn: ArticleTransaction): Promise<unknown>;
  removeOldAvatar?: (file: AvatarRow) => void | Promise<void>;
}

async function deleteIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export function createAvatarMutationService({
  database, avatarRoot, publicApiOrigin, updateAvatarUrl, removeOldAvatar,
}: AvatarMutationOptions) {
  const avatars = createAvatarRepository(database);

  async function removeAvatarFiles({ filename }: AvatarRow): Promise<void> {
    if (!filename || basename(filename) !== filename) return;
    const names = await readdir(avatarRoot).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    const smallPrefix = `${basename(filename, extname(filename))}-small`;
    for (const name of names) {
      if (name === filename || name.startsWith(smallPrefix)) await deleteIfPresent(join(avatarRoot, name));
    }
  }

  const removeOld = removeOldAvatar ?? removeAvatarFiles;

  return {
    async saveAvatar(userId: unknown, { filename, mimetype, size, path }: AvatarUpload) {
      let conn: ArticleTransaction | undefined;
      let transactionStarted = false;
      let commitAttempted = false;
      let oldAvatar: AvatarRow | undefined;
      let result: AvatarInsertResult;
      const avatarUrl = `${publicApiOrigin}/user/${userId}/avatar`;
      try {
        conn = await database.getConnection();
        await conn.beginTransaction();
        transactionStarted = true;
        oldAvatar = await avatars.findAvatarById(userId);
        if (oldAvatar) await avatars.deleteAvatar(oldAvatar.id, conn);
        result = await avatars.addAvatar(userId, filename, mimetype, size, conn);
        await updateAvatarUrl(avatarUrl, userId, conn);
        commitAttempted = true;
        await conn.commit();
      } catch (error) {
        if (transactionStarted && conn) {
          try {
            await conn.rollback();
          } catch (rollbackError) {
            console.error('Avatar transaction rollback failed:', rollbackError);
          }
        }
        // A rejected COMMIT can mean only its acknowledgement was lost.
        if (!commitAttempted) {
          try {
            await deleteIfPresent(path);
          } catch (cleanupError) {
            console.error('Avatar upload cleanup failed', cleanupError instanceof Error && 'code' in cleanupError ? cleanupError.code : undefined);
          }
        }
        throw error;
      } finally {
        conn?.release();
      }
      // The upload belongs to the committed row even if removing the old file fails.
      if (oldAvatar) await removeOld(oldAvatar);
      return { ...result, avatarUrl };
    },

    async deleteAvatar(userId: string) {
      const file = await avatars.findAvatarById(userId);
      if (!file) return '无头像可删除';
      await removeOld(file);
      await avatars.deleteAvatar(file.id);
      return `删除头像${file.filename}成功`;
    },
  };
}

export type AvatarMutationService = ReturnType<typeof createAvatarMutationService>;
