import http from "node:http";

import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

import { startHealthServer } from "../src/main";
import { bootstrapMetrics } from "../src/observability/bootstrap";
import { getMeter } from "../src/observability/telemetry";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
  }
}

function get(url: string): Promise<{ readonly status: number | undefined; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const exporter = new PrometheusExporter({ preventServerStart: true, endpoint: "/metrics" });
  bootstrapMetrics(exporter);
  getMeter().createCounter("observability_metrics_probe").add(1, { tenant_id: "tenant-a" });

  const pool = { query: async () => ({ rows: [] }) };
  const server = startHealthServer(pool as never, 0, exporter);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("health server did not bind a TCP address");
    const res = await get(`http://127.0.0.1:${addr.port}/metrics`);
    check("/metrics returns 200", res.status === 200, String(res.status));
    check("/metrics exposes prometheus text", res.body.includes("observability_metrics_probe"), res.body.slice(0, 200));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))));
    await exporter.shutdown();
  }

  if (failures > 0) {
    console.error(`\nobservability-metrics-endpoint.unit: ${failures} FAIL`);
    process.exit(1);
  }
  console.log("\nobservability-metrics-endpoint.unit: ALL PASS");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
