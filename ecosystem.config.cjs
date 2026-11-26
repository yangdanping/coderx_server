// Checkout 的 PM2 启动示例。AWS 生产配置见 deploy/README.md。
module.exports = {
  apps: [
    {
      name: 'coderx_hono_server',
      script: 'pnpm',
      args: 'start',
      interpreter: 'none',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        CI: 'true',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'coderx_socket_server',
      script: 'pnpm',
      args: 'run start:socket',
      interpreter: 'none',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        CI: 'true',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'coderx_ingest_worker',
      script: 'pnpm',
      args: 'run start:ingest',
      interpreter: 'none',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        CI: 'true',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
