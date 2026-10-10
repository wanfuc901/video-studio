# Frameflow Video Studio

Trình biên tập video chạy trực tiếp trong trình duyệt. Thêm video, ảnh và âm thanh; kéo clip trên timeline, kéo mép để cắt, chia clip tại con trỏ, chỉnh thời lượng và âm lượng, bật hoặc tắt tiếng từng clip hay toàn bộ dự án. Xuất video WebM có âm thanh bằng MediaRecorder.

Mở `dist/index.html` qua một máy chủ HTTP tĩnh. Ví dụ:

```powershell
cd dist
python -m http.server 8765
```

Sau đó truy cập `http://localhost:8765`. Tệp nhập được giữ trong bộ nhớ của tab hiện tại; tải trang lại sẽ bắt đầu dự án mới. Quá trình xuất diễn ra theo thời gian thực nên video 1 phút cần khoảng 1 phút để tạo.

## Chữ và karaoke

- Nhấn **Thêm chữ** trên timeline hoặc **Chữ & lời karaoke** trong thư viện. Chữ được thêm tại con trỏ, có track riêng và danh sách câu để chọn cả các câu chồng thời gian.
- Chỉnh thời điểm hiện/ẩn và thời lượng với độ chia 0.001 giây. Nhân đôi câu để tiếp tục nhập lời; kéo và cắt clip chữ vẫn giữ thời điểm chạy màu của câu gốc.
- **Chạy đều cả câu**: thời gian chờ, thời gian chạy ở 1×, tốc độ màu 0.05–10× và hướng chạy.
- **Căn từng từ / tiếng**: mốc đầu/cuối riêng cho mỗi từ; nút ◎ lấy mốc tại con trỏ sau khi quy đổi thời gian chờ và tốc độ màu. Cho phép khoảng nghỉ nhưng không chồng các từ. Sửa từ mà giữ số lượng từ sẽ giữ mốc đã căn; đổi số lượng từ sẽ chia lại mốc tự động.
- **Mốc tốc độ tùy chỉnh**: các cặp giây/% màu tạo đường chạy theo đoạn. Hai mốc cùng % giữ màu tại chỗ cho đoạn ngân. Mốc giây tăng dần, % không giảm, bắt đầu 0% và kết thúc 100%.
- Phông, cỡ chữ, màu gốc/màu chạy, viền, vị trí, độ rộng, độ hiện rõ, căn lề và nền tối tùy chỉnh được. Nội dung nhiều dòng tự xuống hàng theo độ rộng.
- Nghe thử 0.5×/0.75×, lặp câu và tua ±10 ms để căn nhịp; tốc độ nghe thử không làm thay đổi tốc độ video xuất. Độ chính xác thực tế khi phát/xuất còn phụ thuộc nhịp khung hình và media trong trình duyệt.
- Chữ được vẽ bằng cùng một bộ dựng canvas cho xem trước và xuất WebM 1280 × 720, 30 fps; có thể dùng chữ trên nền đen mà không cần video nền.

Mốc màu luôn tính từ câu gốc: `thời_gian_màu = (thời_gian_video - bắt_đầu_clip + cắt_đầu - thời_gian_chờ) × tốc_độ_màu`.

## Kiểm tra

`node --test tests/karaoke.test.mjs` kiểm tra chạy màu, khoảng nghỉ, đường tiến độ, cắt câu, xác thực mốc và tính nhất quán của bộ dựng xem trước/xuất.

Đã kiểm tra cú pháp và vẽ khung hình tiếng Việt bằng canvas. Phiên cập nhật này không có công cụ điều khiển trình duyệt; giao diện và MediaRecorder chưa được kiểm thử đầu-cuối trên trình duyệt.


## Bố cục, timeline và phím tắt

Khung xem trước được giới hạn theo cả chiều rộng và chiều cao còn trống. Play, âm lượng và cụm căn lời có các hàng riêng bên dưới khung hình. Khi thêm chữ, nhân đôi hoặc chọn một câu trong danh sách, timeline tự cuộn tới đúng thời điểm và track của clip; kể cả câu ở cuối bài hát dài.

Lịch sử tối đa 100 bước hỗ trợ hoàn tác/làm lại việc thêm, xóa, cắt, kéo và đổi thời lượng clip, sửa chữ, định dạng và mốc karaoke, âm lượng và tên dự án. Các ký tự gõ liên tiếp được gộp; một lần kéo clip tạo một bước. Các tệp trong thư viện vẫn được giữ để có thể khôi phục clip.

| Phím | Thao tác |
| --- | --- |
| Ctrl+Z | Hoàn tác |
| Ctrl+Y hoặc Ctrl+Shift+Z | Làm lại |
| Delete / Backspace | Xóa clip đã chọn |
| Ctrl+D | Nhân đôi clip |
| T | Thêm chữ tại con trỏ |
| S | Chia clip tại con trỏ |
| Space | Phát / dừng |
| ← / → | Tua 1 khung hình (30 fps) |
| Shift+← / Shift+→ | Tua 1 giây |
| Home / End | Đầu / cuối dự án |
| ? | Mở hướng dẫn phím tắt |

Trên Mac dùng Command thay Ctrl. Khi đang gõ, phím xóa và mũi tên chỉ sửa nội dung ô nhập. Ctrl+Z trong ô nội dung lời hoặc tên dự án dùng lịch sử của ứng dụng; ô số dùng hoàn tác nhập liệu của trình duyệt. Phím tắt chỉnh sửa bị khóa khi xuất video hoặc mở hộp thoại.

Chạy toàn bộ kiểm tra bằng `node --test tests/*.test.mjs`. Các ca hồi quy mới bao gồm khung xem trước trên màn hình thấp, chữ ở giây 393.107 ngoài vùng timeline đang nhìn, lịch sử chữ/media và phân biệt phím tắt với gõ nội dung. Chưa có kiểm thử giao diện trực tiếp trên trình duyệt trong phiên này.

## Tạo lời bằng AI

Nhấn **Tạo lời bằng AI** trong thư viện, chọn video/âm thanh có giọng hát hoặc lời nói, chọn đoạn trong tệp và vị trí chèn trên timeline, rồi nhấn **Nhận diện lời**. Kết quả có mốc từng từ và được chia thành câu. Sửa nội dung, để trống câu muốn bỏ rồi nhấn **Thêm lời vào timeline**. Các câu xuất hiện ngay trên track chữ với chế độ karaoke từng từ; cả lần chèn có thể hoàn tác bằng một lần Ctrl+Z. Câu đang chọn là chữ thì kiểu chữ của câu đó được sao chép cho lời mới.

Whisper Tiny/Base/Small đa ngôn ngữ chạy trong Web Worker bằng Transformers.js 3.8.1 và ONNX WASM q8. Không cần API key hoặc tải tệp âm thanh lên máy chủ; mô hình và thư viện tải từ Hugging Face/jsDelivr, được cache theo khả năng trình duyệt. Tối đa 10 phút/lần và tệp 300 MB. Bắt đầu bằng đoạn 20–30 giây; Tiny nhẹ hơn, Small lớn hơn và chậm hơn. Các đoạn lõi 20 giây có 3 giây ngữ cảnh ở mỗi bên để giảm mất từ tại ranh giới.

Chọn nguồn gốc của một clip để giữ phần cắt và vị trí timeline mặc định. AI đọc âm thanh gốc của nguồn, kể cả clip đang tắt tiếng, không trộn các track khác. Beat không còn giọng hát không thể dùng để lấy lời. Bài hát có thể bị nhận sai hoặc lệch nhịp; kiểm tra kết quả và sửa các mốc từ trong bảng karaoke. Trình duyệt không đọc được âm thanh trong video sẽ hướng dẫn dùng thêm bản MP3/WAV có giọng. Nút dừng hủy công việc và giữ timeline; đóng hộp thoại giải phóng bộ nhớ mô hình.

Tài liệu thư viện: https://huggingface.co/docs/transformers.js/v3.8.1/en/installation . Đã kiểm tra nhận diện thực tế trên mẫu âm thanh 5 giây với Whisper Tiny q8, backend CPU trong Node và cùng tùy chọn mốc từng từ. Cả 28 kiểm tra tự động đạt, gồm ánh xạ đoạn âm thanh vào timeline, sửa/xóa câu, mốc thiếu/chồng và hoàn tác cả đợt. Chưa kiểm thử đầu-cuối trên trình duyệt, đọc codec video hoặc WASM trong trình duyệt ở phiên này.
