import Koa from "koa";
import { MergerService } from "./domain/merger.js";
import { buildRoutes } from "./http/routes.js";
import { HANDOVER_TIMEOUT_MS } from "./domain/policy.js";

export function buildApp({ journalFile, sweep = true } = {}) {
  // 构造即重放哈希链日志：崩溃恢复路径与正常处理路径共用同一归约器。
  const service = new MergerService({ journalFile });
  const app = new Koa();
  app.context.merger = service;
  app.use(buildRoutes(service));

  if (sweep) {
    // 持续看护：周期性重算超时交接与复测待办。待办由领域事件落盘，
    // sweep 只把到期项标记 overdue，不产生额外写入。
    const timer = setInterval(() => {
      try {
        service.recover();
      } catch (error) {
        // 巡查失败不能拖垮进程。
        // eslint-disable-next-line no-console
        console.error("recovery sweep failed:", error.message);
      }
    }, Math.min(HANDOVER_TIMEOUT_MS, 60 * 1000));
    timer.unref?.();
    app.sweepTimer = timer;
  }

  return app;
}
