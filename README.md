# LAB 3 — Kết nối và duy trì kết nối giữa các service

Sinh viên: **B23DCCC054** · Node.js ≥ 18 (đã chạy trên Node 22.21.1, Windows 11) · Express 5 · dữ liệu trong bộ nhớ.

Đề bài: [DE_BAI.md](DE_BAI.md) · Kết quả đo: [BAO_CAO.md](BAO_CAO.md)

## Cấu trúc

```
src/
  bank.js          Ngân hàng giả lập :4002 — /charges (Idempotency-Key), /stats, DELAY_MS/FAIL_RATE/DROP_RATE
  fee-service.js   Fee Service :4001 — /students/:id/fees, /students/:id/payments, /payments, /payments/:id/reconcile
  bank-client.js   Hai cách gọi ngân hàng: chargeNaive (TRƯỚC khi sửa) và chargeWithRetry (SAU khi sửa)
scripts/           Script đo 4 tình huống (tự bật/tắt service, chạy cả 2 chế độ, lưu reports/*.json)
reports/           Kết quả đo JSON + reports/logs/*.log (log từng tiến trình, có log kết nối TCP của ngân hàng)
postman/           Postman collection để thử tay
```

## Cài và chạy

```bash
npm install

# chạy tay (2 terminal)
npm run bank                 # ngân hàng :4002
npm run fee                  # Fee Service bản đã sửa :4001
npm run fee:naive            # hoặc bản trước khi sửa
```

Biến môi trường (PowerShell: `$env:DELAY_MS=5000; npm run bank`, Git Bash: `DELAY_MS=5000 npm run bank`):

| Service | Biến | Mặc định | Ý nghĩa |
|---|---|---|---|
| bank | `DELAY_MS` | 0 | Trễ thêm trước khi xử lý |
| bank | `FAIL_RATE` | 0 | Tỉ lệ trả 500 trước khi trừ tiền |
| bank | `DROP_RATE` | 0 | Tỉ lệ trừ tiền xong rồi cắt kết nối |
| fee | `BANK_URL` | `http://localhost:4002` | Địa chỉ ngân hàng |
| fee | `FEE_MODE` | `fixed` | `naive` = bản trước khi sửa (hoặc `--naive`) |
| fee | `CONNECT_TIMEOUT_MS` / `DEADLINE_MS` / `MAX_ATTEMPTS` | 1000 / 4000 / 4 | Timeout kết nối / hạn chót cả lệnh / số lần thử |

## Chạy các phép đo

Cần cổng 4001, 4002 đang trống (tắt các service chạy tay trước).

```bash
npm run s1    # TH1 ngân hàng tắt rồi bật lại           (~30 s, có 1 lần naive treo 21 s)
npm run s2    # TH2 ngân hàng chậm 5 s                   (~25 s)
npm run s3    # TH3 200 lệnh / 10 đồng thời, 3 lần/chế độ (~45 s)
npm run s4    # TH4 DROP 0.3, FAIL 0.3, vượt hạn mức      (~15 s)
npm run all   # cả 4
```

Mỗi script in bảng **ĐẠT / KHÔNG ĐẠT** theo "Kết quả cần đạt" của đề cho cả hai chế độ và ghi `reports/<tên>.json`.
TH4 dùng tỉ lệ ngẫu nhiên nên số lệnh thành công dao động giữa các lần chạy.

## API Fee Service

| Method | Path | Mô tả |
|---|---|---|
| GET | `/students/{id}/fees` | `{ studentId, debt, pendingAmount }` |
| POST | `/students/{id}/payments` | body `{ "amount": 100000 }` → 201 PAID / 4xx FAILED / 503 FAILED / 504 PENDING |
| GET | `/payments`, `/payments/{pid}` | Xem lệnh |
| POST | `/payments/{pid}/reconcile` | Đối soát lệnh PENDING (gửi lại cùng Idempotency-Key) |
| GET | `/health` | Chế độ đang chạy và BANK_URL |

Lỗi luôn là JSON `{ error, paymentId, status }`.
