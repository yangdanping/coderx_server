import { loadEnvironment } from './app/loadEnvironment.js';
import type { SocketProcessOptions } from './socket/runtime/socketProcess.js';

export async function startSocketProcess(options?: SocketProcessOptions) {
  loadEnvironment();
  const { startConfiguredSocket } = await import('./socket/runtime/socketProcess.js');
  return startConfiguredSocket(options);
}

async function main() {
  const runtime = await startSocketProcess();
  function stop() {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    const deadline = setTimeout(() => {
      console.error('❌ Socket 服务器关闭超时');
      process.exit(1);
    }, 10_000);
    void runtime.close().then(
      () => { console.log('✅ Socket 服务器已关闭'); },
      error => {
        console.error('❌ Socket 服务器关闭失败:', error);
        process.exitCode = 1;
      },
    ).finally(() => clearTimeout(deadline));
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) {
  void main().catch(error => {
    console.error('❌ Socket.IO 服务器启动失败:', error);
    process.exitCode = 1;
  });
}
