# JWT 密钥管理

## 📌 重要提示

**⚠️ 这个目录中的 `*.key` 文件包含敏感信息，已被添加到 `.gitignore`，绝对不要提交到 Git！**

## 生成密钥

首次部署或密钥泄露后需要重新生成：

```bash
node generate-keys.js
```

这将在当前目录生成：
- `private.key` - 私钥（用于签署 JWT token）
- `public.key` - 公钥（用于验证 JWT token）

## 安全注意事项

- ❌ **不要**将 `*.key` 文件提交到 Git
- ❌ **不要**在代码中硬编码密钥内容
- ❌ **不要**通过不安全的方式传输私钥
- ✅ 使用 `generate-keys.js` 在服务器上直接生成
- ✅ 定期轮换密钥（建议每 6-12 个月）
- ✅ 密钥泄露后立即重新生成并强制所有用户重新登录
- ✅ 备份私钥到安全位置（如密码管理器、加密存储）

## 部署到生产环境

### 首次部署

```bash
# SSH 登录到生产服务器
ssh user@your-server

# 进入项目目录
cd /path/to/project/src/app/keys

# 生成密钥对
node generate-keys.js

# 验证文件已生成
ls -la *.key
```

### 使用 justfile 自动化

在项目根目录执行：

```bash
# 在服务器上生成密钥
just generate-keys

# 或首次部署
just deploy-first-time
```

## 密钥轮换流程

当需要更换密钥时（定期维护或安全事件）：

1. **备份旧密钥**（以防回滚）
   ```bash
   cp private.key private.key.backup
   cp public.key public.key.backup
   ```

2. **生成新密钥**
   ```bash
   node generate-keys.js
   ```

3. **重启应用服务**
   ```bash
   pm2 restart ecosystem.config.js
   ```

4. **验证服务正常**
   - 测试新用户登录
   - 确认 JWT token 可以正常签发和验证

5. **通知用户**
   - 旧 token 将全部失效
   - 用户需要重新登录

6. **删除备份**（确认无问题后）
   ```bash
   rm *.backup
   ```

## 故障排查

### 问题：应用启动失败，提示找不到密钥文件

**原因**：密钥文件未生成

**解决**：
```bash
cd src/app/keys
node generate-keys.js
```

### 问题：用户无法登录，提示 "invalid signature"

**原因**：密钥文件损坏或不匹配

**解决**：
1. 检查密钥文件是否存在且可读
2. 重新生成密钥对
3. 重启应用

### 问题：意外将密钥提交到 Git

**解决**：参考项目文档 `说明文档/02_重构或优化/优化/04_敏感配置文件管理最佳实践.md`

## 相关文件

- `generate-keys.js` - 密钥生成脚本
- `private.key` - JWT 私钥（❌ 不提交到 Git）
- `public.key` - JWT 公钥（❌ 不提交到 Git）
- `../../config.js` - 配置文件（引用密钥路径）

## 技术细节

- **算法**：RSA
- **密钥长度**：2048 位
- **编码格式**：PEM
- **公钥类型**：SPKI (SubjectPublicKeyInfo)
- **私钥类型**：PKCS#8

## 安全审计记录

建议记录密钥生成和轮换的时间：

- 最近生成时间：_________
- 下次计划轮换：_________
- 密钥管理负责人：_________
