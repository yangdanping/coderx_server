import dotenv from 'dotenv';
import path from 'node:path';
export function loadEnvironment() {
  const envFile = path.resolve(process.cwd(), process.env.APP_ENV_FILE ?? (process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'));
  const result = dotenv.config({ path: envFile, quiet: true });
  if (process.env.APP_ENV_FILE !== undefined && result.error) throw result.error;
}
