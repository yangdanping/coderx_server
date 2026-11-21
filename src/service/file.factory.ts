import type { MutationResult } from '../app/database/database.types.js';
import SqlUtils from '../utils/SqlUtils.js';
import type { FileLookup, FileLookupDependencies } from './article/article.types.js';

interface FileRow {
  filename: string;
  file_type: string | null;
}

export function createFileService({ connection }: FileLookupDependencies) {
  /**
   * 文件服务层（通用）
   * 保留真正通用的文件操作方法
   * 头像、图片、视频的专用逻辑已拆分到各自的 service
   */
  class FileService implements FileLookup {
    /**
     * 根据文件名获取文件信息（通用方法）
     * @param {string} filename - 文件名
     * @returns {Promise} 文件信息
     */
    getFileByFilename = async (filename: string): Promise<{ mimetype: string } | undefined> => {
      try {
        const statement = `SELECT * FROM file WHERE filename LIKE ? LIMIT 1;`;
        const [result] = await connection.execute(statement, [`${filename}%`]);
        return (result as { mimetype: string }[])[0];
      } catch (error) {
        console.log('getFileByFilename error:', error);
        throw error;
      }
    };

    /**
     * 根据ID查询文件（通用方法，用于删除等）
     * @param {Array<number>} fileIds - 文件ID数组
     * @returns {Promise<Array>} 文件列表
     *
     * 重构说明：
     * 1. 采用 ? 占位符处理 IN 子句。
     */
    findFileById = async (fileIds: (number | string)[] | null | undefined): Promise<FileRow[]> => {
      if (!fileIds || fileIds.length === 0) return [];
      try {
        const statement = `SELECT f.filename, f.file_type FROM file f WHERE ${SqlUtils.queryIn('f.id', fileIds)};`;
        const [result] = await connection.execute(statement, fileIds);
        return result as FileRow[];
      } catch (error) {
        console.log('findFileById error:', error);
        throw error;
      }
    };

    /**
     * 删除文件（通用方法）
     * @param {Array<number>} fileIds - 文件ID数组
     * @returns {Promise} 删除结果
     *
     * 重构说明：
     * 1. 采用 ? 占位符处理 IN 子句。
     */
    delete = async (fileIds: (number | string)[] | null | undefined): Promise<MutationResult | null> => {
      if (!fileIds || fileIds.length === 0) return null;
      try {
        const statement = `DELETE FROM file f WHERE ${SqlUtils.queryIn('f.id', fileIds)};`;
        const [result] = await connection.execute(statement, fileIds);
        return result as MutationResult;
      } catch (error) {
        console.log('delete error:', error);
        throw error;
      }
    };
  }
  return new FileService();
}
