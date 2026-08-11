const multer = require('@koa/multer');
const BusinessError = require('@/errors/BusinessError');
const { FLOW_IMAGE_MIME_TYPES, MAX_FLOW_IMAGE_FILE_SIZE } = require('@/constants/upload');

const mediaImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FLOW_IMAGE_FILE_SIZE,
  },
  fileFilter(req, file, callback) {
    if (FLOW_IMAGE_MIME_TYPES.has(file?.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new BusinessError('图片必须是 JPEG、PNG 或 WebP 格式', 400));
  },
}).single('image');

module.exports = mediaImageUpload;
