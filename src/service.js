import { join } from "node:path";
import { EventLog } from "./eventlog.js";
import { CustodyService } from "./custody.js";

/**
 * 装配保管链服务：
 * 1. 打开仅追加事件日志并重放校验（链断裂/内容被改会直接拒绝启动）；
 * 2. 以"恢复时刻"立即巡检一次，把崩溃期间已超时的交接与复测补办为事件；
 * 3. 启动定时器持续推进超时待办；服务恢复后待办不丢。
 */
export function createService({ dir = join(process.cwd(), "data"), clock, scanIntervalMs = 60_000 } = {}) {
  const eventLog = new EventLog({ dir, clock });
  const service = new CustodyService(eventLog, { clock });
  service.load();
  service.tick();

  const timer = scanIntervalMs > 0
    ? setInterval(() => {
        try {
          service.tick();
        } catch (error) {
          // 巡检失败不应使进程崩溃；下一拍重试。
          console.error("[custody] tick failed:", error.message);
        }
      }, scanIntervalMs)
    : null;
  if (timer) timer.unref();

  return {
    service,
    eventLog,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
