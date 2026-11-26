import { loadEnvironment } from './app/loadEnvironment.js';
import type { startServer } from './hono.bootstrap.js';

export async function start(options?: Parameters<typeof startServer>[0]) {
  loadEnvironment();
  const { startServer: startHttp } = await import('./hono.bootstrap.js');
  return startHttp(options);
}

if (import.meta.main) {
  void start().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
