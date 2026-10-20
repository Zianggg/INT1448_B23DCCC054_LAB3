// Ngân hàng giả lập — cổng 4002 (PORT để đổi).
// Hành vi lỗi đặt bằng biến môi trường, khởi động lại để áp dụng:
//   DELAY_MS   trễ thêm ngần ấy ms trước khi xử lý
//   FAIL_RATE  (0–1) tỉ lệ trả 500 TRƯỚC khi trừ tiền
//   DROP_RATE  (0–1) tỉ lệ trừ tiền XONG rồi cắt kết nối, không trả lời
import express from 'express';

const PORT = Number(process.env.PORT ?? 4002);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0);
const DROP_RATE = Number(process.env.DROP_RATE ?? 0);
const LIMIT = 20_000_000; // hạn mức mỗi giao dịch
const QUIET = process.env.QUIET === '1'; // tắt log từng kết nối khi chạy script đo

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const chargesByRef = new Map(); // reference -> số lần đã trừ tiền
const idempotency = new Map(); // Idempotency-Key -> { reference, amount, result: Promise<{ status, body }> }
let nextCharge = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Xử lý một lệnh trừ tiền, trả về { status, body } (transient = lỗi tạm thời, chưa trừ tiền).
async function processCharge({ reference, amount }) {
  if (DELAY_MS > 0) await sleep(DELAY_MS);
  if (typeof reference !== 'string' || reference === '') {
    return { status: 400, body: { error: 'reference is required' } };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { status: 400, body: { error: 'amount must be a positive integer' } };
  }
  if (amount > LIMIT) {
    return { status: 402, body: { error: `amount exceeds limit ${LIMIT}` } };
  }
  if (Math.random() < FAIL_RATE) {
    return { status: 500, body: { error: 'temporary bank error', charged: false }, transient: true };
  }
  // Trừ tiền
  const count = (chargesByRef.get(reference) ?? 0) + 1;
  chargesByRef.set(reference, count);
  stats.charges++;
  if (count > 1) stats.duplicates++;
  const chargeId = `CH${nextCharge++}`;
  return { status: 201, body: { chargeId, reference, amount, chargedAt: new Date().toISOString() } };
}

const app = express();
app.use(express.json());

app.post('/charges', async (req, res) => {
  stats.requests++;
  const key = req.get('Idempotency-Key');
  const { reference, amount } = req.body ?? {};
  let resultPromise;

  if (key && idempotency.has(key)) {
    const saved = idempotency.get(key);
    if (saved.reference !== reference || saved.amount !== amount) {
      return res.status(422).json({ error: 'Idempotency-Key was already used with a different request', charged: false });
    }
    // Gửi lại cùng khóa (kể cả khi lần trước còn đang xử lý) → trả lại kết quả cũ, không trừ thêm.
    resultPromise = saved.result;
  } else {
    resultPromise = processCharge({ reference, amount });
    if (key) {
      idempotency.set(key, { reference, amount, result: resultPromise });
      // Lỗi tạm thời (chưa trừ tiền) thì không ghi nhớ, để lần gửi lại được xử lý thật.
      resultPromise.then((r) => r.transient && idempotency.delete(key));
    }
  }

  const result = await resultPromise;
  if (result.status === 201 && Math.random() < DROP_RATE) {
    req.socket.destroy(); // đã trừ tiền nhưng cắt kết nối trước khi trả lời
    return;
  }
  res.status(result.status).json(result.body);
});

app.get('/stats', (_req, res) => res.json(stats));

app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message, charged: false }));

const server = app.listen(PORT, (err) => {
  if (err) {
    console.error(`[bank] cannot listen on :${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[bank] listening on :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});
server.keepAliveTimeout = 5000; // mặc định của Node.js: đóng kết nối nhàn rỗi sau 5 giây
server.on('connection', (socket) => {
  stats.connections++;
  if (!QUIET) console.log(`[bank] new TCP connection #${stats.connections} from ${socket.remoteAddress}:${socket.remotePort}`);
});
