class MediaDeletionService {
  constructor({ mediaObjectService, r2Store }) {
    if (!mediaObjectService || typeof mediaObjectService.prepareR2Deletion !== 'function') {
      throw new TypeError('an injected mediaObjectService is required');
    }
    if (!r2Store || typeof r2Store.delete !== 'function') {
      throw new TypeError('an injected r2Store is required');
    }
    this.mediaObjectService = mediaObjectService;
    this.r2Store = r2Store;
  }

  async deleteR2ObjectsForFiles(fileIds) {
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

function createMediaDeletionService(options) {
  return new MediaDeletionService(options);
}

module.exports = {
  MediaDeletionService,
  createMediaDeletionService,
};
