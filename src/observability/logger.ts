import pino, { type Logger } from "pino";
import type { Config } from "../config.js";

export function createLogger(config: Config): Logger {
  return pino({ level: config.logLevel, base: { service: "wechat-personal-gateway", version: "0.1.0" } });
}

export type AppLogger = Logger;
