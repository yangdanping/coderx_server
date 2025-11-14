const multer = require('@koa/multer'); //解析form-data数据的第三方依赖库
const { Jimp } = require('jimp');
const path = require('path');
const { AVATAR_PATH, IMG_PATH, VIDEO_PATH } = require('../constants/file-path');
// // 要实现用户上传头像,则先做解析form-data的准备工作--------------

function setStorage(resourcePath) {
  console.log('setStorage===========================', resourcePath);
  return multer.diskStorage({
    destination: path.resolve(`${resourcePath}`), //定义文件保存路径//注意,该相对路径是相对于process.cwd的路径的
    filename: (req, file, cb) => {
      cb(null, Date.now() + path.extname(file.originalname)); //时间戳.jpg
    }
  });
}
const avatarStorage = setStorage(AVATAR_PATH);
const imgStorage = setStorage(IMG_PATH);
const videoStorage = setStorage(VIDEO_PATH);

const avatarHandler = multer({ storage: avatarStorage }).single('avatar'); //因为我只保存单个文件所以用single,且对应avatar字段
const imgHandler = multer({ storage: imgStorage }).array('img', 20); //普通图片可以是多个,可以用img,一篇文章可上传20张图

// 视频上传处理器
const videoHandler = multer({
  storage: videoStorage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 限制视频大小为 100MB
  },
  fileFilter: (req, file, cb) => {
    // 只允许视频格式
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('只能上传视频文件!'));
    }
  }
}).single('video'); // 一次只上传一个视频

// 来对上传的图片大小进行处理,最终效果是除了上传的原图,还对应生成另外三种不同大小的图片
/* 调用Jimp.read处理图片,返回一个img对象,img.resize()直接进行处理
  由于处理图片可能比较耗时,我希望直接给用户返回,让它就在这慢慢处理,
  所以这里不用await,直接拿到Promise执行 */
const imgResize = async (ctx, next) => {
  //1.获取所有的图像信息
  const files = ctx.files;
  console.log('获取所有的图像信息', files);
  //2.对图像进行处理(利用第三方库jimp)
  if (files.length) {
    const cover = files[0]; // 仅取第一张图片为封面,进行裁切
    const destPath = path.join(cover.destination, cover.filename);
    const processedCover = await Jimp.read(cover.path);
    processedCover.resize({ w: 320 });
    // 在文件扩展名前添加-small
    const extname = path.extname(destPath); // 获取扩展名 (.jpg)
    const smallDestPath = destPath.replace(extname, `-small${extname}`); // 替换为 -small.jpg
    await processedCover.write(`${smallDestPath}`);
    // .then((img) => img.resize({ w: 320 })
    // .write(`${destPath}-small`));
  }

  // for (const file of files) {
  //   const destPath = path.join(file.destination, file.filename);
  //   console.log(destPath);
  //   Jimp.read(file.path).then((img) => {
  //     img.resize(1280, Jimp.AUTO).write(`${destPath}-large`);
  //     img.resize(640, Jimp.AUTO).write(`${destPath}-middle`);
  //     img.resize(320, Jimp.AUTO).write(`${destPath}-small`); //处理图片宽度为320,第二个参数Jimp.AUTO表示高度自动缩放,然后调用write()写入到某个地方
  //   });
  // }
  /* 到时不加后缀就是原图 http://localhost:8000/moment/images/1635697916652.jpg
  然后前端那边在图像路径后面拼接一个参数如type=small,到时候展示的就是宽为320的小图
  http://localhost:8000/moment/images/1635697916652.jpg?type=small
  不同的后缀,获得不同大小的图片,得以在不同的地方展示
  在提供服务的地方做修改 */
  await next();
};

module.exports = {
  avatarHandler,
  imgHandler,
  imgResize,
  videoHandler
};
