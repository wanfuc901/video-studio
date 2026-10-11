# Bộ AI chạy trên máy cho Video Studio

Bộ chạy này nằm ở `127.0.0.1` và có hai chế độ:

- **Karaoke Pro** (mặc định khi chọn "Trên máy"): tách giọng khỏi nhạc nền, khử vang, căn từng từ theo lyrics, rồi dò điểm vào từ, đoạn ngân, tiếng vang và nhịp bài hát.
- **Nhận diện Whisper**: nhận đoạn WAV 16 kHz từ trình duyệt và trả mốc từng từ bằng Faster Whisper (chế độ cũ, bỏ chọn Karaoke Pro để dùng).

Âm thanh không rời khỏi máy. Chỉ lần tải thư viện và model đầu tiên cần mạng.

## Pipeline Karaoke Pro

| Bước | Model / thuật toán | Để làm gì |
| --- | --- | --- |
| Giải mã | PyAV | Chỉ đọc đoạn Từ–Đến của tệp gốc (video hoặc nhạc), không giải mã cả tệp trong trình duyệt |
| Tách giọng | `mel_band_roformer_kim_ft_unwa` (audio-separator) | Bỏ nhạc nền để mọi bước sau chỉ nghe giọng hát |
| Khử vang | `dereverb-echo_mel_band_roformer_sdr_13.4843_v2` | Có cả bản giọng "khô" (điểm dứt giọng thật) và bản "ướt" (tiếng vang người nghe vẫn nghe thấy) |
| Bắt lời | Có lyrics: căn cưỡng bức CTC bằng `nguyenvulebinh/wav2vec2-base-vietnamese-250h` (tiếng Việt), `facebook/wav2vec2-base-960h` (tiếng Anh), MMS + uroman (ngôn ngữ khác). Chưa có lyrics: Whisper Large V3 nghe rồi căn lại bằng CTC | Giữ đúng chữ bạn nhập; mỗi từ có mốc riêng |
| Bắt nhịp lời | Onset của giọng khô (librosa) | CTC báo từ trễ khoảng 90 ms; kéo điểm bắt đầu về onset gần nhất trong 250 ms trước đó, không có onset thì bù 60 ms |
| Bắt ngân | Mức âm + pYIN voicing trên giọng khô | Từ được ngân giữ màu karaoke tới lúc dứt giọng; giọng kéo dài ≥ 0,5 s được đánh dấu "ngân" |
| Bắt vang | Đuôi năng lượng của giọng ướt | Câu ở lại trên màn hình tới khi hết vang, không chồng câu sau |
| Nhịp nhạc | librosa beat tracking trên bản mix, gập tempo về 70–160 BPM | BPM và các phách hiện trên thước timeline |

Model wav2vec2 tiếng Việt dùng giấy phép CC-BY-NC-SA 4.0: dùng cá nhân thì được, không dùng cho sản phẩm thương mại.

## Windows

1. Cài **Python 3.12** từ https://www.python.org/downloads/windows/ (tick "Add python.exe to PATH").
2. Chọn ổ còn trống từ 15 GB trở lên cho venv, model và tệp tạm, rồi chạy một lần trong Command Prompt:
   ```bat
   setx VIDEO_STUDIO_AI_HOME D:\video-studio-ai
   ```
   Nếu không đặt biến này, mọi thứ nằm trong `tools/local-ai/.ai-home`.
3. Mở `tools/local-ai/start-windows.cmd`. Máy có NVIDIA sẽ tự cài PyTorch CUDA 12.8; không có thì cài bản CPU. Lần đầu tải khoảng 5 GB thư viện. Các lần sau chỉ cài lại khi danh sách thư viện thay đổi.
4. Giữ cửa sổ mở, sao chép **Connection code**.
5. Mở editor → **Tạo lời bằng AI** → nơi chạy **Trên máy** → địa chỉ `http://127.0.0.1:8766`, dán mã → **Kiểm tra kết nối**. Dòng trạng thái báo "Karaoke Pro sẵn sàng".
6. Lần chạy đầu tải thêm model tách giọng, khử vang, wav2vec2 và Whisper (khoảng 4 GB).

### Cấu hình đã kiểm thử

i5-11400F, 16 GB RAM, RTX 3050 6 GB. Whisper chạy `int8_float16` (khoảng 2 GB VRAM) để tách giọng và căn từ vẫn còn chỗ trên GPU 6 GB. Nếu báo hết bộ nhớ GPU, chọn đoạn ngắn hơn hoặc model Whisper Turbo.

Cửa sổ bộ chạy có thể in cảnh báo `cudart64_13.dll` / `cublas64_13.dll` của onnxruntime. Có thể bỏ qua: các model mặc định chạy bằng PyTorch CUDA 12.8, onnxruntime chỉ dùng cho model `.onnx` cũ.

Đổi model tách giọng hoặc khử vang bằng biến môi trường `VS_VOCAL_MODEL` và `VS_DEREVERB_MODEL` (tên tệp theo `audio-separator --list_models`).

## Bảo mật

- Chỉ lắng nghe `127.0.0.1`. Connection code tạo mới mỗi lần khởi động và không lưu trên đĩa.
- Chỉ nhận request từ: `https://wanfuc901.github.io` (GitHub Pages), `https://video-studio-phuc.windyray8.chatgpt.site`, `http://localhost:8765`, `http://127.0.0.1:8765`. Thêm editor khác bằng `start-windows.cmd --origin https://dia-chi-cua-ban`.
- Không ghi log lyrics, âm thanh hay kết quả. Tệp tải lên và stem tạm bị xóa khi tác vụ xong.

## API

| Method | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | `/health` | Thiết bị, model, `features.karaoke` / `features.separation` |
| POST | `/v1/karaoke/jobs` | JSON `{from, to, language, model, lyrics[], separate, dereverb, beats}` → `{id}` |
| PUT | `/v1/karaoke/jobs/{id}/audio` | Thân request là tệp gốc (tối đa 2 GB, ghi thẳng ra đĩa) |
| GET | `/v1/karaoke/jobs/{id}` | `state`, `stage`, `progress`, và `result` khi `done` |
| DELETE | `/v1/karaoke/jobs/{id}` | Hủy; tác vụ dừng ở bước kế tiếp |
| POST | `/v1/audio/transcriptions` | Chế độ Whisper cũ, WAV 16 kHz mono |

Mọi request cần header `Authorization: Bearer <connection code>`.

## Linux / macOS

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -c constraints.txt torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128   # hoặc /whl/cpu
.venv/bin/python -m pip install -c constraints.txt -r requirements.txt -r requirements-karaoke.txt
.venv/bin/python server.py --device cuda   # hoặc bỏ --device để chạy CPU
```

## Nếu trình duyệt chặn localhost

Dùng Chrome/Edge và cho phép quyền "mạng cục bộ" khi trang hỏi. Hoặc chạy editor ngay trên máy: `npm start` ở thư mục gốc repo rồi vào `http://127.0.0.1:8765`.
