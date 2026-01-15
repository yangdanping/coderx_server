const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 生成RSA密钥对
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

// 保存到文件
const keysDir = __dirname;
fs.writeFileSync(path.join(keysDir, 'private.key'), privateKey);
fs.writeFileSync(path.join(keysDir, 'public.key'), publicKey);

console.log('✅ JWT密钥对已生成');
console.log('⚠️  请妥善保管 private.key，不要提交到Git');
console.log('');
console.log('密钥文件位置：');
console.log('  - private.key:', path.join(keysDir, 'private.key'));
console.log('  - public.key:', path.join(keysDir, 'public.key'));
