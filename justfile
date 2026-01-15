# 安装/升级依赖
i:
  pnpm i

# 交互式升级所有包到最新版本
up:
  pnpm up -i --latest

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