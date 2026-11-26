import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createVideoOperations } from '../../src/service/videoOperations.factory.js';
import type { VideoMetadata } from '../../src/service/video.types.js';

function createFixture(videoRoot: string) {
  type VideoRow = { filename: string; statuses: string[]; metadata?: Partial<VideoMetadata>; poster?: string };
  const rows = new Map<number, VideoRow>();
  const promotions: number[][] = [];
  const row = (id: number) => {
    const result = rows.get(id);
    assert.ok(result, `video row ${id} was registered`);
    return result;
  };
  const operations = createVideoOperations({
    service: {
      async addVideo(_user, filename) {
        const insertId = rows.size + 1;
        rows.set(insertId, { filename, statuses: ['pending'] });
        return { insertId };
      },
      async updateTranscodeStatus(id, status) { row(id).statuses.push(status); },
      async updateVideoMetadata(id, metadata) { row(id).metadata = metadata; },
      async updateVideoPoster(id, poster) { row(id).poster = poster; },
      async promotePublishedVideoIds(ids) { promotions.push(ids); },
      async updateVideoArticle() { assert.fail('unexpected article association'); },
      async deleteVideos() { assert.fail('unexpected deletion'); },
      async getVideoById() { assert.fail('unexpected video lookup'); },
    },
    mediaRuntime: {
      resolveVideoUrl() { assert.fail('unexpected URL resolution'); },
      resolveVideoPosterUrl() { assert.fail('unexpected poster URL resolution'); },
    },
    baseURL: 'https://api.example.test',
    videoRoot,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { operations, row, promotions };
}

test('video posters exist for sub-second and ordinary clips with real ffmpeg', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-video-poster-'));
  const { operations } = createFixture(root);
  try {
    for (const duration of [0.2, 3]) {
      const source = path.join(root, `clip-${duration}.mp4`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=160x120:d=${duration}`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
      const poster = await operations.runFfmpegScreenshot(source, `poster-${duration}.jpg`, root, 1);
      assert.ok((await fs.stat(poster)).size > 0, `${duration}s clip must produce a poster`);
      const info = await sharp(poster).metadata();
      assert.equal(info.width, 640);
      assert.equal(info.height, 480);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real FFmpeg and ffprobe complete a video upload or mark corrupt input failed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-video-lifecycle-'));
  const { operations, row, promotions } = createFixture(root);
  try {
    const clip = path.join(root, 'clip.mp4');
    const corrupt = path.join(root, 'corrupt.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=0.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    await fs.writeFile(corrupt, 'not a video');
    for (const videoPath of [clip, corrupt]) {
      const result = await operations.saveUpload(7, {
        path: videoPath, filename: path.basename(videoPath), size: (await fs.stat(videoPath)).size, mimetype: 'video/mp4',
      });
      assert.ok('data' in result);
      assert.equal(result.data.transcodeStatus, 'processing');
    }
    await operations.stop();
    const successful = row(1);
    assert.deepEqual(successful.statuses, ['pending', 'processing', 'processing', 'completed']);
    assert.equal(successful.metadata?.width, 160);
    assert.equal(successful.metadata?.height, 120);
    assert.equal(successful.poster, 'clip-poster.jpg');
    assert.equal((await sharp(path.join(root, successful.poster)).metadata()).width, 640);
    assert.deepEqual(promotions, [[1]]);
    assert.deepEqual(row(2).statuses, ['pending', 'processing', 'processing', 'failed']);
    assert.deepEqual((await fs.readdir(root)).sort(), ['clip-poster.jpg', 'clip.mp4', 'corrupt.mp4']);
  } finally {
    await operations.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
