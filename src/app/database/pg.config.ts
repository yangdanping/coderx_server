interface PgConnectionEnvironment {
  DATABASE_URL?: string;
  PGHOST?: string;
  PGPORT?: string;
  PGDATABASE?: string;
  PGUSER?: string;
  PGPASSWORD?: string;
}

const requiredKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const;

export function buildPgPoolConfig(config: PgConnectionEnvironment) {
  if (config.DATABASE_URL) {
    return { connectionString: config.DATABASE_URL, max: 10 };
  }

  const missingKeys = requiredKeys.filter(key => !config[key]);
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
}
