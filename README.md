# TikTok Snap

Crawler Node.js + Chrome: lấy danh sách video qua JSON phân trang, lưu hàng đợi trên đĩa và tải MP4 bằng yt-dlp. Mặc định chỉ tải mới, bỏ qua video hoàn tất, không cập nhật snapshot cũ. Bộ lọc nguồn/nội dung Việt Nam vẫn áp dụng.

## Dashboard local

```powershell
npm run dashboard
```

Mở `http://localhost:4313`. Lần chạy đầu, terminal in mật khẩu ngẫu nhiên cho tài khoản `admin` và lưu mật khẩu trong `.dashboard-password` (file này bị Git bỏ qua). Sau khi đăng nhập bằng mật khẩu, dùng **Add passkey** để tạo passkey Windows Hello cho các lần đăng nhập sau. Dashboard hiển thị trạng thái crawler, số tiến trình, thống kê kho/queue, các nút Start, Stop, system check và terminal log trực tiếp. Server mặc định chỉ lắng nghe trên máy local; có thể đặt `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `DASHBOARD_HOST` và `DASHBOARD_PORT` bằng biến môi trường.

```powershell
npm start -- --tag=livecanbeeasy --region=US --lang=en-US --limit=all --auto
```

`npm run watch` chạy tự động, khám phá hashtag trending rồi chạy từng nguồn trong `watch.config.json`. Kết quả Creative Center còn mới được dùng lại theo `creativeCenter.cacheMinutes` (mặc định 12 giờ), vì vậy restart worker không phải chờ quét lại 14 khu vực. `limitPerTag: "all"` không giới hạn số video. Không có giới hạn 30 vòng cuộn. Nếu TikTok yêu cầu đăng nhập/xác minh, dùng `npm run login` một lần trước khi bật watch.

Chế độ watch mặc định chạy **Super Sweep**: lấy toàn bộ hashtag công khai đọc được từ Creative Center ở từng khu vực, theo cursor của feed cho đến khi API xác nhận `hasMore=false`. Chỉ cần một kênh xuất hiện trong hashtag, crawler chuyển sang `/api/post/item_list/` và lấy toàn bộ video công khai của kênh đó, không giới hạn ở hashtag ban đầu. Profile cũng được phân trang đến `hasMore=false`; cursor được lưu sau mỗi trang và nguồn đứng/lỗi được đánh dấu `retry` để chạy tiếp. Một kênh lỗi không làm dừng các kênh còn lại.

## Cách lấy dữ liệu

- Bắt JSON `/api/challenge/item_list/` của đúng tab hashtag, lưu ID và cursor sau mỗi trang trước khi tải.
- Thử cursor bằng phiên Chrome hiện tại. Nếu phản hồi rỗng/không hợp lệ, tiếp tục phát sinh request qua cuộn trang Chrome. Không coi HTTP 200 rỗng là hết dữ liệu.
- Luồng tìm danh sách và luồng tải chạy đồng thời. Hàng đợi trong `archive/queues/` chỉ lưu URL video, ID, trạng thái, tác giả và cursor; không lưu cookie hoặc URL request chứa tham số phiên.
- Downloader ưu tiên URL MP4 có chữ ký bắt được ngay trong JSON feed và stream thẳng xuống đĩa; chỉ mở trang video và gọi yt-dlp khi feed không còn metadata dùng được. Có thể kiểm tra từng ID bằng `npm run probe:api -- <video-id> <hashtag>`.
- Một collector điều phối pool tải thay vì chạy nhiều collector tranh cùng queue: `downloadConcurrency` mặc định tải 3 media CDN song song, `verifyConcurrency` cho phép tối đa 2 lượt FFmpeg. Mở trang video và yt-dlp fallback luôn được khóa ở 1 luồng; mọi cập nhật queue vẫn được tuần tự hóa trong cùng tiến trình.
- Sau lượt hashtag, Super Sweep duyệt kênh từng tác giả qua `/api/post/item_list/` và thêm mọi video công khai đọc được. Dùng `--no-profiles` để tắt bước mở rộng toàn kênh.
- `exhausted` chỉ có nghĩa phản hồi hợp lệ báo `hasMore=false` cho nguồn đó. Nếu feed đứng hết ngưỡng quét, trạng thái là `retry`, không phải đã lấy đủ posts. Chạy lại sẽ đọc hàng đợi còn dở; thử cursor cũ rồi dùng phân trang Chrome nếu cursor không hoạt động.
- Mỗi cursor được thử lại tối đa 4 lần trong phiên Chrome. Hashtag chịu tối đa 30 nhịp không tiến triển; từng kênh chịu tối đa 15 nhịp để một kênh bị chặn không giữ cả lượt quét vô hạn.
- `profileBacklogLimit` giữ số media URL đang chờ ở mức an toàn để tải nhanh trước khi chữ ký CDN hết hạn. `profilePageBudget: "all"` và `profileNoAddPages: "all"` buộc mỗi profile tiếp tục đến khi API báo `hasMore=false`; nếu nguồn đứng hoặc lỗi, cursor đã lưu sẽ được retry.
- Sau 10 lỗi tải liên tiếp, collector nghỉ theo cấp số rồi tiếp tục với ID còn lại thay vì kết thúc nguồn. `failureCooldownSeconds` trong `watch.config.json` đặt thời gian nghỉ ban đầu.
- Video lỗi được giữ để thử lại lần chạy sau. Sau 10 lỗi tải liên tiếp, collector nghỉ theo cấp số rồi tiếp tục hàng đợi.

## Kiểm tra ngắn

```powershell
npm run check
npm test
npm start -- --tag=livecanbeeasy --region=US --auto --discover-only --discovery-pages=3
npm start -- --tag=livecanbeeasy --region=US --auto --limit=1 --no-profiles
```

`--discover-only` chỉ tìm và lưu danh sách. `--discovery-pages` giới hạn số phản hồi phân trang để kiểm tra, đồng thời bỏ bước quét kênh; mặc định không giới hạn. `--limit` giới hạn số video tải thành công, không giới hạn số ID được phát hiện.

Cần Google Chrome và yt-dlp trong PATH; ffmpeg dùng khi ghép định dạng. Chrome dùng hồ sơ riêng `.chrome-profile/`. Nếu cần đăng nhập/xác minh, chạy `npm run login` hoặc bỏ `--auto` để thao tác trên Chrome. Chế độ auto báo lỗi khi gặp yêu cầu xác minh.

Mỗi thư mục `archive/@<username>/<id>/` chỉ giữ `video-original.mp4`. Metadata dùng trong lúc tải sẽ được dọn sau khi video hoàn tất; thông tin kênh dùng chung nằm ở thư mục `@username`. Video và hồ sơ Chrome không đưa lên Git. Chạy một collector/watch tại một thời điểm để tránh hai tiến trình ghi cùng hàng đợi.

Tổng posts Creative Center không phải cam kết số video truy cập được. Bộ lọc Việt Nam dùng tín hiệu metadata/ngôn ngữ/nội dung, không xác minh quốc tịch; có thể bỏ sót hoặc loại nhầm. `sourceRegion` là vùng khám phá, không phải quốc gia xác minh của tác giả. Chưa xác nhận có thể thu đủ toàn bộ posts của hashtag.

## Video tương thích Windows

Video tải mới được kiểm tra và chuyển sang H.264 (yuv420p) + AAC trước khi hoàn tất. File để xem luôn là `video-original.mp4`; các bản tải tạm, metadata cấp video và file trung gian được xóa sau khi xác nhận giải mã toàn bộ thành công. File đã tương thích không bị mã hóa lại. Cần `ffmpeg` và `ffprobe` trong PATH.

Chuyển và dọn kho cũ bằng `npm run convert:archive`. Script tìm bản video còn đọc được trong từng ID, chuẩn hóa thành `video-original.mp4`, chỉ dọn phần dư sau khi file kết quả vượt qua kiểm tra và báo lỗi riêng từng ID. Không chạy hai lượt chuyển kho cùng lúc. Nếu bị tắt đột ngột, cần kiểm tra tiến trình ffmpeg trước khi xóa `.finalize.lock` và chạy lại.

## Cấu trúc thư mục theo kênh

```text
archive/
  @username/
    channel.json
    bio.txt
    <video-id>/
      video-original.mp4
```

Metadata/bio kênh dùng chung ở thư mục `@username`. `channel.json` giữ TikTok ID, secUid, username, nickname, bio, verified/private state, avatar URLs, interaction settings, follower/following/heart/video counts, nguồn khám phá và thời điểm chụp. Trường `superSweep` ghi cursor, số video tìm thấy trên profile và chỉ có trạng thái `exhausted` khi API đã trả `hasMore=false`. `npm run migrate:archive` chuyển kho phẳng cũ sang cấu trúc này; collector cũng chuyển kho cũ khi khởi động. Công cụ chuyển codec hỗ trợ cấu trúc theo kênh. Dừng crawler và công cụ chuyển codec trước khi di chuyển kho.
