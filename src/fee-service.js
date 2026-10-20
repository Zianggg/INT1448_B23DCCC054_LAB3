// Fee Service — cổng 4001 (PORT để đổi).
//   BANK_URL  địa chỉ ngân hàng, mặc định http://localhost:4002
//   FEE_MODE  "fixed" (mặc định, bản sau khi sửa) | "naive" (bản trước khi sửa); hoặc truyền --naive
import { randomUUID } from 'node:crypto';
import express from 'express';
import { chargeNaive, chargeWithRetry, CONFIG } from './bank-client.js';

const PORT = Number(process.env.PORT ?? 4001);
const BANK_URL = process.env.BANK_URL ?? 'http://localhost:4002';
const MODE = process.argv.includes('--naive') ? 'naive' : (process.env.FEE_MODE ?? 'fixed');
const QUIET = process.env.QUIET === '1';

// Công nợ trong bộ nhớ
const debts = new Map([
  ['1', 50_000_000],
  ['2', 0],
  ['3', 3_200_000],
]);
const payments = new Map(); // P1, P2… -> payment
let nextPayment = 1;
// Mã lệnh P1, P2… đếm lại từ đầu mỗi lần khởi động, nên reference / Idempotency-Key gửi ngân hàng
// phải gắn thêm mã phiên chạy, nếu không P1 mới sẽ "trùng khóa" với P1 cũ và nhận nhầm giao dịch cũ.
const BOOT_ID = randomUUID().slice(0, 8);

// Tiền của các lệnh chưa biết kết quả (đang gửi / PENDING) được giữ chỗ để không thanh toán vượt công nợ.
function reservedAmount(studentId) {
  let sum = 0;
  for (const p of payments.values()) {
    if (p.studentId === studentId && (p.status === 'PROCESSING' || p.status === 'PENDING')) sum += p.amount;
  }
  return sum;
}

function publicPayment(p) {
  const { id, reference, studentId, amount, status, chargeId, attempts, createdAt, updatedAt } = p;
  return { paymentId: id, reference, studentId, amount, status, chargeId, attempts, createdAt, updatedAt };
}

function applyResult(payment, result) {
  payment.status = result.status;
  payment.updatedAt = new Date().toISOString();
  if (result.status === 'PAID') {
    payment.chargeId = result.chargeId;
    // Công nợ chỉ giảm khi ngân hàng đã xác nhận trừ tiền
    debts.set(payment.studentId, debts.get(payment.studentId) - payment.amount);
  }
}

function sendResult(res, payment, result) {
  if (result.status === 'PAID') {
    return res.status(201).json({ ...publicPayment(payment), remainingDebt: debts.get(payment.studentId) });
  }
  return res.status(result.http).json({
    error: result.error,
    paymentId: payment.id,
    status: result.status,
    attempts: payment.attempts,
  });
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, mode: MODE, bankUrl: BANK_URL }));

app.get('/students/:id/fees', (req, res) => {
  const id = req.params.id;
  if (!debts.has(id)) return res.status(404).json({ error: 'student not found', paymentId: null, status: null });
  res.json({ studentId: Number(id), debt: debts.get(id), pendingAmount: reservedAmount(id) });
});

app.post('/students/:id/payments', async (req, res) => {
  const studentId = req.params.id;
  const amount = req.body?.amount;
  if (!debts.has(studentId)) {
    return res.status(404).json({ error: 'student not found', paymentId: null, status: 'FAILED' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive integer', paymentId: null, status: 'FAILED' });
  }
  const available = debts.get(studentId) - (MODE === 'fixed' ? reservedAmount(studentId) : 0);
  if (amount > available) {
    return res.status(400).json({
      error: `amount ${amount} exceeds outstanding debt ${available}`,
      paymentId: null,
      status: 'FAILED',
    });
  }

  const now = new Date().toISOString();
  const id = `P${nextPayment++}`;
  const payment = { id, reference: `${BOOT_ID}-${id}`, studentId, amount, status: 'PROCESSING', attempts: 0, createdAt: now, updatedAt: now };
  payments.set(payment.id, payment);

  const started = Date.now();
  const result = MODE === 'naive' ? await chargeNaive(BANK_URL, payment) : await chargeWithRetry(BANK_URL, payment);
  applyResult(payment, result);
  if (!QUIET) {
    console.log(`[fee] ${payment.id} ${amount} -> ${result.status} ${result.http} attempts=${payment.attempts} ${Date.now() - started}ms`);
  }
  sendResult(res, payment, result);
});

app.get('/payments', (_req, res) => res.json([...payments.values()].map(publicPayment)));

app.get('/payments/:pid', (req, res) => {
  const p = payments.get(req.params.pid);
  if (!p) return res.status(404).json({ error: 'payment not found', paymentId: req.params.pid, status: null });
  res.json(publicPayment(p));
});

// Đối soát lệnh PENDING: gửi lại với cùng Idempotency-Key. Nếu ngân hàng đã trừ tiền thì nhận lại
// giao dịch cũ (không trừ thêm); nếu chưa thì giờ mới trừ — lệnh vẫn chỉ bị trừ đúng một lần.
app.post('/payments/:pid/reconcile', async (req, res) => {
  const p = payments.get(req.params.pid);
  if (!p) return res.status(404).json({ error: 'payment not found', paymentId: req.params.pid, status: null });
  if (p.status !== 'PENDING') return res.json(publicPayment(p));
  p.status = 'PROCESSING';
  const result = await chargeWithRetry(BANK_URL, p);
  // Đối soát mà vẫn không chắc chắn chưa trừ tiền thì giữ PENDING, không bao giờ chuyển thẳng sang FAILED.
  applyResult(p, result.status === 'FAILED' && result.http >= 500 ? { ...result, status: 'PENDING' } : result);
  if (p.status === 'PAID') return res.json({ ...publicPayment(p), remainingDebt: debts.get(p.studentId) });
  sendResult(res, p, { ...result, status: p.status, http: p.status === 'PENDING' ? 504 : result.http });
});

// Lỗi không lường trước (JSON hỏng…) vẫn trả JSON đúng quy ước, không phải trang HTML của Express.
app.use((err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ error: err.message, paymentId: null, status: 'FAILED' });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error(`[fee] cannot listen on :${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[fee] listening on :${PORT} mode=${MODE} BANK_URL=${BANK_URL}` +
    (MODE === 'fixed' ? ` connectTimeout=${CONFIG.CONNECT_TIMEOUT_MS}ms deadline=${CONFIG.DEADLINE_MS}ms maxAttempts=${CONFIG.MAX_ATTEMPTS}` : ''));
});
