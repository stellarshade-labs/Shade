import { Request, Response, NextFunction } from 'express';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
  requestId?: string;
}

class StructuredLogger {
  private requestCounter = 0;

  private formatLog(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  log(level: LogLevel, message: string, data?: any, requestId?: string) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data && { data }),
      ...(requestId && { requestId })
    };

    const formatted = this.formatLog(entry);

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'debug':
        if (process.env.DEBUG) {
          console.debug(formatted);
        }
        break;
      default:
        console.log(formatted);
    }
  }

  info(message: string, data?: any, requestId?: string) {
    this.log('info', message, data, requestId);
  }

  warn(message: string, data?: any, requestId?: string) {
    this.log('warn', message, data, requestId);
  }

  error(message: string, data?: any, requestId?: string) {
    this.log('error', message, data, requestId);
  }

  debug(message: string, data?: any, requestId?: string) {
    this.log('debug', message, data, requestId);
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const requestId = `req-${++this.requestCounter}-${Date.now()}`;
      (req as any).requestId = requestId;

      const startTime = Date.now();
      const originalSend = res.send;

      res.send = function(data: any) {
        const duration = Date.now() - startTime;

        logger.info('Request completed', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
          ip: req.ip
        }, requestId);

        return originalSend.call(this, data);
      };

      this.info('Request received', {
        method: req.method,
        path: req.path,
        ip: req.ip
      }, requestId);

      next();
    };
  }
}

export const logger = new StructuredLogger();
export default StructuredLogger;