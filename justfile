# 安装/升级依赖
i:
  pnpm i

# 交互式升级所有包到最新版本
up:
  pnpm up -i --latest

# 在服务器上生成JWT密钥对
generate-keys:
  cd src/app/keys && node generate-keys.js
  @echo "✅ JWT密钥对已生成"

# 推送环境配置文件到生产服务器
push-env:
  scp .env.production root@95.40.29.75:/root/coderx_server
  scp .env.development root@95.40.29.75:/root/coderx_server
  @echo "✅ 环境配置文件已推送到生产服务器"

# 服务器部署
deploy:
  #!/bin/bash
  output=$(git pull)
  echo "$output"
  if echo "$output" | grep -q "Already up to date"; then
    echo "✅ 代码已是最新，无需重新安装依赖和重启服务"
  else
    echo "📦 检测到代码更新，开始安装依赖..."
    pnpm i
    echo "🔄 重启服务..."
    pm2 restart ecosystem.config.js
    echo "✅ 部署完成"
  fi

# 仅启动主服务器（开发环境）
dev:
  pnpm dev

# 仅启动Socket服务器（开发环境）
socket:
  pnpm dev:socket

# 构建
build:
  pnpm build

# 预览
preview:
  pnpm preview

# 格式化代码
prettier:
  pnpm prettier

# 更新Prettier配置
update-prettier:
  pnpm update:prettier

# 仅构建
build-only:
  pnpm build-only

# 类型检查
type-check:
  pnpm type-check

# 代码检查
lint:
  pnpm lint

# 生产环境启动主服务器
start:
  pnpm start

# 生产环境启动Socket服务器
start-socket:
  pnpm start:socket

# 首次部署（包含密钥生成）
deploy-first-time:
  #!/bin/bash
  echo "🚀 开始首次部署..."
  git pull
  pnpm i
  echo "🔑 生成JWT密钥对..."
  cd src/app/keys && node generate-keys.js && cd ../../..
  echo "▶️  启动服务..."
  pm2 start ecosystem.config.js
  echo "🎉 首次部署完成！"

# 完整部署流程（推送配置 + 代码部署）
deploy-full:
  just push-env
  ssh root@95.40.29.75 "cd /root/coderx_server && just deploy"
  @echo "🎉 完整部署完成！"
