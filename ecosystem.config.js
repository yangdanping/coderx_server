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
      // 传递给 pnpm 的参数，对应 package.json 中的 scripts.start(在 npm/pnpm 中，start/test/stop/restart 脚本命令是内置标准的，可以省略 run 直接调用)
      args: 'start',
      // 告知 PM2 直接运行 pnpm 命令，不要尝试用 node 去解释 pnpm 本身
      interpreter: 'none',
      // 项目在生产服务器上的绝对路径，确保 pnpm 在正确的目录下执行
      cwd: '/root/coderx_server',
      env: {
        // 设置生产环境标识，供应用内部逻辑（如日志、数据库连接）判断
        NODE_ENV: 'production',
      },
    },
    {
      name: 'coderx_socket_server',
      script: 'pnpm',
      // 对应 package.json 中的 scripts["start:socket"]
      args: 'run start:socket', // start:socket 是自定义脚本名称，不属于上述的内置标准命令。
      interpreter: 'none',
      cwd: '/root/coderx_server',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
