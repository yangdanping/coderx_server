#!/usr/bin/env node

const {
  bootstrapPostgresFromMySql,
  buildRuntimeConfig,
  closePools,
  createMySqlPool,
  createPgPool,
  formatVerificationSummary,
  verifyParity,
} = require('./lib/runtime');

const main = async () => {
  const runtime = buildRuntimeConfig(process.argv.slice(2));
  const mysqlPool = createMySqlPool(runtime.mysqlConfig);
  const pgPool = createPgPool(runtime.pgConfig);

  try {
    const bootstrapResult = await bootstrapPostgresFromMySql(mysqlPool, pgPool, runtime.mysqlConfig.database);
    const verificationReport = await verifyParity(mysqlPool, pgPool, runtime.mysqlConfig.database, {
      sampleLimit: runtime.sampleLimit,
    });

    console.log('Phase 2 bootstrap completed.');
    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(`Imported tables: ${bootstrapResult.importReport.length}`);
    bootstrapResult.importReport.forEach((item) => {
      console.log(`- ${item.table}: imported ${item.importedRowCount} rows`);
    });
    console.log(
      `Reset sequences: ${bootstrapResult.resetSequenceTargets.length > 0 ? bootstrapResult.resetSequenceTargets.join(', ') : 'none'}`
    );
    console.log('');
    console.log(formatVerificationSummary(verificationReport));

    if (!verificationReport.isSuccess) {
      process.exitCode = 1;
    }
  } finally {
    await closePools(mysqlPool, pgPool);
  }
};

main().catch((error) => {
  console.error('Phase 2 bootstrap failed.');
  console.error(error);
  process.exitCode = 1;
});
