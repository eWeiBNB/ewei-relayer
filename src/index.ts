import { Relayer } from './relayer';
import { createApp } from './api';
import { config } from './config';
import { logger } from './logger';

const log = logger.child({ component: 'main' });

async function main(): Promise<void> {
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info('  eWei Relayer Node v1.2.0');
  log.info('  BNB Smart Chain Gas Sponsorship');
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const relayer = new Relayer();

  // Start relayer (wallet, gas oracle, monitor, queue polling)
  await relayer.start();

  // Start REST API
  const { queue, validator, getHealth } = relayer.getComponents();
  const app = createApp(queue, validator, getHealth);

  const server = app.listen(config.port, () => {
    log.info({ port: config.port }, 'API server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');

    server.close(() => {
      log.info('HTTP server closed');
    });

    await relayer.stop();

    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception - shutting down');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Failed to start relayer');
  process.exit(1);
});
