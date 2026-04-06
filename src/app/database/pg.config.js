const buildPgPoolConfig = (config) => {
  if (config.DATABASE_URL) {
    return {
      connectionString: config.DATABASE_URL,
      max: 10,
    };
  }

  const requiredKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
  const missingKeys = requiredKeys.filter((key) => !config[key]);

  if (missingKeys.length > 0) {
    throw new Error(`Missing PostgreSQL config: ${missingKeys.join(', ')}`);
  }

  return {
    host: config.PGHOST,
    port: config.PGPORT,
    database: config.PGDATABASE,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    max: 10,
  };
};

module.exports = {
  buildPgPoolConfig,
};
