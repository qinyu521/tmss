import 'dotenv/config';
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const built = await buildApp();
try {
  await built.app.listen({ port, host });
  built.app.log.info(
    `天命史书 API 已启动 http://${host}:${port}（单机模式；SQLite: ${built.dbPath}）`,
  );
  process.stdout.write(`\n天命史书 API: http://localhost:${port}\n健康检查: http://localhost:${port}/api/health\n\n`);
} catch (err) {
  built.app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  built.app.log.info(`收到 ${signal}，正在关闭…`);
  await built.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
