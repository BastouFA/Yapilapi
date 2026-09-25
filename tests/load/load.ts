/**
 * Minimal load/latency smoke test using Node's built-in fetch (no extra tooling).
 *   npm run test:load -- [baseUrl] [concurrency] [seconds]
 * Targets read-only public endpoints of a RUNNING API. It is a smoke test, not a capacity plan: run realistic
 * scenarios (k6/Gatling) against a production-like environment before launch. Fails (exit 1) if error rate > 1%
 * or p95 latency exceeds LOAD_P95_MS (default 500).
 */
const base = process.argv[2] ?? 'http://127.0.0.1:4000';
const concurrency = Number(process.argv[3] ?? 20);
const seconds = Number(process.argv[4] ?? 10);
const p95Budget = Number(process.env['LOAD_P95_MS'] ?? 500);
const paths = ['/health/ready', '/v1/meta', '/v1/communities', '/health/live'];

const latencies: number[] = [];
let errors = 0;
const end = Date.now() + seconds * 1000;

async function worker(): Promise<void> {
  let i = 0;
  while (Date.now() < end) {
    const url = base + paths[i++ % paths.length];
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.status >= 500) errors++;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
const rate = latencies.length / seconds;
console.log(
  JSON.stringify(
    {
      requests: latencies.length,
      rps: Math.round(rate),
      errors,
      errorRate: +(errors / Math.max(1, latencies.length)).toFixed(4),
      p50ms: +pct(0.5).toFixed(1),
      p95ms: +pct(0.95).toFixed(1),
      p99ms: +pct(0.99).toFixed(1),
    },
    null,
    2,
  ),
);
if (errors / Math.max(1, latencies.length) > 0.01 || pct(0.95) > p95Budget) process.exit(1);
