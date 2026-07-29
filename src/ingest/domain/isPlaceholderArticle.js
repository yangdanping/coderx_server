const REQUIRED_HEADINGS = new Set(['摘要', '为什么值得阅读', '来源']);

function nodeText(node) {
  return Array.isArray(node?.content)
    ? node.content
        .map((child) => String(child?.text || ''))
        .join('')
        .trim()
    : '';
}

function isPlaceholderArticle(content) {
  if (!content || content.type !== 'doc' || !Array.isArray(content.content)) return false;
  const headings = new Set(
    content.content.filter((node) => node?.type === 'heading').map((node) => nodeText(node)).filter((text) => REQUIRED_HEADINGS.has(text)),
  );
  const hasLinkedOriginal = content.content.some(
    (node) =>
      node?.type === 'paragraph' &&
      Array.isArray(node.content) &&
      node.content.some(
        (child) => String(child?.text || '').trim() === '阅读原文 ↗' && Array.isArray(child.marks) && child.marks.some((mark) => mark?.type === 'link'),
      ),
  );
  return headings.size === REQUIRED_HEADINGS.size && hasLinkedOriginal;
}

module.exports = {
  isPlaceholderArticle,
};
