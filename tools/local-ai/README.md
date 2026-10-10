# Model local cho Video Studio

Bộ chạy này nhận đoạn WAV từ Video Studio và trả về mốc từng từ bằng Faster Whisper. Âm thanh ở trên máy; chỉ lần tải model cần mạng. Máy phải có đủ RAM/VRAM cho model đã chọn. Chạy trên trình duyệt (Tiny/Base/Small) có sẵn trong app, không cần cài bộ này.

## Windows — dùng CPU trước

1. Cài **Python 3.11 hoặc 3.12** từ https://www.python.org/downloads/windows/ .
2. Tải repo bằng **Code → Download ZIP**, giải nén. Mở `tools/local-ai/start-windows.cmd`.
3. Đợi cài thư viện. Giữ cửa sổ đang chạy và sao chép **Connection code**.
4. Mở https://video-studio-phuc.windyray8.chatgpt.site → **Tạo lời bằng AI** → nơi chạy **Trên máy**.
5. Địa chỉ `http://127.0.0.1:8766`, dán mã vào **Mã kết nối local**, nhấn **Kiểm tra kết nối**. Cho phép truy cập mạng cục bộ nếu trình duyệt hỏi.
6. Chọn **Small** để bắt đầu. Lần đầu model sẽ tải từ Hugging Face. Nếu thiếu RAM, chuyển Base/Tiny hoặc chọn đoạn ngắn hơn.

Key Groq không dùng cho bộ local. Connection code được tạo lại mỗi lần khởi động và không lưu trên đĩa. Bộ chạy chỉ lắng nghe ở `127.0.0.1`, chỉ chấp nhận origin của Video Studio và hai địa chỉ editor local bên dưới.

## GPU NVIDIA (tùy chọn)

Theo hướng dẫn [Faster Whisper](https://github.com/SYSTRAN/faster-whisper#gpu), cần CUDA 12 và cuDNN 9 phù hợp CTranslate2. Mở Command Prompt trong thư mục này:

```bat
start-windows.cmd --device cuda --compute-type float16
```

Nếu gặp lỗi DLL/CUDA hoặc thiếu VRAM, chạy lại không tham số để dùng CPU int8. Model Large V3/Medium tốn tài nguyên hơn Small; không tự tải model lớn khi chỉ mở hộp thoại.

## Linux / macOS

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

macOS dùng CPU int8; bộ này không dùng Metal. Trình duyệt vẫn có lựa chọn chạy Whisper riêng.

## Nếu trình duyệt chặn kết nối localhost

Dùng Chrome/Edge và kiểm tra quyền mạng cục bộ của trang. Hoặc chạy editor từ repo trên cùng máy: mở terminal ở thư mục gốc repo rồi chạy `python -m http.server 8765 --directory dist`; vào `http://127.0.0.1:8765`. Bộ local vẫn chạy ở cổng 8766. Với origin editor khác, thêm `--origin https://dia-chi-editor-cua-ban` khi khởi động bộ chạy.

Mỗi lần xử lý tối đa 10 phút, một tác vụ tại một thời điểm. Bấm dừng trong trình duyệt ngừng chờ và chặn kết quả chèn vào timeline; tác vụ đã gửi có thể vẫn chạy hết trên máy. Đợi hoặc khởi động lại bộ local trước khi chạy mới. Không bật VAD cho bài hát để tránh cắt mất đoạn ngân; mốc AI vẫn cần nghe và chỉnh lại. Không có tính phí API cho chế độ local; tốc độ phụ thuộc CPU/GPU và model.
