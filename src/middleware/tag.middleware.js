const tagService = require('../service/tag.service');
const Result = require('../app/Result');
// ★1.判断标签是否存在中间件(这个实现思路多想几遍就想通了)
const verifytagExists = async (ctx, next) => {
  // 1.取出要添加的所有的标签
  const { tags } = ctx.request.body;
  // 2.判断每个标签在tag表中是否存在
  /*1.当该标签不存在时,得先在tag表中创建标签数据,然后拿到我们上面创建的tag对象添加新属性id,值就是创建成功后返回对象的insertId
    2.该标签存在,拿到我们上面创建的tag对象添加新属性id,值就是我们从表里查询到的标签的id
    3.把这该tag对象push到我们创建的newtags数组 */
  const newtags = [];
  for (const name of tags) {
    const tag = { name }; //无中生有一个对象,初始化一个属性和值都为name
    const tagResult = await tagService.getTagByName(name);
    if (!tagResult) {
      const result = await tagService.addTag(name);
      tag.id = result.insertId;
    } else {
      tag.id = tagResult.id;
    }
    newtags.push(tag);
  }
  // 3.最后给ctx添加tags属性,然后把newtags传入即完成了"用户添加标签表中没有的标签则先新建好再添加"的操作
  ctx.tags = newtags;
  await next();
};

module.exports = {
  verifytagExists
};
