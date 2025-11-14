const fs = require('fs');
const { IMG_PATH, AVATAR_PATH, VIDEO_PATH } = require('../constants/file-path');

module.exports = function deleteFile(files, delType = 'img') {
  // 根据类型确定删除路径
  let delPath;
  if (delType === 'img') {
    delPath = IMG_PATH;
  } else if (delType === 'avatar') {
    delPath = AVATAR_PATH;
  } else if (delType === 'video') {
    delPath = VIDEO_PATH;
  } else {
    console.error('未知的删除类型:', delType);
    return;
  }

  if (delType === 'img') {
    files.forEach(({ filename }) => {
      handleDeleteFile(filename, delPath);
    });
  } else if (delType === 'video') {
    // 视频删除：同时删除视频文件和封面图
    files.forEach(({ filename, poster }) => {
      console.log(`准备删除视频: ${filename}, 封面: ${poster || '无'}`);

      // 删除视频文件
      if (filename) {
        handleDeleteFile(filename, delPath, true); // 第三个参数标记为视频
      }

      // 删除封面图
      if (poster) {
        handleDeleteFile(poster, delPath, true); // 第三个参数标记为视频
      }
    });
  } else {
    // avatar
    handleDeleteFile(files.filename, delPath);
  }
};

function handleDeleteFile(findName, path, isVideo = false) {
  let filesAll = [];
  if (fs.existsSync(path)) {
    filesAll = fs.readdirSync(path);

    if (isVideo) {
      // 视频文件：直接精确匹配删除
      filesAll.forEach((fileItem) => {
        if (fileItem === findName) {
          let findCurrPath = path + '/' + fileItem;
          console.log(`  删除文件: ${findCurrPath}`);
          deleteFileSync(findCurrPath);
        }
      });
    } else {
      // 图片文件：匹配原图和 -small 缩略图
      // 提取文件名（不含扩展名）用于匹配
      // 例如: 1686222236683.png -> 1686222236683
      const fileNameWithoutExt = findName.replace(/\.[^/.]+$/, '');

      filesAll.forEach((fileItem) => {
        let findCurrPath = path + '/' + fileItem;

        // 匹配原图和 -small 缩略图
        // 匹配规则: 文件名以 fileNameWithoutExt 开头
        const isOriginal = fileItem.indexOf(findName) !== -1; // 原图
        const isSmallVersion = fileItem.indexOf(`${fileNameWithoutExt}-small`) !== -1; // -small 缩略图

        if (isOriginal || isSmallVersion) {
          deleteFileSync(findCurrPath);
        }
      });
    }
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
