import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMediaRefs, docToExcerpt, docToHtml } from '../../src/utils/articleContent.js';

test('collectMediaRefs: dedupes stable imageId and videoId references from structured doc', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'hello',
          },
        ],
      },
      {
        type: 'image',
        attrs: {
          imageId: 11,
          src: 'http://legacy/image-11.jpg',
        },
      },
      {
        type: 'video',
        attrs: {
          videoId: 21,
          src: 'http://legacy/video-21.mp4',
        },
      },
      {
        type: 'image',
        attrs: {
          imageId: 11,
          src: 'http://legacy/image-11.jpg',
        },
      },
    ],
  };

  assert.deepEqual(collectMediaRefs(doc), {
    imageIds: [11],
    videoIds: [21],
  });
});

test('docToExcerpt: extracts readable plain text from structured content', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: '结构化标题' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'hardBreak' },
          { type: 'text', text: '第二句' },
        ],
      },
    ],
  };

  assert.equal(docToExcerpt(doc), '结构化标题 第一段 第二句');
});

test('docToHtml: resolves stable media ids to runtime urls and falls back to inline src when needed', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '正文' },
          { type: 'text', marks: [{ type: 'bold' }], text: '加粗' },
        ],
      },
      {
        type: 'image',
        attrs: {
          imageId: 12,
          src: 'http://legacy/image-12.jpg',
          alt: '封面图',
        },
      },
      {
        type: 'video',
        attrs: {
          videoId: 34,
          src: 'http://legacy/video-34.mp4',
          poster: 'http://legacy/video-34.jpg',
          controls: true,
        },
      },
      {
        type: 'image',
        attrs: {
          src: 'http://legacy/fallback-image.jpg',
          alt: '兜底图',
        },
      },
    ],
  };

  const html = docToHtml(doc, {
    imagesById: {
      12: { url: 'https://api.example/article/images/image-12.jpg' },
    },
    videosById: {
      34: {
        url: 'https://api.example/article/video/video-34.mp4',
        poster: 'https://api.example/article/video/video-34-poster.jpg',
      },
    },
  });

  assert.match(html, /<p>正文<strong>加粗<\/strong><\/p>/);
  assert.match(html, /<img[^>]+data-image-id="12"[^>]+src="https:\/\/api\.example\/article\/images\/image-12\.jpg"/);
  assert.match(html, /<video[^>]+data-video-id="34"[^>]+src="https:\/\/api\.example\/article\/video\/video-34\.mp4"[^>]+poster="https:\/\/api\.example\/article\/video\/video-34-poster\.jpg"/);
  assert.match(html, /<img[^>]+src="http:\/\/legacy\/fallback-image\.jpg"/);
});

test('docToHtml skips invalid persisted media URLs and keeps adjacent text', () => {
  const html = docToHtml({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'preserved' }] },
      { type: 'image', attrs: { src: 12 } },
      { type: 'video', attrs: { src: '/clip.mp4', poster: { invalid: true } } },
    ],
  });
  assert.equal(html, '<p>preserved</p><video src="/clip.mp4" controls></video>');
});
