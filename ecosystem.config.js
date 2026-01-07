/* 执行 `pm2 start ~/coderx_server/ecosystem.config.js` 启动服务
允许一次性启动多个相关服务（如 Koa 服务器和 Socket 服务器）
并在生产环境中保持进程稳定运行，而无需手动管理每个 Node.js 进程
pm2 在指定的 cwd 目录下启动对应的 script 文件作为独立进程,env 设置生产环境变量
*/
module.exports = {
  apps: [
    {
      name: 'coderx_koa_server',
      // 使用 pnpm 启动，确保能正确加载 pnpm 管理的 node_modules 符号链接
      script: 'pnpm',
      // 传递给 pnpm 的参数，对应 package.json 中的 scripts.start
      args: 'start',
      // 告知 PM2 直接运行 pnpm 命令，不要尝试用 node 去解释 pnpm 本身
      interpreter: 'none',
      // 项目在生产服务器上的绝对路径
      cwd: '/root/coderx_server',
      // 加载环境变量文件（关键配置，解决数据库连接和 CORS 问题）
      env_file: '/root/coderx_server/.env.production',
      env: {
        // 设置生产环境标识，供应用内部逻辑（如日志、数据库连接）判断
        NODE_ENV: 'production',
      },
      // 自动重启配置
      autorestart: true,
      // 监听文件变化（生产环境建议关闭）
      watch: false,
      // 最大内存限制
      max_memory_restart: '500M',
      // 错误日志
      error_file: '/root/.pm2/logs/coderx-koa-server-error.log',
      // 输出日志
      out_file: '/root/.pm2/logs/coderx-koa-server-out.log',
      // 日志时间格式
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'coderx_socket_server',
      script: 'pnpm',
      // 对应 package.json 中的 scripts["start:socket"]
      args: 'run start:socket',
      interpreter: 'none',
      cwd: '/root/coderx_server',
      // 加载环境变量文件
      env_file: '/root/coderx_server/.env.production',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/root/.pm2/logs/coderx-socket-server-error.log',
      out_file: '/root/.pm2/logs/coderx-socket-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
