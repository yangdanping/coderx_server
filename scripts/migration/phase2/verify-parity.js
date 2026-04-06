#!/usr/bin/env node

const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool, formatVerificationSummary, verifyParity } = require('./lib/runtime');

const main = async () => {
  const runtime = buildRuntimeConfig(process.argv.slice(2));
  const mysqlPool = createMySqlPool(runtime.mysqlConfig);
  const pgPool = createPgPool(runtime.pgConfig);

  try {
    const report = await verifyParity(mysqlPool, pgPool, runtime.mysqlConfig.database, {
      sampleLimit: runtime.sampleLimit,
    });

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatVerificationSummary(report));

    if (!report.isSuccess) {
      process.exitCode = 1;
    }
  } finally {
    await closePools(mysqlPool, pgPool);
  }
};

main().catch((error) => {
  console.error('Phase 2 verification failed.');
  console.error(error);
  process.exitCode = 1;
});
