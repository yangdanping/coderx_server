const Router = require('@koa/router');
const { verifyAuth } = require('@/middleware/auth.middleware');
const mediaMutationMaintenance = require('@/middleware/mediaMaintenance.middleware');
const mediaImageUpload = require('@/middleware/mediaImage.middleware');
const mediaController = require('@/controller/media.controller');

const mediaRouter = new Router({ prefix: '/media/images' });

mediaRouter.post('/', mediaMutationMaintenance, verifyAuth, mediaImageUpload, mediaController.uploadImage);
mediaRouter.delete('/:mediaId', mediaMutationMaintenance, verifyAuth, mediaController.deleteImage);

module.exports = mediaRouter;
