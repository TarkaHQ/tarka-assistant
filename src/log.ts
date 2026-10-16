import pino from 'pino';
import { config } from './config.js';

const cfg = config();

export const log = pino({
  level: cfg.logLevel,
  base: { service: 'tarka-assistant' },
  redact: {
    paths: ['*.apiKey', '*.token', '*.access_token', '*.refresh_token', '*.password', 'headers.authorization'],
    censor: '[redacted]',
  },
  ...(cfg.isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } }),
});

export type Logger = typeof log;
