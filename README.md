# TikTok Snap

Tool nội bộ chạy bằng Node.js và Google Chrome. Mặc định mở hashtag `#fyp`, tự lướt, mở video, tải MP4 và lưu bio kênh. Không duyệt từng video.

```powershell
cd D:\Downloads\tiktok_snap
npm install
npm start
```

Chạy liên tục nhiều nguồn bằng một lệnh:

```powershell
npm run watch
```

Cấu hình nằm trong `watch.config.json`: `sources` chia hashtag theo khu vực và ngôn ngữ, `limitPerTag` là số video xử lý mỗi hashtag trong một chu kỳ, và `intervalMinutes` là thời gian giữa các chu kỳ. Trước mỗi chu kỳ, `discover.mjs` mở TikTok Creative Center, lấy hashtag đang nổi trong 7 ngày cho từng vùng rồi gộp với danh sách cố định. `tagsPerRegion` điều chỉnh số hashtag động mỗi vùng. Nếu nguồn chính thức lỗi, crawler dùng danh sách cố định. Lần đầu tool chờ anh xác minh rồi nhấn Enter; các lượt sau tự chạy. Nhấn Ctrl+C để dừng.

Mỗi lượt gửi ngôn ngữ phù hợp và ghi `sourceRegion` vào metadata. Đây là chiến lược khám phá đa khu vực, không phải giả lập IP: TikTok vẫn có thể cá nhân hóa theo IP Việt Nam. Muốn kết quả độc lập theo quốc gia cần proxy hợp lệ ở từng khu vực hoặc nguồn dữ liệu chính thức. TikTok Creative Center là nguồn chính thức để đối chiếu hashtag, video và creator đang nổi theo vùng.

Tool tự mở Google Chrome với hồ sơ `.chrome-profile/` và cổng debug nếu chưa có Chrome debug. Anh chỉ cần xác minh/mở TikTok trên cửa sổ đó rồi nhấn Enter ở terminal. Lấy video theo thứ tự hiển thị từ trên xuống, trái sang phải từng hàng.

Video được tải bằng `yt-dlp` với format tốt nhất mà TikTok cung cấp, ưu tiên nguồn không watermark khi extractor có nguồn đó. Máy hiện tại đã có `yt-dlp` và `ffmpeg`; có thể cập nhật bằng `yt-dlp -U`. TikTok quyết định các format trả về nên không thể bảo đảm mọi video đều có bản không watermark.

```powershell
npm start -- --tag fyp --limit 20
```

Mỗi video nằm trong `archive/<video-id>/`: `video.mp4`, `metadata.json` (caption, link, số liệu), `channel.json` (bio và số liệu kênh nếu có), `snapshots.jsonl` (lịch sử tương tác), `complete.json`. Chế độ `watch` cập nhật snapshot của video gặp lại nhưng không tải lại MP4. Bản ghi lỗi giữ dữ liệu đã lấy và thử lại; lỗi ghi trong `archive/errors.jsonl`.

Giới hạn mặc định 20 video mới mỗi lượt; tìm tối đa 30 vòng cuộn và dừng khi không có kết quả mới. Có thể lưu ít hơn giới hạn. Hiện lấy theo thứ tự TikTok hiển thị trên trang hashtag, chưa xếp hạng toàn bộ hashtag theo lượt xem. Số liệu là ảnh chụp tại thời điểm thu thập.

Nếu phát hiện trang đăng nhập hoặc CAPTCHA giữa lượt chạy, tool đưa tab ra trước và chờ anh xử lý rồi nhấn Enter để tiếp tục. Việc phát hiện phụ thuộc cấu trúc trang TikTok; nếu thông báo xác minh thay đổi, tool có thể chưa nhận diện được. Tool dừng sau 5 video lỗi liên tiếp để tránh lặp hàng loạt lỗi. Không coi bản ghi thiếu video/bio là hoàn tất. Chưa xác minh tải đầu cuối trong chế độ khách.

Tham khảo API trình duyệt: https://playwright.dev/docs/api/class-browsercontext

Hồ sơ riêng giữ cookie và trạng thái xác minh nếu TikTok cấp; không sao chép hồ sơ Chrome cá nhân. Không chia sẻ thư mục hồ sơ. Thay đổi này chưa được xác nhận khắc phục Access Denied; nếu trang vẫn bị chặn, tool chờ và không thu thập.
