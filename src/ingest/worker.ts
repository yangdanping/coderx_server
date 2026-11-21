import { loadRuntimeConfig, loadRuntimeEnvironment } from './config/runtime.js';
import type { runCli } from './cli.js';

interface WorkerConfig {
  enabled: boolean;
  schedule: string;
  timezone: string;
  autoPublish?: boolean;
}

type WorkerLogger = Pick<Console, 'info' | 'error'>;
type Stoppable = { stop(): void | Promise<void> };
type Schedule<Task> = {
  schedule(expression: string, callback: () => Promise<unknown>, options: { name: string; noOverlap: boolean; timezone: string }): Task;
};

type ScheduledActions = Parameters<typeof runCli>[1]['actions'] & { close(): Promise<void> };

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function startWorker<Task>({ cron, run, config, logger = console }: { cron: Schedule<Task>; run(): Promise<unknown>; config: WorkerConfig; logger?: WorkerLogger }) {
  if (!cron || typeof cron.schedule !== 'function') throw new TypeError('cron.schedule is required');
  if (typeof run !== 'function') throw new TypeError('run is required');

  return cron.schedule(
    config.schedule,
    async () => {
      if (!config.enabled) {
        const result = {
          skipped: true,
          reason: 'INGEST_ENABLED is disabled',
        };
        logger.info('[ingest] scheduled run skipped because INGEST_ENABLED is disabled');
        return result;
      }

      try {
        const result = await run();
        logger.info(`[ingest] scheduled run completed: ${JSON.stringify(result)}`);
        return result;
      } catch (error) {
        const result = {
          failed: true,
          message: messageFromError(error),
        };
        logger.error('[ingest] scheduled run failed', error);
        return result;
      }
    },
    {
      name: 'coderx_ingest_worker',
      noOverlap: true,
      timezone: config.timezone,
    },
  );
}

export function createScheduledIngest({
  cron,
  config,
  createActions,
  logger = console,
}: {
  cron: Schedule<Stoppable>;
  config: WorkerConfig;
  createActions(): Promise<ScheduledActions>;
  logger?: WorkerLogger;
}) {
  let actions: Promise<ScheduledActions> | undefined;
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let stopping = false;

  const task = startWorker({
    cron,
    config,
    logger,
    async run() {
      if (stopping) return { skipped: true, reason: 'Ingest worker is stopping' };
      const execution = (async () => {
        actions ??= createActions().catch((error) => {
          actions = undefined;
          throw error;
        });
        const scheduledActions = await actions;
        const { runCli } = await import('./cli.js');
        return await runCli(['run'], {
          actions: scheduledActions,
          config,
          write(output) {
            logger.info(output.trim());
          },
        });
      })();
      active.add(execution);
      try {
        return await execution;
      } finally {
        active.delete(execution);
      }
    },
  });

  async function stop() {
    stopping = true;
    try {
      await task.stop();
    } finally {
      await Promise.allSettled(active);
      if (actions) await (await actions).close();
    }
  }

  return { close: () => (closing ??= stop()) };
}

async function main() {
  loadRuntimeEnvironment();
  const config = loadRuntimeConfig();
  const cron = await import('node-cron');
  const runtime = createScheduledIngest({
    cron,
    config,
    async createActions() {
      const { createDefaultActions } = await import('./cli.js');
      return createDefaultActions(config);
    },
  });

  const shutdown = () => {
    void runtime
      .close()
      .catch((error: unknown) => {
        process.stderr.write(`${messageFromError(error)}\n`);
        process.exitCode = 1;
      })
      .finally(() => {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${messageFromError(error)}\n`);
    process.exitCode = 1;
  });
}

export { startWorker };
