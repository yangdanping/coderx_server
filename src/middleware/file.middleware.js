const multer = require('@koa/multer'); //解析form-data数据的第三方依赖库
const Jimp = require('jimp');
const path = require('path');
const { AVATAR_PATH, PICTURE_PATH } = require('../constants/file-path');
// // 要实现用户上传头像,则先做解析form-data的准备工作--------------

function setStorage(resourcePath) {
  return multer.diskStorage({
    destination: path.resolve(`${resourcePath}`), //定义文件保存路径//注意,该相对路径是相对于process.cwd的路径的
    filename: (req, file, cb) => {
      cb(null, Date.now() + path.extname(file.originalname)); //时间戳.jpg
    }
  });
}
const avatarStorage = setStorage(AVATAR_PATH);
const pictureStorage = setStorage(PICTURE_PATH);

const avatarHandler = multer({ storage: avatarStorage }).single('avatar'); //因为我只保存单个文件所以用single,且对应avatar字段
const pictureHandler = multer({ storage: pictureStorage }).array('picture', 9); //普通图片可以是多个,可以用picture,一条动态可上传9张图

// 来对上传的图片大小进行处理,最终效果是除了上传的原图,还对应生成另外三种不同大小的图片
/* 调用Jimp.read处理图片,返回一个img对象,img.resize()直接进行处理
  由于处理图片可能比较耗时,我希望直接给用户返回,让它就在这慢慢处理,
  所以这里不用await,直接拿到Promise执行 */
const pictureResize = async (ctx, next) => {
  //1.获取所有的图像信息
  const files = ctx.files;
  console.log(files);
  //2.对图像进行处理(利用第三方库jimp)
  for (const file of files) {
    const destPath = path.join(file.destination, file.filename);
    console.log(destPath);
    Jimp.read(file.path).then((img) => {
      img.resize(1280, Jimp.AUTO).write(`${destPath}-large`); //处理为宽1280,然后调用Jimp.AUTO进行自动缩放,然后调用write()写入到某个地方
      img.resize(640, Jimp.AUTO).write(`${destPath}-middle`);
      img.resize(320, Jimp.AUTO).write(`${destPath}-small`);
    });
    /* 到时不加后缀就是原图 http://localhost:8000/moment/images/1635697916652.jpg
然后前端那边在图像路径后面拼接一个参数如type=small,到时候展示的就是宽为320的小图
http://localhost:8000/moment/images/1635697916652.jpg?type=small
不同的后缀,获得不同大小的图片,得以在不同的地方展示
在提供服务的地方做修改 */
  }
  await next();
};

module.exports = {
  avatarHandler,
  pictureHandler,
  pictureResize
};
