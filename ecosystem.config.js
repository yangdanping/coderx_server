// 执行 `pm2 start ~/coderx_server/ecosystem.config.js` 启动服务
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
