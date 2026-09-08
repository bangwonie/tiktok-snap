# TikTok Snap

Crawler Node.js + Chrome: lấy danh sách video qua JSON phân trang, lưu hàng đợi trên đĩa và tải MP4 bằng yt-dlp. Mặc định chỉ tải mới, bỏ qua video hoàn tất, không cập nhật snapshot cũ. Bộ lọc nguồn/nội dung Việt Nam vẫn áp dụng.

```powershell
npm start -- --tag=livecanbeeasy --region=US --lang=en-US --limit=all --auto
```

`npm run watch` khám phá hashtag trending rồi chạy từng nguồn trong `watch.config.json`. `limitPerTag: "all"` không giới hạn số video. Không có giới hạn 30 vòng cuộn.

## Cách lấy dữ liệu

- Bắt JSON `/api/challenge/item_list/` của đúng tab hashtag, lưu ID và cursor sau mỗi trang trước khi tải.
- Thử cursor bằng phiên Chrome hiện tại. Nếu phản hồi rỗng/không hợp lệ, tiếp tục phát sinh request qua cuộn trang Chrome. Không coi HTTP 200 rỗng là hết dữ liệu.
- Luồng tìm danh sách và luồng tải chạy đồng thời. Hàng đợi trong `archive/queues/` chỉ lưu URL video, ID, trạng thái, tác giả và cursor; không lưu cookie hoặc URL request chứa tham số phiên.
- Sau lượt hashtag, duyệt kênh các tác giả đã tìm được qua `/api/post/item_list/`, chỉ thêm video có đúng hashtag. Dùng `--no-profiles` để tắt bước bổ sung này.
- `exhausted` chỉ có nghĩa phản hồi hợp lệ báo `hasMore=false` cho nguồn đó. Nếu không tiến triển sau 10 lần thử, trạng thái là `retry`, không phải đã lấy đủ posts. Chạy lại sẽ đọc hàng đợi còn dở; thử cursor cũ rồi dùng phân trang Chrome nếu cursor không hoạt động.
- Video lỗi được giữ để thử lại lần chạy sau. Sau 10 lỗi tải liên tiếp, lượt tải dừng và hàng đợi được giữ nguyên.

## Kiểm tra ngắn

```powershell
npm run check
npm test
npm start -- --tag=livecanbeeasy --region=US --auto --discover-only --discovery-pages=3
npm start -- --tag=livecanbeeasy --region=US --auto --limit=1 --no-profiles
```

`--discover-only` chỉ tìm và lưu danh sách. `--discovery-pages` giới hạn số phản hồi phân trang để kiểm tra, đồng thời bỏ bước quét kênh; mặc định không giới hạn. `--limit` giới hạn số video tải thành công, không giới hạn số ID được phát hiện.

Cần Google Chrome và yt-dlp trong PATH; ffmpeg dùng khi ghép định dạng. Chrome dùng hồ sơ riêng `.chrome-profile/`. Nếu cần đăng nhập/xác minh, chạy `npm run login` hoặc bỏ `--auto` để thao tác trên Chrome. Chế độ auto báo lỗi khi gặp yêu cầu xác minh.

Mỗi video lưu trong `archive/@<username>/<id>/`: `video.mp4`, `metadata.json`, `channel.json`, `snapshots.jsonl`, `complete.json`. Video và hồ sơ Chrome không đưa lên Git. Chạy một collector/watch tại một thời điểm để tránh hai tiến trình ghi cùng hàng đợi.

Tổng posts Creative Center không phải cam kết số video truy cập được. Bộ lọc Việt Nam dùng tín hiệu metadata/ngôn ngữ/nội dung, không xác minh quốc tịch; có thể bỏ sót hoặc loại nhầm. `sourceRegion` là vùng khám phá, không phải quốc gia xác minh của tác giả. Chưa xác nhận có thể thu đủ toàn bộ posts của hashtag.

## Video tương thích Windows

Video tải mới được kiểm tra và chuyển sang H.264 (yuv420p) + AAC trước khi hoàn tất. File để xem là `video.mp4`; nếu phải chuyển mã, bản gốc giữ ở `video-original.mp4`. File đã tương thích không bị mã hóa lại. Cần `ffmpeg` và `ffprobe` trong PATH.

Chuyển kho cũ bằng `npm run convert:archive`. Script chỉ xử lý bản ghi đã hoàn tất, giữ bản gốc và báo lỗi riêng từng file. Không chạy hai lượt chuyển kho cùng lúc. Nếu bị tắt đột ngột, file `.convert.lock` còn lại cần kiểm tra tiến trình ffmpeg trước khi dọn và chạy lại.

## Cấu trúc thư mục theo kênh

```text
archive/
  @username/
    channel.json
    bio.txt
    <video-id>/
      video.mp4
      metadata.json
      snapshots.jsonl
      complete.json
      video-original.mp4 (nếu đã chuyển mã)
```

Metadata/bio kênh dùng chung ở thư mục `@username`. Bản `channel.json` cũ trong thư mục video được giữ lại khi di chuyển để bảo toàn dữ liệu lịch sử. `npm run migrate:archive` chuyển kho phẳng cũ sang cấu trúc này; collector cũng chuyển kho cũ khi khởi động. Công cụ chuyển codec hỗ trợ cấu trúc theo kênh. Dừng crawler và công cụ chuyển codec trước khi di chuyển kho.
