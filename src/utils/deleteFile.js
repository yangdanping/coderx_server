const fs = require('fs');
const { PICTURE_PATH, AVATAR_PATH } = require('../constants/file-path');
const { COVER_SUFFIX } = require('../constants/file');

module.exports = function deleteFile(files, delType = 'picture') {
  const delPath = delType === 'picture' ? PICTURE_PATH : AVATAR_PATH;
  if (delPath === PICTURE_PATH) {
    files.forEach(({ filename }) => {
      if (filename.endsWith(COVER_SUFFIX)) {
        filename = filename.replace(COVER_SUFFIX, ''); // 删除后缀名,使其可以正常访问本地文件
      }
      handleDeleteFile(filename, delPath);
    });
  } else {
    handleDeleteFile(files.filename, delPath);
  }
};

function handleDeleteFile(findName, path) {
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
}

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
