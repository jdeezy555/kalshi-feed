// PM2 config — start with:  pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'kalshi-feed',
      script: './kalshi-feed.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 30000,
      time: true,
    },
  ],
};
