// Tình huống 3 — Duy trì kết nối: 200 thanh toán × 1.000đ, 10 yêu cầu cùng lúc; nhàn rỗi 6 s rồi gọi tiếp.
// Mỗi chế độ chạy 3 lần (tiến trình mới mỗi lần), báo trung vị.
import { startBank, startFee, pay, pool, bankStats, sleep, median, saveReport, check } from './lib.js';

const RUNS = 3;

async function runOnce(mode, run) {
  const bank = await startBank({}, `s3-${mode}-run${run}-bank`);
  const fee = await startFee(mode, {}, `s3-${mode}-run${run}-fee`);

  const t = performance.now();
  const results = await pool(200, 10, () => pay(1, 1000));
  const totalMs = Math.round(performance.now() - t);
  const afterBurst = await bankStats();

  await sleep(6000); // ngân hàng đã đóng các kết nối nhàn rỗi (keepAliveTimeout 5 s)
  const afterIdle = [];
  for (let i = 0; i < 5; i++) afterIdle.push(await pay(1, 1000));
  const end = await bankStats();

  await fee.stop();
  await bank.stop();
  return {
    run,
    ok: results.filter((r) => r.status === 201).length,
    totalMs,
    connectionsBurst: afterBurst.connections,
    afterIdleOk: afterIdle.filter((r) => r.status === 201).length,
    afterIdleStatuses: afterIdle.map((r) => r.status),
    connectionsTotal: end.connections,
    bankStats: end,
  };
}

async function runMode(mode) {
  console.log(`\n=== TH3 · ${mode} ===`);
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce(mode, i);
    console.log(`run ${i}: ok=${r.ok}/200 total=${r.totalMs}ms connections=${r.connectionsBurst} afterIdle=${r.afterIdleOk}/5 (conn total ${r.connectionsTotal})`);
    runs.push(r);
  }
  const out = {
    mode,
    runs,
    median: {
      totalMs: median(runs.map((r) => r.totalMs)),
      connectionsBurst: median(runs.map((r) => r.connectionsBurst)),
      okBurst: median(runs.map((r) => r.ok)),
    },
  };
  out.criteria = {
    '200/200 thành công': check(runs.every((r) => r.ok === 200)),
    'Số kết nối TCP ≤ 20': check(runs.every((r) => r.connectionsBurst <= 20)),
    'Sau 6 s nhàn rỗi vẫn thành công': check(runs.every((r) => r.afterIdleOk === 5)),
  };
  console.table(out.criteria);
  return out;
}

const results = [];
for (const mode of ['naive', 'fixed']) results.push(await runMode(mode));
saveReport('s3-keep-alive', { scenario: 'TH3 - duy trì kết nối, 200 lệnh / 10 đồng thời', results });
