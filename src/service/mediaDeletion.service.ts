import type { R2MediaStore } from '../storage/r2MediaStore.js';

interface MediaDeletionOptions {
  mediaObjectService: { prepareR2Deletion(fileIds: readonly (number | string)[]): Promise<readonly { objectKey: string }[]> };
  r2Store: Pick<R2MediaStore, 'delete'>;
}

export class MediaDeletionService {
  declare mediaObjectService: MediaDeletionOptions['mediaObjectService'];
  declare r2Store: MediaDeletionOptions['r2Store'];

  constructor({ mediaObjectService, r2Store }: MediaDeletionOptions) {
    if (!mediaObjectService || typeof mediaObjectService.prepareR2Deletion !== 'function') {
      throw new TypeError('an injected mediaObjectService is required');
    }
    if (!r2Store || typeof r2Store.delete !== 'function') {
      throw new TypeError('an injected r2Store is required');
    }
    this.mediaObjectService = mediaObjectService;
    this.r2Store = r2Store;
  }

  async deleteR2ObjectsForFiles(fileIds: readonly (number | string)[]) {
    const objects = await this.mediaObjectService.prepareR2Deletion(fileIds);
    let deleted = 0;
    for (const object of objects) {
      await this.r2Store.delete(object.objectKey);
      deleted += 1;
    }
    return {
      staged: objects.length,
      deleted,
    };
  }
}

export function createMediaDeletionService(options: MediaDeletionOptions): MediaDeletionService {
  return new MediaDeletionService(options);
}
