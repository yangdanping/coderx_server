import bcrypt from 'bcryptjs';

export function hashPwd(password: unknown): string {
  if (typeof password !== 'string') throw new Error(`Illegal arguments: ${typeof password}, string`);
  return bcrypt.hashSync(password, bcrypt.genSaltSync(10));
}

export function comparePwd(password: unknown, hash: unknown): boolean {
  if (typeof password !== 'string' || typeof hash !== 'string') {
    throw new Error(`Illegal arguments: ${typeof password}, ${typeof hash}`);
  }
  return bcrypt.compareSync(password, hash);
}
