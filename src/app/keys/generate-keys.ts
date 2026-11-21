import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function generateJwtKeys(directory: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const privateKeyPath = join(directory, 'private.key');
  const publicKeyPath = join(directory, 'public.key');
  writeFileSync(privateKeyPath, privateKey);
  writeFileSync(publicKeyPath, publicKey);
  return { privateKeyPath, publicKeyPath };
}

if (import.meta.main) {
  const { privateKeyPath, publicKeyPath } = generateJwtKeys(dirname(fileURLToPath(import.meta.url)));
  console.log('✅ JWT密钥对已生成');
  console.log('⚠️  请妥善保管 private.key，不要提交到Git');
  console.log('');
  console.log('密钥文件位置：');
  console.log('  - private.key:', privateKeyPath);
  console.log('  - public.key:', publicKeyPath);
}
