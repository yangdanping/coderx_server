export function removeHTMLTag(text: unknown): string {
  if (!text) return '';
  if (typeof text !== 'string') throw new TypeError('str.replace is not a function');
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
