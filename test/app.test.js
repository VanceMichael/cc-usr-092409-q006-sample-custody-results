import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("健康检查可通过 HTTP 访问", async () => {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, "wetland-observation-merger");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
