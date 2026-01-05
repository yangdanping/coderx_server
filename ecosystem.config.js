/* 执行 `pm2 start ~/coderx_server/ecosystem.config.js` 启动服务
允许一次性启动多个相关服务（如 Koa 服务器和 Socket 服务器）
并在生产环境中保持进程稳定运行，而无需手动管理每个 Node.js 进程
pm2 在指定的 cwd 目录下启动对应的 script 文件作为独立进程,env 设置生产环境变量
*/
module.exports = {
  apps: [
    {
      name: 'coderx_koa_server',
      script: './src/main.js',
      cwd: '/root/coderx_server',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'coderx_socket_server',
      script: './src/socket_server.js',
      cwd: '/root/coderx_server',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
