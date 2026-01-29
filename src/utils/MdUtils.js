const MarkdownIt = require('markdown-it');

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});

class MdUtils {
  /**
   * 确保内容为 HTML 格式
   * 如果内容看起来不像 HTML（不以 < 开头且不包含常见的 HTML 标签），则尝试将其作为 Markdown 渲染
   * @param {string} content 原始内容
   * @returns {string} 渲染后的 HTML
   */
  static renderHtml = (content) => {
    if (!content) return '';

    // 简单判断是否已经是 HTML
    // 只要包含常见的 HTML 闭合标签或者以 < 开头的块标签，就认为已经是 HTML
    const isHtml = /<[a-z][\s\S]*>|<br\s*\/?>|&[a-z]+;/i.test(content);

    console.log('[DEBUG] MdUtils.renderHtml 检测内容:', {
      length: content.length,
      isHtml,
      preview: content.substring(0, 50).replace(/\n/g, '\\n'),
    });

    if (isHtml) {
      // 如果已经是 HTML，直接返回
      return content;
    }

    // 否则认为是 Markdown，进行转换
    try {
      const rendered = md.render(content);
      console.log('[DEBUG] MdUtils Markdown 转换成功');
      return rendered;
    } catch (e) {
      console.error('[DEBUG] MdUtils Markdown 转换失败:', e);
      return content;
    }
  };
}

module.exports = MdUtils;
