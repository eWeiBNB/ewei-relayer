import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: {
    service: 'ewei-relayer',
    version: process.env.npm_package_version || '1.2.0',
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export function createChildLogger(component: string) {
  return logger.child({ component });
}
