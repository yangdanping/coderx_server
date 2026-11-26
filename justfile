# 交互式升级所有包到最新版本
up:
    pnpm up -i --latest

# 安装/升级依赖
i:
    pnpm i

# 在服务器上生成JWT密钥对
generate-keys:
    pnpm exec tsx ./src/app/keys/generate-keys.ts
    @echo "✅ JWT密钥对已生成"

# 推送环境配置到 MacBook
push-env-to-macbook:
    scp .env.production .env.development macbook:/Users/yangdanping/Desktop/personal_project/coderx_server/
    @echo "✅ 环境配置文件已推送到 MacBook"

# 从 MacBook 拉取环境配置
pull-env-from-macbook:
    scp macbook:/Users/yangdanping/Desktop/personal_project/coderx_server/.env.production .
    scp macbook:/Users/yangdanping/Desktop/personal_project/coderx_server/.env.development .
    @echo "✅ 环境配置已从 MacBook 拉取"

# 仅启动主服务器（开发环境）
dev:
    pnpm dev

# 仅启动Socket服务器（开发环境）
socket:
    pnpm dev:socket

# 构建
build:
    pnpm build

# 格式化代码
p:
    pnpm prettier --write .

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

# 启动已构建的独立 Hono 候选。配置、健康检查和恢复步骤见 deploy/README.md。
deploy-hono:
    #!/bin/bash
    set -eu
    : "${CODERX_HONO_RELEASE_DIR:?Set CODERX_HONO_RELEASE_DIR to the absolute release directory}"
    : "${APP_ENV_FILE:?Set APP_ENV_FILE to the absolute config file}"
    : "${APP_PORT:?Set APP_PORT to the candidate port}"
    if [[ "$CODERX_HONO_RELEASE_DIR" != /* || "$APP_ENV_FILE" != /* ]]; then
      echo "CODERX_HONO_RELEASE_DIR and APP_ENV_FILE must be absolute paths" >&2
      exit 1
    fi
    pm2 start "$CODERX_HONO_RELEASE_DIR/deploy/ecosystem.hono.config.cjs" --only coderx_hono_candidate
