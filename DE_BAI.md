_LAB 3 · THỰC HÀNH TỰ KHÁM PHÁ · SAU BUỔI 7–8_

# Kết nối và duy trì kết nối giữa các service

Một hệ thống thanh toán học phí gọi sang cổng ngân hàng. Các bạn tự dựng hệ thống, rồi xử lý bốn tình huống sự cố với kết quả cần đạt rõ ràng.

**Thời lượng:** 2 tiếng **Giảng viên:** ThS Nguyễn Việt Dũng **Chuẩn bị:** Node.js từ v18, Postman

## 1. Đề bài: thanh toán học phí trực tuyến

Sinh viên bấm thanh toán học phí; **Fee Service** (hệ thống của trường) gọi **cổng ngân hàng** (bên thứ ba) để trừ tiền. Các bạn **tự dựng hai service**, rồi xử lý bốn tình huống sự cố ở các mục sau. Mỗi tình huống có *kết quả cần đạt*; cách làm tự tìm hiểu.

### Nhiệm vụ (Node.js/Express, dữ liệu trong bộ nhớ)

- **Fee Service — cổng 4001:** GET /students/{id}/fees (sinh viên 1 nợ 50.000.000đ; 2 nợ 0; 3 nợ 3.200.000đ) và POST /students/{id}/payments {"amount": 100000} — kiểm tra số tiền không vượt công nợ, tạo lệnh P1, P2…, gọi ngân hàng, giảm công nợ khi thành công.

- **Ngân hàng giả lập — cổng 4002:** POST /charges {"reference","amount"} → 201 kèm chargeId; 400 nếu số tiền không hợp lệ; 402 nếu vượt hạn mức 20.000.000đ. Header Idempotency-Key: gửi lại *cùng một khóa* thì trả lại giao dịch cũ, **không trừ thêm**.

- Ngân hàng có GET /stats → {connections, requests, charges, duplicates}: connections là số kết nối TCP mới nhận; duplicates là số lần trừ tiền **trùng** cho cùng một reference (phải luôn = 0).

- Hành vi lỗi của ngân hàng đặt bằng biến môi trường (khởi động lại để áp dụng): DELAY_MS — trễ thêm ngần ấy ms; FAIL_RATE (0–1) — tỉ lệ trả lỗi 500 *trước khi* trừ tiền; DROP_RATE (0–1) — tỉ lệ **trừ tiền xong rồi cắt kết nối** trước khi trả lời. Ngân hàng giữ kết nối nhàn rỗi tối đa 5 giây (mặc định của Node.js) và in log mỗi khi có kết nối TCP mới.

### Quy tắc nghiệp vụ

- Công nợ **chỉ giảm khi ngân hàng đã trừ tiền**.

- **Không bao giờ trừ tiền hai lần** cho một lệnh thanh toán.

- Ngân hàng có sự cố thì xem công nợ vẫn phải chạy.

### Quy ước kết quả thanh toán

| **Tình trạng**                      | **HTTP**                         | **status** | **Khi nào**                                              |
|-------------------------------------|----------------------------------|------------|----------------------------------------------------------|
| Thành công                          | 201                              | PAID       | Ngân hàng xác nhận đã trừ tiền                           |
| Ngân hàng từ chối rõ ràng           | Giữ mã của ngân hàng (ví dụ 402) | FAILED     | Ví dụ vượt hạn mức                                       |
| **Chắc chắn chưa trừ tiền**         | 503                              | FAILED     | Không kết nối được tới ngân hàng                         |
| **Không biết** đã trừ tiền hay chưa | 504                              | PENDING    | Hết thời gian chờ, hoặc đứt kết nối khi đang chờ trả lời |

Thân phản hồi lỗi là JSON có error, paymentId và status.

**Ghi lại số liệu trước và sau khi sửa** ở mỗi tình huống (thời gian, số kết nối, số lần thành công…) — cuối buổi mỗi nhóm trình bày ngắn.

## 2. Tình huống 1 — Ngân hàng không kết nối được, rồi hoạt động lại

**Bối cảnh.** Sáng thứ Hai đội hạ tầng khởi động lại cụm máy chủ: Fee Service lên trước, ngân hàng lên sau vài phút. Sinh viên vẫn bấm thanh toán trong lúc đó.

**Tái hiện và đo.** Không chạy ngân hàng, gọi POST /students/1/payments: xem mã trả về, nội dung, thời gian, Fee Service còn sống không. Sau đó chạy ngân hàng lên rồi gọi lại — **không khởi động lại Fee Service**.

### Kết quả cần đạt

- Khi ngân hàng tắt: thanh toán trả **503**, JSON có error, trong **< 1,5 giây**.

- Fee Service **không sập**; GET /students/1/fees vẫn trả 200 nhanh.

- Khi ngân hàng chạy lại: thanh toán trả **201** mà không cần khởi động lại Fee Service.

- Địa chỉ ngân hàng lấy từ biến môi trường BANK_URL (mặc định http://localhost:4002); đổi sang http://localhost:4999 thì hành vi vẫn giống.

## 3. Tình huống 2 — Ngân hàng phản hồi rất chậm

**Bối cảnh.** Giờ cao điểm đóng học phí, ngân hàng quá tải, mỗi giao dịch 5 giây mới trả lời.

**Tái hiện và đo.** Chạy ngân hàng với DELAY_MS=5000. Gọi thanh toán và đo thời gian. Rồi bắn cùng lúc 20 thanh toán và trong lúc đó gọi GET /students/1/fees.

### Kết quả cần đạt

- Thanh toán trả **504** với status: "PENDING" thay vì chờ ngân hàng.

- Tổng thời gian trả lời **≤ 4,5 giây**.

- Khi 20 thanh toán đang chờ, GET /students/1/fees vẫn phản hồi **< 300ms**.

## 4. Tình huống 3 — Duy trì kết nối

**Bối cảnh.** Nghìn sinh viên thanh toán trong vài phút. Nếu mỗi lời gọi mở một kết nối TCP mới rồi đóng thì tốn thời gian bắt tay và tài nguyên của cả hai phía. Ngân hàng lại đóng kết nối nhàn rỗi sau 5 giây.

**Tái hiện và đo.** Ngân hàng chạy bình thường. Viết script ngắn gửi **200 thanh toán, 10 yêu cầu cùng lúc** (1.000đ mỗi lần). Đo tổng thời gian và connections ở /stats — *trước* và *sau* khi sửa.

### Kết quả cần đạt

- 200/200 thanh toán thành công.

- Số kết nối TCP ngân hàng phải mở **≤ 20**.

- Sau khi **nhàn rỗi 6 giây** (ngân hàng đã đóng kết nối cũ), vài yêu cầu tiếp theo vẫn thành công.

## 5. Tình huống 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối

**Bối cảnh.** Đường truyền chập chờn, và có ba kiểu hỏng khác hẳn nhau: **(a)** ngân hàng **đã trừ tiền** rồi đứt kết nối trước khi trả lời; **(b)** ngân hàng trả lỗi 500 tạm thời **trước khi** trừ tiền; **(c)** ngân hàng từ chối vì vượt hạn mức.

**Tái hiện và đo.** (a) chạy ngân hàng với DROP_RATE=0.3; (b) với FAIL_RATE=0.3; mỗi kiểu gửi 60 thanh toán lần lượt, rồi so số lệnh PAID với charges và duplicates ở /stats. (c) thanh toán 25.000.000đ.

### Kết quả cần đạt

- **(a)** duplicates = 0; ≥ 54/60 thanh toán thành công; thanh toán không thành công trả **504 +** PENDING; công nợ chỉ giảm đúng tiền của các lệnh PAID.

- **(b)** ≥ 54/60 thanh toán thành công; không trừ tiền hai lần.

- **(c)** trả **402**, và ngân hàng chỉ nhận **đúng 1 yêu cầu** (không thử lại lỗi bị từ chối).

- Vẫn giữ giới hạn ≤ 4,5 giây của tình huống 2.
