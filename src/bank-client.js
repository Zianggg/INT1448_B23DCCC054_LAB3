// Hai cách gọi ngân hàng: bản "naive" (trước khi sửa) và bản "fixed" (sau khi sửa).
import http from 'node:http';

export const CONFIG = {
  CONNECT_TIMEOUT_MS: Number(process.env.CONNECT_TIMEOUT_MS ?? 1000), // TH1: báo 503 < 1,5 s
  DEADLINE_MS: Number(process.env.DEADLINE_MS ?? 4000), // TH2/TH4: tổng thời gian ≤ 4,5 s
  MAX_ATTEMPTS: Number(process.env.MAX_ATTEMPTS ?? 4), // TH4: 0,3^4 ≈ 0,8 % lệnh còn hỏng
  BACKOFF_MS: Number(process.env.BACKOFF_MS ?? 100),
};

// Bản sửa dùng chung một agent giữ kết nối (TH3).
// timeout 4 s < keepAliveTimeout 5 s của ngân hàng: client tự bỏ socket nhàn rỗi trước khi
// ngân hàng đóng, tránh gửi vào một socket vừa bị đóng.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 20, timeout: 4000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Gửi một yêu cầu POST /charges. Không bao giờ reject; trả về
 *   { kind: 'response', status, body }
 *   { kind: 'error', sent, timeout, reason }
 * sent = true nghĩa là đã có kết nối tới ngân hàng nên yêu cầu CÓ THỂ đã được xử lý.
 */
function postCharge(bankUrl, payload, { agent, idempotencyKey, timeoutMs, connectTimeoutMs }) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let sent = false;
    let gotSocket = false; // false = vẫn đang xếp hàng chờ socket trong agent, chưa gửi gì
    let settled = false;
    let timer;
    let connectTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      resolve(result);
    };

    let req;
    try {
      req = http.request(new URL('/charges', bankUrl), { method: 'POST', agent, headers }, onResponse);
    } catch (err) {
      // BANK_URL sai định dạng… → chưa gửi được gì
      return finish({ kind: 'error', sent: false, timeout: false, reason: err.code ?? err.message });
    }
    function onResponse(res) {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        let body;
        try { body = JSON.parse(buf); } catch { body = { raw: buf }; }
        finish({ kind: 'response', status: res.statusCode, body });
      });
      res.on('error', (err) => finish({ kind: 'error', sent: true, timeout: false, reason: err.code ?? err.message }));
    }

    req.on('socket', () => (gotSocket = true));
    if (connectTimeoutMs) {
      req.on('socket', (socket) => {
        if (!socket.connecting) { sent = true; return; } // socket tái sử dụng từ pool
        connectTimer = setTimeout(() => req.destroy(codedError('ECONNECT_TIMEOUT', 'connect timeout')), connectTimeoutMs);
        socket.once('connect', () => { clearTimeout(connectTimer); sent = true; });
      });
    } else {
      req.on('socket', (socket) => {
        if (!socket.connecting) sent = true;
        else socket.once('connect', () => (sent = true));
      });
    }
    if (timeoutMs) {
      timer = setTimeout(() => req.destroy(gotSocket
        ? codedError('EDEADLINE', `no response within ${timeoutMs} ms`)
        : codedError('EQUEUED', `no free connection within ${timeoutMs} ms`)), timeoutMs);
    }
    req.on('error', (err) =>
      finish({ kind: 'error', sent, timeout: err.code === 'EDEADLINE' || err.code === 'EQUEUED', reason: err.code ?? err.message }),
    );
    req.end(data);
  });
}

/**
 * Bản TRƯỚC khi sửa — cách viết "đầu tiên" hay gặp:
 * mỗi lần gọi mở kết nối mới (agent: false, như mặc định Node 18), không timeout,
 * không thử lại, không Idempotency-Key, mọi lỗi đều coi là FAILED 500.
 */
export async function chargeNaive(bankUrl, payment) {
  const r = await postCharge(bankUrl, { reference: payment.reference, amount: payment.amount }, { agent: false });
  payment.attempts = 1;
  if (r.kind === 'response' && r.status === 201) return { status: 'PAID', http: 201, chargeId: r.body.chargeId };
  if (r.kind === 'response') return { status: 'FAILED', http: r.status, error: r.body.error ?? 'bank error' };
  return { status: 'FAILED', http: 500, error: `Payment failed: ${r.reason}` };
}

/**
 * Bản SAU khi sửa:
 * - timeout kết nối 1 s + hạn chót 4 s cho cả lệnh (gồm mọi lần thử);
 * - giữ kết nối qua keepAliveAgent;
 * - Idempotency-Key = reference của lệnh (mã phiên chạy + P1, P2…) nên gửi lại bao nhiêu lần cũng chỉ trừ tiền một lần;
 * - chỉ thử lại lỗi tạm thời (5xx, đứt kết nối sau khi đã gửi), không thử lại 4xx,
 *   không thử lại khi không kết nối được (báo 503 ngay) hay khi đã hết giờ.
 */
export async function chargeWithRetry(bankUrl, payment, deadlineMs = CONFIG.DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  let uncertain = false; // đã có lần thử mà ngân hàng có thể đã trừ tiền
  let last;

  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    payment.attempts = (payment.attempts ?? 0) + 1;

    const r = await postCharge(bankUrl, { reference: payment.reference, amount: payment.amount }, {
      agent: keepAliveAgent,
      idempotencyKey: payment.reference,
      timeoutMs: remaining,
      connectTimeoutMs: Math.min(CONFIG.CONNECT_TIMEOUT_MS, remaining),
    });
    last = r;

    if (r.kind === 'response') {
      if (r.status === 201) {
        if (r.body.reference === payment.reference && r.body.amount === payment.amount) {
          return { status: 'PAID', http: 201, chargeId: r.body.chargeId };
        }
        // 201 nhưng là giao dịch của lệnh khác → không coi là đã trả, cũng không chắc là chưa trừ
        uncertain = true;
        break;
      }
      if (r.status < 500) return { status: 'FAILED', http: r.status, error: r.body.error ?? 'rejected by bank' };
      // 5xx: thử lại được (cùng khóa). Chỉ coi là "chắc chắn chưa trừ" khi ngân hàng nói rõ charged: false;
      // 502/504 của proxy hay 500 không rõ thì có thể đã trừ.
      if (r.body.charged !== false) uncertain = true;
    } else {
      if (r.sent) uncertain = true;
      if (r.timeout || !r.sent) break; // hết giờ, hoặc không kết nối được → dừng
    }

    const backoff = CONFIG.BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
    if (Date.now() + backoff >= deadline) break;
    await sleep(backoff);
  }

  if (uncertain) {
    return { status: 'PENDING', http: 504, error: `bank did not confirm the charge (${last.reason ?? 'timeout'})` };
  }
  if (last?.kind === 'response') {
    return { status: 'FAILED', http: 503, error: `bank temporarily unavailable (HTTP ${last.status}), not charged` };
  }
  if (last?.reason === 'EQUEUED') {
    return { status: 'FAILED', http: 503, error: 'too many payments in progress, request was not sent to bank' };
  }
  return { status: 'FAILED', http: 503, error: `cannot connect to bank (${last?.reason ?? 'deadline'}), not charged` };
}
