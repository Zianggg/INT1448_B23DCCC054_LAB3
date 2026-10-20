# BÁO CÁO LAB 3 — Kết nối và duy trì kết nối giữa các service

**Sinh viên:** B23DCCC054 · **Môn:** INT1448 · **Môi trường đo:** Windows 11, Node.js 22.21.1, Express 5, cả hai service chạy trên cùng máy (localhost).

## 1. Hệ thống đã dựng

```
Sinh viên ──HTTP──▶ Fee Service :4001 ──HTTP (keep-alive, Idempotency-Key)──▶ Ngân hàng giả lập :4002
                     công nợ trong bộ nhớ                                      /charges, /stats
```

**Ngân hàng** ([src/bank.js](src/bank.js))
- `POST /charges` → 201 kèm `chargeId`, 400 nếu số tiền không hợp lệ, 402 nếu > 20.000.000đ.
- Lưu `Idempotency-Key → { reference, amount, Promise kết quả }`. Vì vậy hai yêu cầu cùng khóa đến **cùng lúc** cũng chỉ trừ tiền một lần.
- Cùng khóa mà khác `reference`/`amount` → 422.
- Lỗi 500 tạm thời trả `charged: false` và không được ghi nhớ, để lần gửi lại được xử lý thật.
- `GET /stats` đếm `connections` (sự kiện `connection` của server), `requests` (số `POST /charges`), `charges`, `duplicates`.
- `keepAliveTimeout = 5000`, in log `new TCP connection #n` cho mỗi kết nối mới.

**Fee Service** ([src/fee-service.js](src/fee-service.js))
- Công nợ ban đầu: SV1 50.000.000đ, SV2 0, SV3 3.200.000đ.
- Lệnh đánh số P1, P2…; `reference` gửi ngân hàng là `<mã phiên chạy>-P1`. Mã lệnh đếm lại từ 1 mỗi khi khởi động, nên nếu dùng thẳng P1 làm khóa thì P1 mới sẽ nhận nhầm giao dịch của P1 cũ.
- Công nợ **chỉ giảm khi PAID**. Tiền của các lệnh đang gửi / PENDING được giữ chỗ khi kiểm tra "không vượt công nợ".
- Mọi lỗi, kể cả body JSON hỏng, đều trả JSON `{ error, paymentId, status }`.

**Hai bản để so sánh trước/sau** ([src/bank-client.js](src/bank-client.js)), chọn bằng `FEE_MODE`:

| | `naive` — TRƯỚC khi sửa | `fixed` — SAU khi sửa |
|---|---|---|
| Kết nối | `agent: false`: mỗi lời gọi một kết nối TCP mới (giống mặc định Node 18) | Một `http.Agent({ keepAlive: true, maxSockets: 20, timeout: 4000 })` dùng chung |
| Timeout | Không có | Kết nối 1 s; hạn chót **4 s cho cả lệnh**, tính cả các lần thử lại |
| Thử lại | Không | Tối đa 4 lần, backoff 100·2ⁿ ms có jitter, chỉ khi còn trong hạn chót |
| Chống trừ trùng | Không gửi Idempotency-Key | `Idempotency-Key = reference`; kiểm tra 201 trả về đúng `reference` và `amount` của lệnh |
| Phân loại lỗi | Mọi lỗi mạng → 500 FAILED | Theo bảng quy ước của đề (mục 2) |

## 2. Cách phân loại kết quả (bản sửa)

Điểm mấu chốt là biết **yêu cầu đã tới ngân hàng hay chưa**. Biến `sent` chỉ bật khi socket đã kết nối xong (hoặc là socket tái sử dụng từ pool).

| Điều xảy ra | Đã trừ tiền? | Thử lại? | Kết quả trả về |
|---|---|---|---|
| 201, đúng reference và amount | Có | — | **201 PAID**, giảm công nợ |
| 400 / 402 / 422 | Không, bị từ chối rõ ràng | **Không** | Giữ mã ngân hàng, **FAILED** |
| 5xx kèm `charged: false` | Chắc chắn chưa | Có | Hết lượt mà chỉ gặp loại này → **503 FAILED** |
| 5xx khác (502/504 của proxy…) | Không biết | Có, cùng khóa | Hết lượt → **504 PENDING** |
| ECONNREFUSED, hoặc quá 1 s chưa kết nối được | Chắc chắn chưa | Không, báo lỗi ngay | **503 FAILED** |
| Hết 4 s mà vẫn xếp hàng chờ socket (> 20 lệnh đồng thời) | Chắc chắn chưa (chưa gửi) | Không | **503 FAILED** "too many payments in progress" |
| Đứt kết nối sau khi đã gửi (ECONNRESET, socket hang up) | Không biết | Có, cùng khóa | Hết lượt → **504 PENDING** |
| Hết hạn chót 4 s khi đang chờ trả lời | Không biết | Không (hết giờ) | **504 PENDING** |

Đã có **một** lần thử "không biết" thì kết quả cuối không bao giờ là FAILED, kể cả khi các lần sau bị ECONNREFUSED, vì có thể ngân hàng đã trừ tiền rồi.

Lệnh PENDING được xử lý tiếp bằng `POST /payments/{id}/reconcile`, gửi lại với cùng khóa:
- ngân hàng đã trừ → trả lại giao dịch cũ;
- chưa trừ → giờ mới trừ.

Đằng nào lệnh cũng chỉ bị trừ đúng một lần.

## 3. Cách đo

| Mục | Cách làm |
|---|---|
| Công cụ | Script Node trong [scripts/](scripts/). Mỗi tình huống tự bật/tắt tiến trình mới cho từng chế độ, gọi bằng `fetch`, đo bằng `performance.now()`. Lệnh: `npm run all` |
| Thời gian | Tính từ lúc gửi tới khi nhận xong phản hồi của Fee Service, đo ở phía client |
| Số kết nối | `connections` ở `GET /stats` của ngân hàng. Lời gọi `/stats` của script cũng mở 1 kết nối, nên mỗi số **đã gồm +1** |
| Lặp | TH1: 3 lời gọi, lấy trung vị. TH3: 3 lần chạy độc lập mỗi chế độ, lấy trung vị. TH2, TH4: 1 lần chạy (TH4 có 60 lệnh mỗi kiểu) |
| Dữ liệu gốc | `reports/s1-bank-down.json`, `s2-slow-bank.json`, `s3-keep-alive.json`, `s4-drop-fail-reject.json`; log từng tiến trình ở `reports/logs/` (log ngân hàng có từng dòng `new TCP connection`) |

## 4. Tình huống 1 — Ngân hàng không kết nối được, rồi hoạt động lại

| Chỉ số | Trước (naive) | Sau (fixed) | Yêu cầu |
|---|---|---|---|
| Mã trả về khi ngân hàng tắt | 500 ×3 | **503** ×3 | 503 |
| Thân phản hồi | `{"error":"Payment failed: ECONNREFUSED","status":"FAILED",…}` | `{"error":"cannot connect to bank (ECONNREFUSED), not charged","paymentId":"P1","status":"FAILED"}` | JSON có error |
| Thời gian (3 lần; trung vị) | 293 / 23 / 16 ms (23 ms) | 37 / 5 / 3 ms (**5 ms**) | < 1,5 s |
| GET /students/1/fees khi ngân hàng tắt (trung vị) | 200, 7 ms | 200, **1 ms** | 200 nhanh |
| Fee Service còn sống | Có | **Có** | Không sập |
| Bật ngân hàng, gọi lại (cùng tiến trình Fee) | 201 (66 ms) | **201** (20 ms) | 201 |
| `BANK_URL=http://localhost:4999` | 500 ×3, ≤ 123 ms | **503** ×3, ≤ 33 ms | Giống như trên |
| *(thêm)* `BANK_URL=http://10.255.255.1:4002` (IP không phản hồi SYN) | 500 sau **21.111 ms** | **503 sau 1.029 ms** | < 1,5 s |

**Nhận xét.**
- Trên localhost, cổng đóng trả RST ngay nên ECONNREFUSED đến sau vài ms. Bản naive vì vậy cũng nhanh và không sập; nó chỉ sai mã (500 thay vì 503) và không nói được là đã trừ tiền hay chưa.
- Mỗi lời gọi đều mở kết nối mới, nên khi ngân hàng chạy lại thì cả hai bản đều tự phục hồi mà không cần khởi động lại.
- Khác biệt thật nằm ở dòng cuối. Khi máy ngân hàng **không trả lời SYN** (đang khởi động lại, tường lửa chặn), Windows chờ khoảng 21 s mới báo ETIMEDOUT, và bản naive giữ yêu cầu của sinh viên suốt khoảng đó. Bản sửa cắt sau 1 s và trả 503, vì kết nối chưa thành lập thì chắc chắn chưa trừ tiền.

## 5. Tình huống 2 — Ngân hàng chậm (DELAY_MS=5000)

| Chỉ số | Trước (naive) | Sau (fixed) | Yêu cầu |
|---|---|---|---|
| 1 thanh toán: mã / status | 201 PAID | **504 PENDING** | 504 PENDING |
| 1 thanh toán: thời gian | 5.098 ms | **4.043 ms** | ≤ 4,5 s |
| 20 thanh toán cùng lúc | 20 × 201, trung vị 5.044 ms, max 5.047 ms | 20 × **504 PENDING**, trung vị 4.030 ms, max **4.032 ms** | ≤ 4,5 s |
| GET /students/1/fees lúc 0,2 / 1 / 2 / 3 s | 3 / 2 / 2 / 3 ms | 2 / 2 / 2 / 2 ms | < 300 ms |
| *(thêm)* Đối soát 21 lệnh PENDING sau 1,5 s | — | 21 → **PAID**, max 31 ms; `charges = 21`, `duplicates = 0`; công nợ 47.900.000đ = 50.000.000 − 21 × 100.000 | |

**Nhận xét.**
- Node xử lý I/O bất đồng bộ, nên 20 lệnh đang chờ không chặn `GET /fees` ở cả hai bản. Vấn đề là thời gian sinh viên phải chờ.
- Bản sửa đặt hạn chót 4 s cho cả lệnh, nên lệnh trả về ở khoảng 4,03 s. Con số này dưới mức 4,5 s và còn chừa 0,5 s cho mạng.
- Hết giờ thì lệnh là PENDING chứ không phải FAILED, vì ngân hàng vẫn đang xử lý và thật sự trừ tiền ở giây thứ 5.
- Lần đối soát sau đó xác nhận điều này: cả 21 lệnh đều đã bị trừ, gửi lại cùng khóa không trừ thêm, và công nợ khớp với ngân hàng. Nếu trả FAILED ở đây, sinh viên sẽ thanh toán lại và bị trừ tiền hai lần.
- `connections = 42` ở bước này vì mỗi yêu cầu hết giờ bị hủy kèm socket, nên lần đối soát phải mở kết nối mới.

## 6. Tình huống 3 — Duy trì kết nối (200 lệnh × 1.000đ, 10 đồng thời)

| Chỉ số (trung vị 3 lần) | Trước (naive) | Sau (fixed) | Yêu cầu |
|---|---|---|---|
| Thành công | 200/200 (cả 3 lần) | **200/200** (cả 3 lần) | 200/200 |
| `connections` sau 200 lệnh | 201 (= 200 + 1 lời gọi /stats) | **11** (= 10 + 1) | ≤ 20 |
| Tổng thời gian 200 lệnh | 301 ms (386 / 301 / 298) | **200 ms** (196 / 217 / 200) | — |
| Nhàn rỗi 6 s rồi gửi 5 lệnh | 5/5 | **5/5** | Vẫn thành công |
| `connections` cuối cùng | 207 | 13 | — |

**Nhận xét.**
- Bản naive bắt tay TCP mới cho mỗi lệnh, nên ngân hàng phải nhận 200 kết nối (log `s3-naive-run1-bank.log` có 207 dòng `new TCP connection`).
- Bản sửa chỉ mở 10 kết nối, bằng số yêu cầu đồng thời, rồi dùng lại cho cả 200 lệnh. Tổng thời gian giảm khoảng một phần ba (301 → 200 ms) dù chỉ chạy trên localhost. Qua mạng thật, mỗi lần bắt tay tốn thêm 1 RTT (cộng thêm TLS nếu có), nên chênh lệch sẽ lớn hơn nhiều.
- Lần gửi sau 6 s nhàn rỗi vẫn thành công vì agent đặt `timeout: 4000`, nhỏ hơn `keepAliveTimeout` 5 s của ngân hàng. Client tự bỏ socket nhàn rỗi trước khi ngân hàng đóng, nên không gửi vào socket đã chết. Nếu vẫn gặp ECONNRESET trên socket tái sử dụng, cơ chế thử lại có Idempotency-Key ở TH4 sẽ xử lý.
- 13 = 11 + 1 kết nối mới cho 5 lệnh sau khi nhàn rỗi + 1 lời gọi /stats.

> Ghi chú: từ Node 19, `http.globalAgent` đã bật keep-alive mặc định. Bản naive dùng `agent: false` để tái hiện hành vi của Node 18, phiên bản tối thiểu đề yêu cầu.

## 7. Tình huống 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối (60 lệnh × 100.000đ, lần lượt)

### (a) DROP_RATE=0.3 — ngân hàng đã trừ tiền rồi cắt kết nối

| Chỉ số | Trước (naive) | Sau (fixed) | Yêu cầu |
|---|---|---|---|
| PAID | 39/60 | **60/60** | ≥ 54/60 |
| Lệnh không thành công | 21 × **500 FAILED** | 0 | 504 + PENDING |
| Ngân hàng: requests / charges / duplicates | 60 / 60 / 0 | 78 / 60 / **0** | duplicates = 0 |
| Công nợ giảm / tiền của lệnh PAID | 3.900.000 / 3.900.000 | **6.000.000 / 6.000.000** | Bằng nhau |
| Tiền đã bị trừ mà Fee Service ghi FAILED | **21 lệnh = 2.100.000đ** | 0 | — |
| Thời gian lâu nhất | 41 ms | 269 ms | ≤ 4,5 s |
| `connections` | 61 | 20 (1 kết nối đầu + 18 kết nối mở lại sau 18 lần bị cắt + 1 /stats) | — |

Ở lần chạy này không có lệnh nào bị cắt cả 4 lần (xác suất mỗi lệnh 0,3⁴ ≈ 0,8 %), nên chưa thấy nhánh PENDING. Phép thử **DROP_RATE=1** dưới đây buộc mọi lần thử đều bị cắt sau khi trừ tiền:

| 1 lệnh, DROP_RATE=1 | Trước (naive) | Sau (fixed) |
|---|---|---|
| Kết quả | 500 FAILED, 1 lần thử | **504 PENDING**, 4 lần thử, 1.769 ms |
| Ngân hàng: requests / charges / duplicates | 1 / 1 / 0 | 4 / **1** / 0 |
| Công nợ giảm / tiền giữ chỗ | 0 / 0 (tiền đã bị trừ nhưng không ai biết) | 0 / 100.000 (chờ đối soát) |

### (b) FAIL_RATE=0.3 — lỗi 500 trước khi trừ tiền

| Chỉ số | Trước (naive) | Sau (fixed) | Yêu cầu |
|---|---|---|---|
| PAID | 41/60 | **60/60** | ≥ 54/60 |
| Ngân hàng: requests / charges / duplicates | 60 / 41 / 0 | 78 / 60 / **0** | Không trừ hai lần |
| Thời gian lâu nhất | 43 ms | 326 ms | ≤ 4,5 s |
| `connections` | 61 | 2 (1 kết nối dùng cho cả 60 lệnh + 1 /stats) | — |

### (c) Thanh toán 25.000.000đ (vượt hạn mức 20.000.000đ)

| Chỉ số | Trước (naive) | Sau (fixed) | Yêu cầu |
|---|---|---|---|
| Mã / status | 402 FAILED | **402 FAILED** | 402 |
| Ngân hàng `requests` | 1 | **1** | Đúng 1 |
| Thời gian | 44 ms | 50 ms | — |

**Nhận xét.**
- **(a) là lỗi nguy hiểm nhất của bản naive.** Duplicates vẫn bằng 0 và công nợ "đúng" theo sổ của Fee Service, nhưng ngân hàng đã trừ 2.100.000đ của 21 lệnh bị báo FAILED. Sinh viên thấy "thất bại" sẽ bấm thanh toán lại và mất tiền hai lần.
- Bản sửa thử lại với cùng `Idempotency-Key`: ngân hàng nhận 78 yêu cầu cho 60 lệnh nhưng chỉ trừ 60 lần, và cả 60 lệnh đều được xác nhận PAID.
- Khi lần nào cũng bị cắt (DROP_RATE=1), bản sửa trả 504 PENDING đúng quy ước. Công nợ không giảm và tiền được giữ chỗ chờ đối soát.
- Ở một lần chạy trước khi hoàn thiện (log không lưu lại), bản sửa ra 58/60 PAID và 2 × 504 PENDING; đối soát chuyển cả 2 sang PAID với `charges = 60`, `duplicates = 0`.
- **(b)** Lỗi 500 có `charged: false` nên thử lại là an toàn. Cả 60 lệnh chỉ dùng 1 kết nối. Kiểu (a) thì mỗi lần cắt làm mất một socket.
- **(c)** 402 là từ chối nghiệp vụ, thử lại vẫn bị từ chối, nên bản sửa không thử lại. Ngân hàng nhận đúng 1 yêu cầu.
- Hạn chót 4 s áp dụng cho mọi lần thử, nên TH4 vẫn giữ giới hạn ≤ 4,5 s của TH2. Lệnh lâu nhất là 1.769 ms (DROP_RATE=1, 4 lần thử).

## 8. Tổng hợp tiêu chí

| Tình huống | Tiêu chí | Trước | Sau |
|---|---|---|---|
| TH1 | 503 + JSON, < 1,5 s | ✗ (500) | ✓ |
| TH1 | Không sập, GET fees 200 nhanh | ✓ | ✓ |
| TH1 | Ngân hàng chạy lại → 201, không khởi động lại | ✓ | ✓ |
| TH1 | BANK_URL :4999 hành vi giống | ✗ (500) | ✓ |
| TH2 | 504 PENDING | ✗ (201 sau 5,1 s) | ✓ |
| TH2 | ≤ 4,5 s | ✗ | ✓ (4,04 s) |
| TH2 | GET fees < 300 ms khi 20 lệnh chờ | ✓ | ✓ |
| TH3 | 200/200 | ✓ | ✓ |
| TH3 | ≤ 20 kết nối | ✗ (201) | ✓ (11) |
| TH3 | Sau nhàn rỗi 6 s vẫn thành công | ✓ | ✓ |
| TH4a | duplicates = 0, ≥ 54/60, lỗi = 504 PENDING, công nợ đúng | ✗ (39/60, 500) | ✓ (60/60; PENDING qua DROP_RATE=1) |
| TH4b | ≥ 54/60, không trừ hai lần | ✗ (41/60) | ✓ (60/60) |
| TH4c | 402, đúng 1 yêu cầu | ✓ | ✓ |
| TH4 | ≤ 4,5 s | ✓ | ✓ |

TH4 dùng tỉ lệ ngẫu nhiên, nên chạy lại `npm run s4` sẽ ra số khác đôi chút.

## 9. Hạn chế và hướng mở rộng

- **Dữ liệu nằm trong bộ nhớ.** Fee Service khởi động lại thì mất lệnh PENDING. Khóa đã gắn mã phiên chạy nên không nhận nhầm giao dịch cũ, nhưng lệnh cũ cũng không còn để đối soát. Thực tế cần lưu lệnh vào DB **trước** khi gọi ngân hàng (outbox), và chạy job đối soát định kỳ thay vì gọi `/reconcile` bằng tay.
- **Chưa có circuit breaker.** Khi ngân hàng tắt lâu, mỗi lệnh vẫn thử kết nối một lần: vài ms trên localhost, nhưng 1 s với IP không phản hồi. Có thể mở mạch sau N lỗi liên tiếp để trả 503 ngay.
- **Giới hạn 20 socket.** Nếu hơn 20 lệnh cùng chờ một ngân hàng chậm, các lệnh dư phải xếp hàng hết 4 s rồi mới nhận 503 (chưa gửi nên chắc chắn chưa trừ). Nên trả 503 ngay khi hàng đợi đầy.
- **Hạn chót 4 s là cố định.** Nên đặt theo p99 thực tế, và hỗ trợ trả 202 để client hỏi lại trạng thái sau.

## 10. Checklist trình bày (tự chụp)

- [ ] Terminal ngân hàng có log `[bank] new TCP connection #…`: với `npm run fee:naive` thì tăng theo từng lệnh, với `npm run fee` thì dừng ở số yêu cầu đồng thời.
- [ ] Postman ([postman/LAB3.postman_collection.json](postman/LAB3.postman_collection.json)): 503 khi tắt ngân hàng, 504 PENDING khi `DELAY_MS=5000`, 402 với 25.000.000đ.
- [ ] Bảng ĐẠT/KHÔNG ĐẠT in ra từ `npm run all`.
