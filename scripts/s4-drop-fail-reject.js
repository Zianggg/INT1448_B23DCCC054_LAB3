// Tình huống 4 — (a) DROP_RATE=0.3, (b) FAIL_RATE=0.3: 60 thanh toán lần lượt; (c) thanh toán 25.000.000đ.
import { startBank, startFee, pay, fees, call, FEE, bankStats, countBy, saveReport, check } from './lib.js';

const N = 60;
const AMOUNT = 100_000;

async function runBatch(mode, label, bankEnv) {
  const bank = await startBank({ ...bankEnv }, `s4${label}-${mode}-bank`);
  const fee = await startFee(mode, {}, `s4${label}-${mode}-fee`);
  const debtBefore = (await fees(1)).body.debt;

  const results = [];
  for (let i = 0; i < N; i++) results.push(await pay(1, AMOUNT));
  const debtAfter = (await fees(1)).body.debt;
  const stats = await bankStats();
  const paid = results.filter((r) => r.body.status === 'PAID').length;
  const notOk = results.filter((r) => r.body.status !== 'PAID');

  const out = {
    mode,
    paid,
    httpCounts: countBy(results, (r) => r.status),
    statusCounts: countBy(results, (r) => r.body.status),
    msMax: Math.max(...results.map((r) => r.ms)),
    bank: stats,
    debtDrop: debtBefore - debtAfter,
    expectedDebtDrop: paid * AMOUNT,
    chargedButNotPaid: stats.charges - paid, // tiền đã bị trừ mà Fee Service không ghi nhận
    failedExamples: notOk.slice(0, 3).map((r) => ({ http: r.status, ...r.body })),
  };

  // Bản sửa: đối soát các lệnh PENDING bằng cùng Idempotency-Key → không trừ thêm, công nợ khớp ngân hàng.
  if (mode === 'fixed') {
    const pending = results.filter((r) => r.body.status === 'PENDING').map((r) => r.body.paymentId);
    const rec = [];
    for (const id of pending) rec.push((await call('POST', `${FEE}/payments/${id}/reconcile`)).body.status);
    const s = await bankStats();
    const all = (await call('GET', `${FEE}/payments`)).body;
    out.afterReconcile = { pending, results: rec, paidTotal: all.filter((p) => p.status === 'PAID').length, bank: s };
  }

  await fee.stop();
  await bank.stop();
  return out;
}

async function runReject(mode) {
  const bank = await startBank({}, `s4c-${mode}-bank`);
  const fee = await startFee(mode, {}, `s4c-${mode}-fee`);
  const r = await pay(1, 25_000_000);
  const stats = await bankStats();
  await fee.stop();
  await bank.stop();
  return { mode, status: r.status, body: r.body, ms: r.ms, bankRequests: stats.requests, bank: stats };
}

const report = { scenario: 'TH4 - đứt giữa chừng / lỗi tạm thời / bị từ chối', a: [], b: [], c: [] };
for (const mode of ['naive', 'fixed']) {
  console.log(`\n=== TH4 · ${mode} ===`);
  const a = await runBatch(mode, 'a', { DROP_RATE: '0.3' });
  a.criteria = {
    'duplicates = 0': check(a.bank.duplicates === 0),
    '≥ 54/60 thành công': check(a.paid >= 54),
    'Lệnh hỏng trả 504 + PENDING': check(Object.keys(a.statusCounts).every((s) => s === 'PAID' || s === 'PENDING') && (a.httpCounts[504] ?? 0) === N - a.paid),
    'Công nợ chỉ giảm đúng tiền lệnh PAID': check(a.debtDrop === a.expectedDebtDrop),
    '≤ 4,5 s mỗi lệnh': check(a.msMax <= 4500),
  };
  console.log('(a)', JSON.stringify(a, null, 1));
  console.table(a.criteria);

  const b = await runBatch(mode, 'b', { FAIL_RATE: '0.3' });
  b.criteria = {
    '≥ 54/60 thành công': check(b.paid >= 54),
    'Không trừ tiền hai lần': check(b.bank.duplicates === 0),
    '≤ 4,5 s mỗi lệnh': check(b.msMax <= 4500),
  };
  console.log('(b)', JSON.stringify(b, null, 1));
  console.table(b.criteria);

  // (a') DROP_RATE=1: lần thử nào cũng bị cắt sau khi trừ tiền → buộc đi vào nhánh 504 PENDING
  {
    const bank = await startBank({ DROP_RATE: '1' }, `s4a1-${mode}-bank`);
    const fee = await startFee(mode, {}, `s4a1-${mode}-fee`);
    const before = (await fees(1)).body.debt;
    const r = await pay(1, AMOUNT);
    const after = (await fees(1)).body;
    const stats = await bankStats();
    await fee.stop();
    await bank.stop();
    a.dropAlways = { http: r.status, body: r.body, ms: r.ms, debtDrop: before - after.debt, pendingAmount: after.pendingAmount, bank: stats };
    console.log("(a') DROP_RATE=1", JSON.stringify(a.dropAlways));
  }

  const c = await runReject(mode);
  c.criteria = {
    'Trả 402': check(c.status === 402),
    'Ngân hàng nhận đúng 1 yêu cầu': check(c.bankRequests === 1),
  };
  console.log('(c)', JSON.stringify(c, null, 1));
  console.table(c.criteria);

  report.a.push(a);
  report.b.push(b);
  report.c.push(c);
}
saveReport('s4-drop-fail-reject', report);
