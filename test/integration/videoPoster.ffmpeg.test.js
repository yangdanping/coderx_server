const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
require('module-alias/register');
const controller = require('../../src/controller/video.controller');
const sharp = require('sharp');

test('video posters exist for sub-second and ordinary clips with real ffmpeg', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-video-poster-'));
  try {
    for (const duration of [0.2, 3]) {
      const source = path.join(root, `clip-${duration}.mp4`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=160x120:d=${duration}`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
      const poster = await controller.runFfmpegScreenshot(source, `poster-${duration}.jpg`, root, 1);
      assert.ok((await fs.stat(poster)).size > 0, `${duration}s clip must produce a poster`);
      const info = await sharp(poster).metadata();
      assert.equal(info.width, 640);
      assert.equal(info.height, 480);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
