// Tình huống 2 — Ngân hàng phản hồi rất chậm (DELAY_MS=5000).
import { startBank, startFee, pay, fees, call, FEE, bankStats, sleep, median, countBy, saveReport, check } from './lib.js';

async function runMode(mode) {
  console.log(`\n=== TH2 · ${mode} ===`);
  const bank = await startBank({ DELAY_MS: '5000' }, `s2-${mode}-bank`);
  const fee = await startFee(mode, {}, `s2-${mode}-fee`);

  // 1 thanh toán
  const single = await pay(1, 100_000);

  // 20 thanh toán cùng lúc; trong lúc chờ gọi GET fees nhiều lần
  const t0 = performance.now();
  const burst = Promise.all(Array.from({ length: 20 }, () => pay(1, 100_000)));
  const reads = [];
  for (const at of [200, 1000, 2000, 3000]) {
    await sleep(at - (performance.now() - t0));
    reads.push(await fees(1));
  }
  const many = await burst;

  // Bản sửa: đợi ngân hàng xử lý xong (≈5 s kể từ lúc nhận) rồi đối soát 21 lệnh PENDING bằng cùng Idempotency-Key.
  let reconcile;
  if (mode === 'fixed') {
    await sleep(1500);
    const ids = [single, ...many].filter((r) => r.body.status === 'PENDING').map((r) => r.body.paymentId);
    const rec = await Promise.all(ids.map((id) => call('POST', `${FEE}/payments/${id}/reconcile`)));
    reconcile = {
      pending: ids.length,
      statusCounts: countBy(rec, (r) => r.body.status),
      msMax: Math.max(...rec.map((r) => r.ms)),
      bank: await bankStats(),
      debt: (await fees(1)).body.debt,
    };
  }
  await fee.stop();
  await bank.stop();

  const out = {
    mode,
    single: { status: single.status, body: single.body, ms: single.ms },
    burst20: {
      httpCounts: countBy(many, (r) => r.status),
      statusCounts: countBy(many, (r) => r.body.status),
      msMedian: median(many.map((r) => r.ms)),
      msMax: Math.max(...many.map((r) => r.ms)),
    },
    reconcile,
    feesDuringBurst: { statuses: reads.map((r) => r.status), ms: reads.map((r) => r.ms), msMax: Math.max(...reads.map((r) => r.ms)) },
  };
  out.criteria = {
    '504 + status PENDING': check(single.status === 504 && single.body.status === 'PENDING'),
    'Tổng thời gian ≤ 4,5 s (1 lệnh)': check(single.ms <= 4500),
    'Tổng thời gian ≤ 4,5 s (20 lệnh)': check(out.burst20.msMax <= 4500),
    'GET fees < 300 ms khi 20 lệnh đang chờ': check(reads.every((r) => r.status === 200 && r.ms < 300)),
  };
  console.log(JSON.stringify(out, null, 1));
  console.table(out.criteria);
  return out;
}

const results = [];
for (const mode of ['naive', 'fixed']) results.push(await runMode(mode));
saveReport('s2-slow-bank', { scenario: 'TH2 - ngân hàng chậm DELAY_MS=5000', results });
