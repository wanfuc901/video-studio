# Frameflow Video Studio

Trình biên tập video chạy trực tiếp trong trình duyệt. Thêm video, ảnh và âm thanh; kéo clip trên timeline, kéo mép để cắt, chia clip tại con trỏ, chỉnh thời lượng và âm lượng, bật hoặc tắt tiếng từng clip hay toàn bộ dự án. Xuất MP4 (H.264 + AAC) bằng WebCodecs, nhanh hơn thời gian thực; trình duyệt cũ dùng MediaRecorder.

Mở `dist/index.html` qua một máy chủ HTTP tĩnh, ví dụ `npm start` (Python `http.server` ở cổng 8765), hoặc dùng bản GitHub Pages https://wanfuc901.github.io/video-studio/ .

```powershell
cd dist
python -m http.server 8765
```

Sau đó truy cập `http://localhost:8765`. Phiên làm việc và tệp media tự lưu trong IndexedDB của trình duyệt; mở lại cùng địa chỉ để tiếp tục sau khi trạng thái báo Đã lưu. Chế độ Dựng nhanh không phụ thuộc thời gian phát; chế độ Ghi thời gian thực cần đúng bằng thời lượng video.

## Karaoke Pro: bắt lời, nhịp, ngân và vang (bộ chạy trên máy)

Chọn **Tạo lời bằng AI → Trên máy**, giữ ô **Karaoke Pro**. Bộ chạy `tools/local-ai` nhận tệp gốc, chỉ xử lý đoạn Từ–Đến và trả về:

- **Lời**: có lyrics thì căn cưỡng bức từng ký tự (CTC, wav2vec2 tiếng Việt), giữ đúng chính tả và xuống dòng; chưa có lyrics thì Whisper Large V3 nghe trên giọng đã tách rồi căn lại.
- **Nhịp lời**: điểm bắt đầu từ được kéo về onset của giọng hát (tìm lùi tối đa 250 ms trước đỉnh CTC, vì CTC luôn báo trễ khoảng 90 ms).
- **Ngân**: từ kéo dài giữ màu karaoke tới khi dứt giọng; bảng xem lại ghi "Ngân: lan 1.6s".
- **Vang**: câu ở lại trên màn hình tới khi hết tiếng vang, không chồng câu kế tiếp.
- **Nhịp nhạc**: BPM và các phách hiện thành vạch trên thước timeline sau khi chèn lời.

Cài đặt, model và API ở [tools/local-ai/README.md](tools/local-ai/README.md). Trình duyệt (Whisper Tiny/Base/Small, nay ưu tiên WebGPU) và Groq vẫn dùng được như trước.

## Xuất nhanh và hiệu năng

- **Dựng nhanh (mặc định)**: Mediabunny + WebCodecs giải mã từng khung hình theo timestamp, vẽ chữ karaoke rồi mã hóa MP4. Không có khung đen khi chuyển clip, không hỏng khi đổi tab. Video ước tính trên 400 MB sẽ hỏi nơi lưu để ghi thẳng ra ổ đĩa. Tệp nguồn WebCodecs không giải mã được thì tự chuyển sang ghi thời gian thực.
- **Ghi thời gian thực**: giữ khung cuối khi video đang tải để không ghi khung đen, tự tạm dừng khi tab bị ẩn, ưu tiên MP4 nếu MediaRecorder hỗ trợ.
- Timeline chỉ dựng các clip trong vùng nhìn thấy (thêm 1 màn hình mỗi bên); kéo clip chỉ cập nhật clip đó, mỗi khung hình một lần.
- Lịch sử hoàn tác dùng chung các clip không đổi, nên bản lưu phiên không phình theo số bước. Tự lưu gom thay đổi trong 0,7 giây.
- Tạo lời trên trình duyệt từ chối tệp dài cần quá 512 MB RAM để giải mã, và hướng dẫn chuyển sang bộ chạy trên máy.

## Kiểm tra

```sh
npm test                                                     # 71 kiểm tra JavaScript
python -m unittest discover -s tests -p "test_*.py"          # 18 kiểm tra Python (cần numpy)
```

## Chữ và karaoke

- Nhấn **Thêm chữ** trên timeline hoặc **Chữ & lời karaoke** trong thư viện. Chữ được thêm tại con trỏ, có track riêng và danh sách câu để chọn cả các câu chồng thời gian.
- Chỉnh thời điểm hiện/ẩn và thời lượng với độ chia 0.001 giây. Nhân đôi câu để tiếp tục nhập lời; kéo và cắt clip chữ vẫn giữ thời điểm chạy màu của câu gốc.
- **Chạy đều cả câu**: thời gian chờ, thời gian chạy ở 1×, tốc độ màu 0.05–10× và hướng chạy.
- **Căn từng từ / tiếng**: mốc đầu/cuối riêng cho mỗi từ; nút ◎ lấy mốc tại con trỏ sau khi quy đổi thời gian chờ và tốc độ màu. Cho phép khoảng nghỉ nhưng không chồng các từ. Sửa từ mà giữ số lượng từ sẽ giữ mốc đã căn; đổi số lượng từ sẽ chia lại mốc tự động.
- **Mốc tốc độ tùy chỉnh**: các cặp giây/% màu tạo đường chạy theo đoạn. Hai mốc cùng % giữ màu tại chỗ cho đoạn ngân. Mốc giây tăng dần, % không giảm, bắt đầu 0% và kết thúc 100%.
- Phông, cỡ chữ, màu gốc/màu chạy, viền, vị trí, độ rộng, độ hiện rõ, căn lề và nền tối tùy chỉnh được. Nội dung nhiều dòng tự xuống hàng theo độ rộng.
- Nghe thử 0.5×/0.75×, lặp câu và tua ±10 ms để căn nhịp; tốc độ nghe thử không làm thay đổi tốc độ video xuất. Độ chính xác thực tế khi phát/xuất còn phụ thuộc nhịp khung hình và media trong trình duyệt.
- Chữ được vẽ bằng cùng một bộ dựng canvas cho xem trước và xuất MP4/WebM 1920 × 1080 hoặc 1280 × 720, 30 fps; có thể dùng chữ trên nền đen mà không cần video nền.

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

## Lyrics có sẵn, API và model trên máy

Trong **Tạo lời bằng AI**, chọn một trong ba cách:

- **AI tự nghe**: tạo nội dung và mốc từ như trước.
- **Đã có lyrics**: dán lời hoặc nhập TXT, mỗi câu một dòng, chỉ gồm lời của đoạn âm thanh đang chọn. Giữ nguyên nội dung và cách chia câu. Ứng dụng nhận diện âm thanh rồi khớp chuỗi từ theo thứ tự, kể cả điệp khúc lặp; từ thiếu/khác được nội suy và đánh dấu để nghe lại. Đây là khớp với bản nhận diện, chưa phải forced alignment âm vị. Không đảm bảo tuyệt đối với giọng hát/ngân hoặc nhạc nền lớn.
- **Nhập SRT/LRC có mốc**: giữ mốc câu, không chạy AI. Mốc tính từ đầu tệp nguồn, được cắt theo Từ–Đến và dịch tới vị trí Chèn trên timeline. LRC hỗ trợ nhiều timestamp trên một dòng, offset và mốc trống kết thúc câu; câu cuối không có mốc kết thúc dùng cuối đoạn chọn. Mốc từng từ được chia đều và đánh dấu ước lượng. Các câu chồng nhau bị từ chối để sửa trước khi chèn.

Kết quả nghe hoàn tất mới nhất được tự lưu cùng phiên: sửa lyrics/chia câu/vị trí chèn rồi bấm lại sẽ dùng mốc đã có. Đổi nguồn, đoạn, model, ngôn ngữ hoặc nơi chạy sẽ nhận diện lại. Lyrics có sẵn giúp giảm thời gian sửa nội dung; không tự làm model nghe nhanh hơn.

### Nơi chạy

| Lựa chọn | Cách dùng | Dữ liệu |
| --- | --- | --- |
| Trình duyệt | Tiny/Base/Small, không cần key | Âm thanh ở trên thiết bị; tải model từ Hugging Face |
| Groq API | Whisper Large V3 Turbo hoặc Large V3; tạo key riêng tại https://console.groq.com/keys | Chỉ đoạn âm thanh đã chọn gửi thẳng tới Groq ở dạng WAV 16 kHz mono; không gửi video gốc hoặc lyrics |
| Trên máy | Cài [bộ Faster Whisper local](tools/local-ai/README.md), nhập địa chỉ và mã kết nối | Âm thanh gửi tới localhost, dùng CPU int8 hoặc GPU NVIDIA |

Groq có free tier theo hạn mức; xem https://console.groq.com/docs/rate-limits và gói tài khoản của bạn. Không dùng key công khai của người khác. Nếu đã bật gói tính phí, phí phụ thuộc gói đó. Key chỉ giữ trong ô nhập của tab, không lưu localStorage, source hay lịch sử dự án. Không có key của nhà phát triển nhúng sẵn.

Bộ local có launcher Windows; hướng dẫn CPU/GPU, macOS/Linux và xử lý chặn localhost ở `tools/local-ai/README.md`. Key Groq và mã local có ô riêng. Cổng mặc định 8766, chỉ cho phép địa chỉ loopback và origin editor được cấu hình. Có nút kiểm tra kết nối. Dừng nhận diện ngừng chờ phía trình duyệt; công việc đã gửi tới Groq/local có thể vẫn chạy.

Kiểm tra bổ sung: nhập phụ đề và dịch mốc, điệp khúc lặp, tiếng Việt thiếu dấu, từ nghe sai/thiếu, WAV PCM16, request API/mốc từng từ, key và localhost, hạn mức, xác thực/origin/kích thước của bộ local. `node --test tests/*.test.mjs` và `python -m unittest discover -s tests -p 'test_*.py'`. Kết nối Groq được kiểm tra CORS và hợp đồng request bằng mock; chưa chạy nhận diện với key thật của người dùng. Chưa có kiểm thử đầu-cuối trên trình duyệt hoặc GPU Windows.

Đã chạy nhận diện thực tế mẫu âm thanh 5 giây với Faster Whisper Tiny trên CPU int8, trả về từ và mốc hợp lệ. Bộ cài giới hạn `av<19` vì Faster Whisper 1.2.1 chưa tương thích thay đổi `metadata_errors` của PyAV 19. Tổng cộng 41 kiểm tra JavaScript và 5 kiểm tra Python đạt.


## Xuất 1080p và cuộn chính xác

Hộp **Xuất video** mặc định **1080p Full HD (1920 × 1080), 30 fps**, bitrate mục tiêu 12 Mbps. Có thể chọn 720p (6 Mbps) để giảm dung lượng. Cả video và chữ karaoke được dựng ở kích thước xuất đã chọn. Tệp tải xuống có hậu tố `-1080p.webm` hoặc `-720p.webm`. Xuất vẫn theo thời gian thực; chất lượng nguồn thấp không tự tăng chi tiết khi xuất 1080p.

Chọn **Độ nhạy chuột** ngay trên timeline: **Rất thấp / Chậm / Vừa / Nhanh**. Lựa chọn được nhớ trên trình duyệt, mặc định Chậm.

| Thao tác | Kết quả |
| --- | --- |
| Lăn chuột trên timeline | Di chuyển ngang timeline |
| Shift + lăn chuột | Cuộn dọc các track |
| Ctrl / Command + lăn chuột | Phóng to/thu nhỏ quanh vị trí chuột |
| Alt + lăn chuột trên timeline | Tua con trỏ từng 1 / 10 / 50 / 100 ms theo độ nhạy |
| Lăn chuột trong bảng thuộc tính | Cuộn bảng, không vô tình đổi ô số đang chọn |
| Alt + lăn chuột trên ô số/thanh trượt | Tăng/giảm giá trị; độ nhạy Rất thấp dùng bước nhỏ nhất của ô |

Các ô mốc thời gian hỗ trợ bước 0.001 giây ở mức Rất thấp. Giá trị vẫn tuân theo giới hạn của từng thuộc tính và có thể hoàn tác. Độ chia mốc 1 ms không đồng nghĩa video xuất có khung hình mỗi 1 ms: video 30 fps có khoảng cách khung hình khoảng 33.3 ms.

Toàn bộ **50 kiểm tra JavaScript đạt**. Các ca mới kiểm tra kích thước canvas xuất, bitrate, âm thanh, hủy trong lúc chuẩn bị, dọn trạng thái khi encoder lỗi, phóng timeline quanh chuột, bước thời gian và phân biệt cuộn bảng với sửa số. MediaRecorder/canvas được giả lập trong kiểm tra xuất; chưa kiểm thử tệp WebM 1080p thực tế và thao tác giao diện đầu-cuối trên trình duyệt trong phiên này.


## Tự lưu phiên, F5 tiếp tục làm việc

Bản mới tự lưu vào **trình duyệt hiện tại, trên cùng máy và cùng địa chỉ website**: tệp video/ảnh/âm thanh, tên dự án, toàn bộ clip và chữ/karaoke, các mốc và định dạng, âm lượng, lịch sử hoàn tác/làm lại, độ phóng và vị trí timeline, độ phân giải xuất. Mở lại sẽ khôi phục media từ dữ liệu tệp đã lưu, tạo URL mới và giữ phát video ở trạng thái dừng.

Thanh trạng thái luôn hiện **Đang lưu phiên / Đã lưu / Lỗi lưu**. Chờ **Đã lưu trên trình duyệt** trước khi F5 hoặc đóng tab. Nếu còn đang nhập media hoặc chưa lưu xong, ứng dụng yêu cầu trình duyệt cảnh báo trước khi rời trang. Hết dung lượng hoặc quyền lưu bị chặn sẽ báo lỗi, không giả báo thành công; có nút thử lưu lại. Không xóa bản lưu cũ khi một lần ghi thất bại. Hai tab cùng chỉnh một phiên: tab có bản cũ bị chặn ghi đè, hãy tiếp tục ở tab đã cập nhật mới nhất.

Media chỉ ghi một lần; metadata và media mới commit chung giao dịch. Ứng dụng xin chế độ lưu bền của trình duyệt khi nhập media, nhưng trình duyệt có thể từ chối. Xóa dữ liệu website, dùng ẩn danh, đổi trình duyệt/máy hoặc đổi địa chỉ sẽ không giữ cùng phiên. Đây chưa phải đồng bộ đám mây. Tab chạy bản cũ chưa có tính năng tự lưu không thể tự khôi phục các chỉnh sửa trước lần nâng cấp này.

### Lyrics của bạn + mốc AI

Nhấn **Có lyrics → AI ráp lời** → dán lời hoặc nhập TXT → chọn video/âm thanh còn giọng hát và khoảng cần căn → **Căn theo lyrics** → kiểm tra → **Thêm lời vào timeline**. AI nhận diện tiếng hát để lấy mốc, sau đó khớp theo thứ tự với lời bạn cung cấp; giữ chính tả, dấu câu và cách chia dòng của lyrics. Mốc không khớp được đánh dấu ước lượng, vẫn cần nghe lại đoạn ngân hoặc từ nhận diện sai. Beat đã tách giọng không đủ để AI nghe lấy mốc.

Lời đã dán, nguồn, khoảng thời gian, nơi chạy/model, các câu đã sửa trong bước xem lại và kết quả nghe hoàn tất cũng được tự lưu. Sau F5, sửa lyrics rồi bấm căn lại cùng nguồn/đoạn/model sẽ dùng lại kết quả nghe, không cần gọi AI lần nữa. Không lưu API key/mã local; tác vụ AI đang chạy và tác vụ xuất không tiếp tục qua F5, cần chạy lại nếu chưa hoàn tất.

Tổng cộng **60 kiểm tra JavaScript đạt**. Kiểm tra bổ sung dùng giao dịch IndexedDB giả lập và DOM giả lập: media giữ đúng byte qua lần mở kho mới; ghi lỗi giữ nguyên bản cũ; chặn ghi đè giữa tab; gom các sửa đổi trong lúc ghi; thử lại lỗi dung lượng; khôi phục lịch sử và URL media; bản nháp lyrics/cache AI vẫn ráp được đúng lời sau mở lại. Chưa có kiểm thử F5, hạn mức lưu trữ hoặc tải media đầu-cuối trên trình duyệt thực trong phiên này.
