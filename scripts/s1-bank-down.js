// Tình huống 1 — Ngân hàng không kết nối được, rồi hoạt động lại (không khởi động lại Fee Service).
import { startBank, startFee, pay, fees, call, FEE, median, saveReport, check } from './lib.js';

async function runMode(mode) {
  console.log(`\n=== TH1 · ${mode} ===`);
  const out = { mode };

  for (const [label, bankUrl] of [['BANK_URL mặc định (:4002)', undefined], ['BANK_URL=http://localhost:4999', 'http://localhost:4999']]) {
    const fee = await startFee(mode, bankUrl ? { BANK_URL: bankUrl } : {}, `s1-${mode}-fee${bankUrl ? '-4999' : ''}`);
    const down = [];
    for (let i = 0; i < 3; i++) down.push(await pay(1, 100_000));
    const reads = [];
    for (let i = 0; i < 3; i++) reads.push(await fees(1));
    const health = await call('GET', `${FEE}/health`);
    const r = {
      paymentWhileDown: { statuses: down.map((d) => d.status), body: down[0].body, msRuns: down.map((d) => d.ms), msMedian: median(down.map((d) => d.ms)) },
      feesWhileDown: { statuses: reads.map((d) => d.status), msMedian: median(reads.map((d) => d.ms)) },
      feeServiceAlive: fee.alive() && health.status === 200,
    };

    if (!bankUrl) {
      // Bật ngân hàng, gọi lại — Fee Service vẫn là tiến trình cũ
      const bank = await startBank({}, `s1-${mode}-bank`);
      const up = await pay(1, 100_000);
      r.paymentAfterBankUp = { status: up.status, body: up.body, ms: up.ms };
      r.sameFeeProcess = fee.alive();
      await bank.stop();
    }
    await fee.stop();
    out[bankUrl ? 'bank4999' : 'bankDefault'] = r;
    console.log(label, JSON.stringify(r, null, 1));
  }

  // Thêm: địa chỉ không phản hồi SYN (blackhole) — kiểm tra timeout kết nối, không chỉ ECONNREFUSED
  {
    const fee = await startFee(mode, { BANK_URL: 'http://10.255.255.1:4002' }, `s1-${mode}-fee-blackhole`);
    const p = await pay(1, 100_000);
    const f = await fees(1);
    out.blackhole = { status: p.status, body: p.body, ms: p.ms, feesStatus: f.status, feesMs: f.ms };
    await fee.stop();
    console.log('BANK_URL=http://10.255.255.1:4002 (blackhole)', JSON.stringify(out.blackhole));
  }

  const d = out.bankDefault;
  out.criteria = {
    'Ngân hàng tắt → 503 + JSON error': check(d.paymentWhileDown.statuses.every((s) => s === 503) && !!d.paymentWhileDown.body.error),
    'Thời gian < 1,5 s': check(Math.max(...d.paymentWhileDown.msRuns) < 1500),
    'Fee Service không sập, GET fees 200': check(d.feeServiceAlive && d.feesWhileDown.statuses.every((s) => s === 200)),
    'Bank chạy lại → 201 không restart Fee': check(d.paymentAfterBankUp.status === 201 && d.sameFeeProcess),
    'Blackhole IP → 503 < 1,5 s (thêm)': check(out.blackhole.status === 503 && out.blackhole.ms < 1500),
    'BANK_URL :4999 hành vi giống': check(out.bank4999.paymentWhileDown.statuses.every((s) => s === 503) && Math.max(...out.bank4999.paymentWhileDown.msRuns) < 1500),
  };
  console.table(out.criteria);
  return out;
}

const results = [];
for (const mode of ['naive', 'fixed']) results.push(await runMode(mode));
saveReport('s1-bank-down', { scenario: 'TH1 - ngân hàng không kết nối được', results });
