const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const AiConstraintUtils = require('../../src/utils/AiConstraintUtils');
const AiValidUtils = require('../../src/utils/AiValidUtils');

test('truncateTextBySemanticBoundary: prefers a sentence boundary for long article context', () => {
  const text = '第一句保留完整。第二句也应该保留。第三句超过预算不应该被硬切。';

  const result = AiConstraintUtils.truncateTextBySemanticBoundary(text, 15, { mode: 'head' });

  assert.equal(result.text, '第一句保留完整。');
  assert.equal(result.truncated, true);
  assert.match(result.note, /语义边界/);
});

test('truncateTextBySemanticBoundary: treats semicolons and newlines as natural boundaries', () => {
  const semicolonText = '第一段保留；第二段会超过预算';
  const newlineText = '第一行\n第二行会超过预算';

  assert.equal(AiConstraintUtils.truncateTextBySemanticBoundary(semicolonText, 7, { mode: 'head' }).text, '第一段保留；');
  assert.equal(AiConstraintUtils.truncateTextBySemanticBoundary(newlineText, 7, { mode: 'head' }).text, '第一行');
});

test('truncateTextBySemanticBoundary: selected text keeps beginning and ending context when truncated', () => {
  const text = '开头定义很重要。中间展开信息很多很多很多很多很多很多。结尾限定条件也重要。';

  const result = AiConstraintUtils.truncateTextBySemanticBoundary(text, 26, { mode: 'head-tail' });

  assert.equal(result.truncated, true);
  assert.match(result.text, /^开头定义很重要。/);
  assert.match(result.text, /结尾限定条件也重要。$/);
  assert.match(result.text, /中间内容过长/);
});

test('sanitizeSelectionContexts: cleans, limits and semantically truncates selected snippets', () => {
  const selected = [
    { id: 'a', text: '<p>第一段选中内容。</p>' },
    { id: 'b', text: '开头信息。'.repeat(280) + '结尾信息。' },
    { id: 'empty', text: '   ' },
  ];

  const result = AiConstraintUtils.sanitizeSelectionContexts(selected);

  assert.equal(result.length, 2);
  assert.equal(result[0].text, '第一段选中内容。');
  assert.equal(result[0].truncated, false);
  assert.equal(result[1].truncated, true);
  assert.match(result[1].text, /开头信息。/);
  assert.match(result[1].text, /结尾信息。$/);
});

test('buildSystemPrompt: marks selection snippets as high priority context without requiring them', () => {
  const promptWithoutSelection = AiConstraintUtils.buildSystemPrompt('整篇文章内容。');

  assert.doesNotMatch(promptWithoutSelection, /用户选中的文章片段/);

  const promptWithSelection = AiConstraintUtils.buildSystemPrompt('整篇文章内容。', [
    { text: '用户划词内容。', truncated: false },
  ]);

  assert.match(promptWithSelection, /用户选中的文章片段/);
  assert.match(promptWithSelection, /高优先级上下文/);
  assert.match(promptWithSelection, /这段|这句|这里/);
  assert.match(promptWithSelection, /用户划词内容。/);
});

test('validateChatPayload: accepts bounded selected contexts and rejects invalid ones', () => {
  const basePayload = {
    messages: [{ role: 'user', parts: [{ type: 'text', text: '这段是什么意思？' }] }],
    model: null,
    context: '文章',
  };

  assert.equal(
    AiValidUtils.validateChatPayload({
      ...basePayload,
      selectionContexts: [{ id: 'a', text: '划词内容' }],
    }),
    null,
  );

  assert.match(
    AiValidUtils.validateChatPayload({
      ...basePayload,
      selectionContexts: [{ id: 'a', text: '' }],
    }),
    /selectionContexts/,
  );

  assert.match(
    AiValidUtils.validateChatPayload({
      ...basePayload,
      selectionContexts: Array.from({ length: 11 }, (_, index) => ({ id: String(index), text: '片段' })),
    }),
    /selectionContexts 数量不能超过/,
  );
});
