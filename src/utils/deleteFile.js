const fs = require('fs');
const { PICTURE_PATH } = require('../constants/file-path');

module.exports = function deleteFile(findName, path = PICTURE_PATH) {
  let filesAll = [];
  if (fs.existsSync(path)) {
    filesAll = fs.readdirSync(path);
    filesAll.forEach((fileItem) => {
      let findCurrPath = path + '/' + fileItem;
      if (fileItem.indexOf(findName) !== -1) {
        deleteFileSync(findCurrPath);
      }
    });
  }
};

function deleteFileSync(filePath) {
  // 检测文件是否存在
  if (fs.existsSync(filePath)) {
    // 检测文件是目录
    if (fs.statSync(filePath).isDirectory()) {
      // 获取目录内所有文件名
      const filenames = fs.readdirSync(filePath);
      filenames.forEach((filename) => {
        const currentPath = path.join(filePath, filename);
        if (fs.statSync(currentPath).isDirectory()) {
          deleteFileSync(currentPath);
        } else {
          fs.unlinkSync(currentPath);
        }
      });
      fs.rmdirSync(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
  }
}
