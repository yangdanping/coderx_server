const test = require('node:test');
const assert = require('node:assert/strict');
const MdUtils = require('../../src/utils/MdUtils');

test('legacy Markdown keeps bare-domain and explicit URL linkification', () => {
  assert.equal(
    MdUtils.renderHtml('Visit example.com or https://example.org.'),
    '<p>Visit <a href="http://example.com">example.com</a> or <a href="https://example.org">https://example.org</a>.</p>\n',
  );
});

test('legacy Markdown keeps authentication segments in explicit URLs', () => {
  assert.equal(MdUtils.renderHtml('Visit https://reader@example.org/page'), '<p>Visit <a href="https://reader@example.org/page">https://reader@example.org/page</a></p>\n');
});

test('legacy Markdown keeps typography, formatting, and existing HTML', () => {
  assert.equal(MdUtils.renderHtml('**Bold** -- "quoted"'), '<p><strong>Bold</strong> – “quoted”</p>\n');
  assert.equal(MdUtils.renderHtml('<p>example.com</p>'), '<p>example.com</p>');
});
