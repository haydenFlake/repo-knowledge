export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let useStderr = false;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * When enabled, all log output (including info/debug) goes to stderr.
 * Required for MCP mode where stdout is reserved for JSON-RPC.
 */
export function setLoggerStderr(enabled: boolean): void {
  useStderr = enabled;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog("debug")) {
      if (useStderr) {
        console.error(`[DEBUG] ${message}`, ...args);
      } else {
        console.debug(`[DEBUG] ${message}`, ...args);
      }
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      if (useStderr) {
        console.error(message, ...args);
      } else {
        console.log(message, ...args);
      }
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog("warn")) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (shouldLog("error")) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  },
};
