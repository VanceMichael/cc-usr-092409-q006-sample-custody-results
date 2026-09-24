import { join } from "node:path";
import { buildApp } from "./app.js";
import { createService } from "./service.js";

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");

const runtime = createService({ dir: dataDir, scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 60_000) });
const server = buildApp({ service: runtime.service }).listen(port, "0.0.0.0");

function shutdown() {
  runtime.stop();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
