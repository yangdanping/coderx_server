import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Parser-owned files. Ownership passes as a batch only after parsing succeeds. */
export class TempFiles {
  private readonly paths = new Set<string>();
  private readonly writes: Promise<unknown>[] = [];

  constructor(private readonly destination: string) {}

  write(originalname: string, source: Readable) {
    const write = this.writeFile(originalname, source);
    this.writes.push(write);
    return write;
  }

  private async writeFile(originalname: string, source: Readable) {
    await mkdir(this.destination, { recursive: true });
    const filename = randomUUID() + extname(originalname);
    const path = join(this.destination, filename);
    const handle = await open(path, 'wx');
    this.paths.add(path);
    const output = handle.createWriteStream();
    try {
      await pipeline(source, output);
    } catch (error) {
      await this.discardFile(path);
      throw error;
    }
    return { filename, path, destination: this.destination, size: output.bytesWritten };
  }

  async discard() {
    // Multer can return on a socket abort before a pending open/write settles.
    await Promise.allSettled(this.writes);
    await Promise.all([...this.paths].map(path => this.discardFile(path)));
  }

  async discardFile(path: string | undefined) {
    if (!path || !this.paths.has(path)) return;
    try {
      await rm(path, { force: true });
      this.paths.delete(path);
    } catch (error) {
      console.error('清理未完成的上传文件失败:', error);
    }
  }
}
