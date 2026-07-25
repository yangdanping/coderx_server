require('module-alias/register');

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

function startWorker({ cron, run, config, logger = console }) {
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

async function main() {
  const cron = require('node-cron');
  const { createDefaultActions, runCli } = require('@/ingest/cli');
  const { loadRuntimeConfig, loadRuntimeEnvironment } = require('@/ingest/config/runtime');
  loadRuntimeEnvironment();
  const config = loadRuntimeConfig();
  let actions;

  const task = startWorker({
    cron,
    config,
    logger: console,
    async run() {
      actions ||= createDefaultActions(config);
      return await runCli(['run'], {
        actions,
        config,
        write(output) {
          console.info(output.trim());
        },
      });
    },
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await task.stop();
    if (actions) await actions.close();
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return task;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${messageFromError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  startWorker,
};
