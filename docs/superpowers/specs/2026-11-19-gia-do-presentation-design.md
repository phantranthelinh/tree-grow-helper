# Design: Slide thuyết trình "Nuôi một bộ não biết nghề ươm giá"

**Ngày:** 2026-11-19
**Trạng thái:** Đã duyệt (2026-11-19)

## 1. Mục đích và lý do

Linh cần một bộ slide để trình bày cho **đồng nghiệp trong công ty** (khoảng **30 phút**, nói tiếng Việt).
Mục đích là giải thích AI chạy local cộng RAG thì "thông minh" đến đâu, và **các kỹ thuật đã dùng: mỗi kỹ thuật
là gì**. Ví dụ xuyên suốt là **cây giá đỗ**. Người nghe không cần đọc code; họ cần hiểu cơ chế qua hình ảnh và
animation.

Deck hiện có ([docs/presentation/deck.html](../../presentation/deck.html), 16 slide, tháng 9/2026) viết cho dev:
nhiều code, ví dụ dâu tây, một số chỗ đã cũ so với code hiện tại (nói `reasoning` đứng đầu, nói chưa có BM25,
nói `data/docs` trống). Deck mới **không thay** deck đó; nó là một bài khác cho người nghe khác.

## 2. Mục tiêu, không thuộc mục tiêu, phản mục tiêu

**Mục tiêu**
- Người nghe ra về hiểu được: LLM local là gì, vì sao model nhỏ "nói giỏi nhưng nhớ kém", RAG lấp chỗ đó bằng
  cách nào (cắt sách → toạ độ ý nghĩa → tìm → chọn → đưa vào đề bài), và các "lan can" giữ model nhỏ đi đúng.
- Mỗi kỹ thuật có **một slide riêng với một animation giải thích đúng cơ chế đó**, chạy trên câu hỏi giá đỗ thật.
- Có **demo trực tiếp** so sánh "bộ não trần" với "bộ não đầy đủ" trên cùng câu hỏi.
- Câu "train bộ não" được dùng làm móc mở đầu rồi **lật lại**: dự án không train trọng số; nó cho model đọc sách
  (RAG), đưa hồ sơ cây và vài ví dụ mẫu.

**Không thuộc mục tiêu**
- Không sửa code server, không thêm endpoint.
- Không xuất PowerPoint/PDF, không làm bản tiếng Anh.
- Không thay hay xoá `deck.html` cũ.

**Phản mục tiêu** (xảy ra là thất bại dù slide vẫn chạy)
- Bịa câu trả lời, số đo hay câu trích không có trong repo hoặc không đo được.
- Ngụ ý dự án đã fine-tune / train trọng số.
- Slide dày chữ hoặc code dài. Tối đa một đoạn code rất ngắn nếu thật cần; mặc định không có code.
- Animation trang trí không giải thích cơ chế nào.
- Demo treo giữa buổi nói mà không có lối thoát.

## 3. Ràng buộc

- Toàn bộ chữ trên slide và speaker notes là **tiếng Việt**.
- Mọi con số và câu trả lời mẫu lấy từ repo (mục 7) hoặc đo lại; ghi rõ nguồn trong speaker notes.
- Một file HTML tự chứa, không bước build: CSS, JS, SVG viết inline. Font Google Fonts được phép nhưng phải có
  font dự phòng hỗ trợ tiếng Việt (Segoe UI / system-ui), vì phòng họp có thể không có mạng.
- Trình chiếu bằng cách mở file trên máy Linh (`file://`). Bản publish online là để gửi lại sau buổi nói.
- Hiển thị tốt ở 16:9 trên máy chiếu (1280×720 đến 1920×1080), và vẫn xem được trên điện thoại (thu nhỏ có viền).
- Tôn trọng `prefers-reduced-motion`: khi bật, mỗi bước hiện thẳng trạng thái cuối, không chuyển động.

## 4. Các cách đã cân nhắc

| Cách | Ưu | Nhược |
|---|---|---|
| **A. Tự dựng slide HTML, demo gắn trong slide** (đã chọn) | Animation từng bước tuỳ ý, demo hai khung nằm ngay trong slide, không phải đổi cửa sổ | Tự dựng nhiều; LM Studio phải bật CORS |
| B. Khuôn "Slides" của claude.ai | Xuất được PowerPoint/PDF, bố cục đồng đều | Animation giới hạn theo khuôn; demo phải ở cửa sổ khác |
| C. PowerPoint .pptx | Quen thuộc, dễ tự sửa | Chỉ có hiệu ứng bay/hiện; không mô phỏng được cơ chế; demo ở cửa sổ khác |

Linh chọn **A**, vì hai thứ cần nhất là animation chi tiết và demo trực tiếp, và chỉ A làm được cả hai trong một
màn hình.

## 5. Thiết kế

### 5.1 File và cấu trúc

- File mới: `docs/presentation/gia-do-deck.html`.
- Sau khi xong, publish bản đó thành Artifact để Linh gửi đồng nghiệp. Ở bản online, demo không gọi được
  `localhost` nên tự chuyển sang câu trả lời đã ghi sẵn (5.5).
- Sân khấu cố định 16:9 (ví dụ canvas 1280×720) được scale vừa cửa sổ, để vị trí animation luôn ổn định.

### 5.2 Điều hướng và bước animation

- Thư viện animation: **GSAP** (miễn phí cả cho dùng thương mại), bản minified **nhúng thẳng vào file** để chạy được
  khi không có mạng. Không cần cài gì trên máy trình chiếu. Lý do chọn: timeline có nhãn theo từng bước, nên tiến,
  lùi và nhảy tới trạng thái cuối của một bước đều là một lệnh. Phần nào CSS làm đủ thì dùng CSS.
- Mỗi slide khai báo số **bước**. Phím → / Space / PageDown chạy bước tiếp theo; hết bước thì sang slide sau.
  Phím ← lùi một bước (về trạng thái của bước trước, không phát lại hiệu ứng lùi).
- Vào một slide bằng phím ← (từ slide sau quay lại) thì slide hiện ở **trạng thái cuối**. Animation chạy theo thời
  gian (gõ chữ, chữ chảy) khi bị bỏ qua thì nhảy thẳng tới trạng thái cuối của bước đó.
- Slide demo giữ nguyên nội dung hai khung chat khi rời đi rồi quay lại, cho tới khi tải lại trang hoặc bấm "Phiên mới".
- `N` bật/tắt speaker notes, `F` toàn màn hình, `Home`/`End` về đầu/cuối.
- Thanh dưới cùng hiển thị phần đang nói (Mở đầu / Bộ não / Thư viện / Cư xử / Chấm bài / Kết) và số slide.
- Trong slide demo, khi con trỏ đang ở ô nhập câu hỏi thì các phím điều hướng không được bắt.

### 5.3 Dàn ý (21 slide, khoảng 30 phút)

Cột "Animation" mô tả cơ chế cần thấy được, không mô tả hình thức. Người dựng chọn cách vẽ.

| # | Phần | Tiêu đề / ý chính | Animation (cơ chế cần thấy) | Thời gian |
|---|---|---|---|---|
| 1 | Mở đầu | **Nuôi một bộ não biết nghề ươm giá**. AI local + RAG, ví dụ giá đỗ | Hạt đỗ nảy mầm thành cọng giá, song song các nút "nơ-ron" sáng dần | 0,5′ |
| 2 | Mở đầu | Câu hỏi mở: *"Ủ giá đỗ cần nhiệt độ bao nhiêu?"*. Hứa: đến slide 19 sẽ hỏi thật hai bộ não. Gieo trước: đáp án "đúng" cũng chưa chắc chắn (giải ở slide 12) | Bong bóng chat gõ câu hỏi; hai bong bóng trả lời bị che, ghi "đáp án ở cuối bài" | 1′ |
| 3 | Mở đầu | Vì sao chạy local: dữ liệu không rời máy, không tốn phí API, chạy được offline; đổi lại model nhỏ | Câu hỏi đi lên đám mây bị gạch, rồi quay về bộ não nằm trong laptop | 1,5′ |
| 4 | Bộ não | LLM là **máy đoán chữ tiếp theo** | Câu "Ủ giá đỗ cần nhiệt độ khoảng …" với các thanh xác suất cho chữ kế tiếp; chọn một chữ, nối vào, lặp lại. Nhấn: nghe hợp lý ≠ đúng | 2′ |
| 5 | Bộ não | Model nhỏ (qwen2.5 3B): nói giỏi, nhớ kém. **"Train" hay "cho đọc sách"?** Lật lại: dự án không train | Hai con đường: fine-tune (đổi trọng số, GPU, hàng giờ, khó sửa) và RAG (đưa sách vào lúc hỏi, sửa file là xong); con đường RAG sáng lên | 2′ |
| 6 | Thư viện | RAG tổng quan = **thi mở sách**: tìm → chép đoạn liên quan vào đề bài → trả lời | Ba bước chạy tuần tự trên câu hỏi slide 2 | 1,5′ |
| 7 | Thư viện | Nhập sách có người duyệt: 3 PDF tiếng Việt → trích chữ → khu chờ → người duyệt → thư viện | Tài liệu đi qua "cổng người duyệt", có bản bị loại, bản đạt vào kệ | 1′ |
| 8 | Thư viện | **Cắt sách (chunking)**: đoạn khoảng 600 ký tự, gối nhau 80 ký tự | Một đoạn văn dài bị cắt thành từng mảnh; phần gối nhau tô màu; giải thích vì sao cần gối (câu bị cắt đôi vẫn còn nguyên ở mảnh kia) | 1′ |
| 9 | Thư viện | **Embedding = bản đồ ý nghĩa** (bge-m3, hiểu tiếng Việt) | Các mảnh thành chấm trên bản đồ 2D, tụ thành cụm (nhiệt độ, tưới, thu hoạch, an toàn thực phẩm); câu hỏi rơi xuống cạnh cụm nhiệt độ. Ghi chú: thật ra là 1024 chiều | 1,5′ |
| 10 | Thư viện | **Tìm theo nghĩa + theo từ khoá (hybrid)** | Hai danh sách xếp hạng cạnh nhau (theo nghĩa / theo từ khoá BM25) rồi trộn thành một. Ví dụ từ khoá: "6-BAP", "nước kẹo" | 1,5′ |
| 11 | Thư viện | **Chọn lọc**: bỏ đoạn kém xa đoạn tốt nhất, chọn 4 đoạn không trùng ý (MMR) | Nhiều ứng viên → bị lọc bớt → còn 4 đoạn, hai đoạn gần trùng chỉ giữ một | 1′ |
| 12 | Thư viện | **Hồ sơ cây, và khi hai cuốn sách cãi nhau** (slide nhấn): số liệu vào đề bài mỗi lượt, số trong hồ sơ được ưu tiên, thêm cây = thêm một file. Nhưng hồ sơ giá đỗ **vẫn là bản nháp**: ĐH Cần Thơ nói 27–30°C và độ ẩm 60–65%, VAAS (trích nguồn nước ngoài) nói 22–24°C và 95%. AI không tự phân xử được; người duyệt phải chọn | Hai cuốn sách mở ra hai con số khác nhau; mũi tên "AI?" lắc qua lại; một bàn tay người duyệt đóng dấu chọn một số vào thẻ hồ sơ; thẻ lật thành câu tiếng Việt chèn vào đề bài | 1,5′ |
| 13 | Thư viện | **Ghi nguồn**: server so câu trả lời với các đoạn đã tìm, gắn "Nguồn tham khảo: …" | Các cụm chữ trùng giữa câu trả lời và đoạn sách sáng lên, rồi dòng nguồn xuất hiện | 1′ |
| 14 | Cư xử | **Ví dụ mẫu (few-shot)**: đây mới là phần thay cho "train". 7 ví dụ mỗi cây; model chép theo ví dụ. Chuyện thật: bộ ví dụ của dâu có "bật đèn", đem dùng cho giá thì hỏng vì giá phải ươm trong tối, nên mỗi cây một bộ | Thẻ ví dụ bay vào đề bài; thẻ "bật đèn" của dâu chuyển đỏ khi đặt cạnh khay giá, được thay bằng thẻ "tắt đèn" | 1,5′ |
| 15 | Cư xử | **Khuôn trả lời (structured output)**: mỗi lượt model điền một phiếu: "trả lời" hay "gọi thiết bị"; bộ sinh chữ bị ép theo khuôn, chữ sai khuôn không thể sinh ra | Phiếu hai ô; khi model sinh, các chữ không hợp lệ bị làm mờ, chỉ chữ hợp lệ được chọn | 1′ |
| 16 | Cư xử | **Tay chân có phanh (MCP)**: đọc cảm biến thì tự chạy; bơm, đèn phải hỏi Có/Không; công cụ lạ coi như điều khiển | Hai luồng: "đọc nhiệt độ" chạy thẳng tới cảm biến; "tưới khay giá" dừng ở barie đỏ chờ "Có" | 1,5′ |
| 17 | Cư xử | **Lan can cho model nhỏ**: câu trả lời thật ở vòng đo đầu có "4 часов" và "48小时" (mục 7); sửa bằng cách viết "giờ" thay "h" và chặn chữ ngoài bảng chữ cho phép | Chữ "giờ" bị nhiễu thành chữ Nga/Trung, rồi bộ lọc đỏ chặn lại, câu sạch hiện ra | 1′ |
| 18 | Chấm bài | **Chấm bài**: 12 câu giá đỗ (thêm 4 câu vòng sau), 4 thước đo; số vòng đầu và vòng mới nhất; dâu tây 52 câu | Các thanh điểm lấp đầy từ vòng đầu đến vòng mới nhất | 2′ |
| 19 | Chấm bài | **Demo trực tiếp**: hai bộ não, cùng câu hỏi (5.4) | Khung chat thật, chữ chảy theo thời gian thực | 4′ |
| 20 | Chấm bài | **Chỗ vẫn sai** (2–3 lỗi thật ở vòng mới nhất, mục 7) | Câu trả lời thật, phần sai được gạch chân, chú thích tài liệu nói gì | 1,5′ |
| 21 | Kết | **Toàn cảnh** một câu hỏi đi qua cả hệ thống (mỗi kỹ thuật là một trạm) + 3 điều mang về + hỏi đáp | Câu hỏi đi qua lần lượt các trạm của slide 6–17, mỗi trạm sáng khi đi qua | 2′ |

Ba điều mang về (slide 21):
1. Model nhỏ không cần thông minh hơn; nó cần **sách đúng** và **lan can chặt**.
2. "Dạy" một AI local phần lớn là **quản lý dữ liệu**: chọn nguồn, duyệt, cắt, ghi nguồn. Không phải train. Khi
   hai nguồn nói khác nhau, người phải chọn (slide 12).
3. **Đo, đừng đoán**: mỗi mẹo được giữ lại vì có số đo, và AI vẫn còn sai ở chỗ đã chỉ ra.

### 5.4 Slide demo trực tiếp

Hai khung chat cạnh nhau, chung một ô nhập và một dãy nút câu hỏi soạn sẵn:

- **Trái: "Bộ não trần"**: gọi thẳng LM Studio `POST {lmUrl}/v1/chat/completions` với `stream: true`, cùng model
  với server, chỉ có system prompt tối thiểu *"Bạn là trợ lý nông nghiệp. Trả lời ngắn gọn bằng tiếng Việt."*,
  không RAG, không hồ sơ, không ví dụ mẫu. Đọc luồng SSE kiểu OpenAI (`choices[0].delta.content`, kết thúc ở
  `[DONE]`).
- **Phải: "Bộ não đầy đủ"**: gọi AI server `POST {serverUrl}/chat/stream` với body `{userId, sessionId, message}`.
  Xử lý các frame `token` (nối chữ), `tool_status` (hiện dòng trạng thái tạm), `reset` (xoá phần đã hiện), `done`
  (chốt câu trả lời; nếu có `pendingAction` thì hiện câu hỏi Có/Không), `error`.
- Nhãn hai khung phải nói đúng sự thật: bên phải có RAG **cộng** hồ sơ cây **cộng** ví dụ mẫu, không chỉ RAG.
- Nút câu hỏi soạn sẵn (khớp các case eval để có bản ghi phía phải):
  - "Ủ giá đỗ cần nhiệt độ bao nhiêu?" (`bs-kb-temp`)
  - "Ngâm đỗ xanh làm giá bao lâu, nước bao nhiêu độ?" (`bs-kb-soak`)
  - "Nước kẹo làm giá là gì, có nguy hiểm không?" (`bs-kb-banned`)
  - "Giá đỗ có cần chiếu đèn hay phơi nắng không?" (`bs-kb-light`)
  - "Tưới khay giá esp32-01 trong 30 giây." (`bs-water`): **chỉ gửi bên phải**, để cho thấy câu hỏi Có/Không.
    Trả lời "có" chỉ khi MCP đang chạy; nếu không thì nói "không" để thấy lệnh bị huỷ.
- `sessionId` sinh mới mỗi lần mở trang; có nút "Phiên mới". `userId` cố định `"demo"`.
- Cấu hình: mặc định `lmUrl = http://localhost:1234`, `serverUrl = http://localhost:8787`, model id lấy từ
  `GET {lmUrl}/v1/models` (mục đầu tiên). Một bảng cài đặt nhỏ ẩn được để sửa ba giá trị này, lưu vào
  `localStorage` (bọc try/catch; thiếu storage vẫn chạy bằng mặc định).
- Đèn trạng thái: khi vào slide demo, kiểm tra `GET {serverUrl}/health` và `GET {lmUrl}/v1/models`, hiện xanh/đỏ
  cho từng bên.

### 5.5 Lối thoát khi demo hỏng và câu trả lời ghi sẵn

- Nếu một bên không kết nối được, hoặc quá **20 giây** chưa có chữ đầu tiên, khung đó tự chuyển sang câu trả lời
  ghi sẵn cho câu hỏi tương ứng, chữ hiện dần như đang gõ, kèm nhãn rõ ràng *"Bản ghi ngày …"*. Người nói cũng có
  nút "Phát bản ghi" để chủ động chuyển.
- Câu hỏi gõ tay không có bản ghi: khung báo "không kết nối được" thay vì hiện gì đó bịa.
- Nguồn bản ghi (ghi trong lúc dựng; Linh đã xác nhận bật LM Studio):
  - **Bên trái**: **chạy thật** LM Studio với đúng system prompt tối thiểu ở 5.4 cho từng câu soạn sẵn, dán nguyên
    văn vào file kèm ngày ghi. Repo hiện **không có** bản ghi nào của bộ não trần. Không được tự viết thay; nếu một
    câu không ghi được thì để trống và đánh dấu "chưa ghi".
  - **Bên phải**: ghi mới từ server chạy với `DEFAULT_PLANT=bean-sprout` (đặt qua biến môi trường của tiến trình,
    không sửa `.env`). Nếu server không lên được thì dùng nguyên văn trường `reply` trong
    `data/eval/r3-bean-sprout-1-2026-11-17T07-01-19-417Z.json`. Riêng câu tưới (`bs-water`), trường `reply` của
    eval chỉ có lời dẫn; khi phải dùng eval thì ghép lời dẫn đó với câu xác nhận cố định mà server sinh ra
    (`src/agent/orchestrator.ts`, mẫu `Bạn xác nhận thực hiện: "<tóm tắt>"? (Có/Không)`).
  - Câu "chiếu đèn hay phơi nắng" có thể ra câu trả lời có lỗi (r3 có lỗi lẫn chu kỳ tưới). Giữ nguyên lỗi nếu có;
    slide 20 nhắc lại: "câu vừa thấy ở demo cũng có chỗ sai này".
- Bản publish online: slide demo chỉ phát bản ghi; đèn trạng thái thay bằng nhãn "Bản online: phát câu trả lời
  đã ghi".

### 5.6 Giao diện

- Người dựng chọn phong cách theo skill `artifact-design`. Gợi ý chủ đề: màu hạt đỗ xanh và cọng giá trắng ngà, nền
  sáng; có chế độ tối.
- Chữ trên slide lớn và ít: mỗi slide một câu tiêu đề, tối đa khoảng 3 ý ngắn; phần giải thích dài nằm trong speaker
  notes.

### 5.7 Speaker notes

Mỗi slide có notes tiếng Việt: câu nói mở, ý phải nói, mốc thời gian, nguồn số liệu, và câu trả lời sẵn cho câu
hỏi có thể gặp (ví dụ: "Sao không fine-tune?", "Model lớn trên cloud có tốt hơn không?", "Dữ liệu ít vậy có đủ
không?").

## 6. Chuẩn bị trước buổi nói (đưa vào notes slide 19 và báo Linh khi bàn giao)

1. `.env` đổi `DEFAULT_PLANT=strawberry` thành `DEFAULT_PLANT=bean-sprout`, khởi động lại server.
2. Bật LM Studio, nạp model qwen2.5-3b-instruct, bật **Enable CORS** trong phần Developer/Server.
3. (Tuỳ chọn) bật MCP (`http://localhost:8100/mcp`) nếu muốn trả lời "có" cho lệnh tưới.
4. Mở `gia-do-deck.html`, vào slide 19, kiểm tra hai đèn trạng thái đều xanh, chạy thử một câu.

## 7. Bảng số liệu được phép dùng

| Mục | Giá trị | Nguồn trong repo |
|---|---|---|
| Model trò chuyện | qwen2.5-3b-instruct, chạy qua LM Studio (OpenAI-compatible) | `data/eval/*bean*.json` trường `model` |
| Model embedding | bge-m3 | `data/eval/*.json` trường `embedModel`; CLAUDE.md |
| Cắt sách | 600 ký tự, gối 80 | `src/config.ts` (`RAG_CHUNK_SIZE`, `RAG_CHUNK_OVERLAP`) |
| Tìm kiếm | theo nghĩa + BM25 (bật mặc định), bỏ đoạn kém hơn đoạn tốt nhất quá 0,15, chọn 4 đoạn bằng MMR λ = 0,7 | `src/config.ts`, CLAUDE.md mục RAG |
| Kho giá đỗ | 30 đoạn | `storeSize` trong eval giá đỗ |
| Kho dâu tây | 69 đoạn | `storeSize` trong `r4-strawberry-1-…json` |
| Nguồn giá đỗ | 3 PDF: Tạp chí VAAS số 7/2019 (máy làm giá tự động), Tạp chí Khoa học ĐH Cần Thơ 2016 (hệ thống ươm rau mầm), tài liệu ATTP UBND Ninh Bình | `data/pdf/bean-sprout/`, `bean-sprout.json` → `sources`, `notes` |
| Hồ sơ giá đỗ | 27–30°C; độ ẩm không khí 60–65%; ươm trong tối (0 giờ chiếu sáng); tưới 30 phút một lần, mỗi lần 1 phút; ngâm hạt 35°C trong 4 giờ; thu hoạch sau 48 giờ; khoảng 7 kg giá từ 1 kg đỗ; gieo 40 g hạt/dm² | `src/domain/knowledge/bean-sprout.json` |
| Ví dụ mẫu | 7 ví dụ cho mỗi cây có bộ riêng (dâu tây, giá đỗ) | `src/domain/fewshot.ts` |
| Công cụ thiết bị | 12 công cụ MCP; công cụ lạ mặc định là "điều khiển"; lệnh chờ xác nhận hết hạn sau 30 phút | `src/mcp/knownTools.ts`, `src/mcp/policy.ts`, `src/config.ts` (`pendingTtlMs`) |
| Eval giá đỗ, vòng đầu (r0, 16/11) | chọn đúng hành động 12/12; trích đúng số liệu 5/6 (câu thu hoạch thiếu "48") | `data/eval/r0-bean-sprout-default-…json` |
| Chữ lạ ở vòng đầu | câu ngâm hạt: "…trong khoảng 4 часов… tổng thời gian tưới 48小时。" | `r0-bean-sprout-default-…json`, case `bs-kb-soak` |
| Eval giá đỗ, vòng mới nhất (r3, 17/11) | chọn đúng hành động 12/12; đúng mức an toàn 12/12; trích đúng số liệu 6/6; sạch chữ lạ 12/12; tìm đúng đoạn sách 7/7 câu có đánh dấu | `data/eval/r3-bean-sprout-1-…json` → `summary` |
| Eval dâu tây, vòng mới nhất (r4) | 52/52 chọn đúng; trích đúng số liệu 14/14 | `data/eval/r4-strawberry-1-…json` |
| Lỗi còn lại (r3) | `r1-bs-sell-light`: tự thêm "giữ nhiệt độ 27-30°C và độ ẩm 60-65%" khi mang giá ra chợ; `bs-kb-light`: "tưới gián đoạn theo chu kỳ (khoảng 30 phút mỗi 1-2 giờ)", lẫn lộn chu kỳ; `bs-kb-harvest`: "rễ dài từ 1–2 cm (theo ĐH Cần Thơ)", trong khi hồ sơ ghi rễ 1–1,5 cm theo VAAS | `r3-bean-sprout-1-…json` |

Eval là phép đo có dao động (model trả lời khác nhau mỗi lần chạy). Slide 18 phải ghi đây là kết quả một lần chạy
và số câu còn ít, không trình bày như độ chính xác tuyệt đối.

Cách trình bày slide 18: hai mốc, vòng đầu (r0) và vòng mới nhất (r3), trên **12 câu gốc** (trường `summary`). Bốn câu
thêm ở vòng sau ghi riêng một dòng theo `summaryR1`. Thước đo "sạch chữ lạ" chưa có ở r0 nên ghi "chưa đo", rồi dẫn
sang slide 17, nơi đã cho thấy câu chữ lạ thật của vòng đó.

Tình trạng dữ liệu: tài liệu trong `data/docs/bean-sprout.jsonl` **đã được duyệt** (commit `f23bf40`). Hồ sơ
`bean-sprout.json` **chưa được duyệt** (Linh xác nhận 2026-11-19); slide 12 nói thẳng điều này.

Hình minh hoạ cơ chế (thanh xác suất ở slide 4, bản đồ 2D ở slide 9, chữ bị làm mờ ở slide 15) là **sơ đồ minh hoạ**,
không phải số đo; mỗi hình có nhãn nhỏ "minh hoạ".

## 8. Để lại cho người dựng

- Phong cách hình ảnh, bảng màu, font, cách vẽ từng animation (trong khuôn khổ mục 3 và 5.3).
- Cách tổ chức JS/CSS bên trong file.
- Câu chữ cụ thể trên slide và trong notes, miễn đúng mục 7.
- Có thêm hay bớt tối đa 2 slide nếu cần để giữ nhịp 30 phút, với điều kiện mỗi kỹ thuật ở slide 8–17 vẫn có
  slide riêng.
