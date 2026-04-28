// PM2 ecosystem config for wi-chat-server
// 使用 fork 模式：SQLite 不支持多进程并发写，禁用 cluster。
// dotenv 由应用自身在 src/config.js 中加载，PM2 只负责进程管理和日志。
module.exports = {
  apps: [
    {
      name: "wi-chat-server",
      script: "src/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      kill_timeout: 10000,

      // 日志
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // 生产环境变量（其余变量由 .env 通过 dotenv 加载）
      env: {
        NODE_ENV: "production",
      },

      // 开发覆盖示例（npm run dev:pm2 时可切换）
      // env_development: {
      //   NODE_ENV: "development",
      //   DEBUG_HTTP_LOG: "1",
      //   INFO_LOG_ENABLED: "1",
      // },
    },
  ],
};
