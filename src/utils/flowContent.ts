import BusinessError from '../errors/BusinessError.js';
import { docToExcerpt, docToHtml } from './articleContent.js';

interface FlowDocument extends Record<string, unknown> {
  type: 'doc';
}

interface DerivedFlowContent {
  content: FlowDocument;
  bodyText: string;
  bodyHtml: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFlowDocument(value: unknown): value is FlowDocument {
  return isPlainObject(value) && value.type === 'doc';
}

function validateNode(node: unknown): void {
  if (!isPlainObject(node) || typeof node.type !== 'string' || !node.type.trim()) {
    throw new BusinessError('参数错误: content 不是合法的 Tiptap 文档', 400);
  }
  if (node.type === 'image' || node.type === 'video') {
    throw new BusinessError('Flow 正文不允许包含图片或视频节点', 400);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'content')) {
    if (!Array.isArray(node.content)) {
      throw new BusinessError('参数错误: content 不是合法的 Tiptap 文档', 400);
    }
    node.content.forEach(validateNode);
  }
  if (node.type === 'text' && typeof node.text !== 'string') {
    throw new BusinessError('参数错误: 文本节点必须包含字符串 text', 400);
  }
}

export function deriveFlowContent(content: unknown): DerivedFlowContent {
  if (!isFlowDocument(content)) {
    throw new BusinessError('参数错误: content 必须是 Tiptap doc', 400);
  }
  validateNode(content);
  const bodyText = docToExcerpt(content, 2001);
  if (bodyText.length > 2000) {
    throw new BusinessError('Flow 正文不能超过 2000 个字符', 400);
  }
  return {
    content,
    bodyText,
    bodyHtml: docToHtml(content),
  };
}
