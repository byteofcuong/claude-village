# claude-village

Làng 3D trên những hòn đảo bay để quan sát Claude Code làm việc. Mỗi project là một đảo có nhà, mỗi session là một người dân, mỗi subagent là một người phụ việc. Làng đổi theo giờ thật: sáng, trưa, chiều, tối.

Game chỉ xem, không điều khiển. Nó chỉ đọc `~/.claude`, chạy trên `127.0.0.1`, không gửi gì ra ngoài máy, và không đưa nội dung prompt, thinking hay lệnh Bash xuống trình duyệt.

## Chạy

Cần Node 22 trở lên. Model không nằm trong repo: tải các gói trong [assets/LICENSES.md](assets/LICENSES.md) vào `assets-src/`, rồi chạy (PowerShell hoặc Git Bash):

```bash
npm install
```

```bash
npm run assets
```

```bash
npm start
```

Mở `http://127.0.0.1:4717`. Kéo để xoay, cuộn để phóng to, click vào người dân để xem chi tiết. Nút "Tua nhanh một ngày" xem cả ngày trong 3 phút.

Muốn xem thử không cần session thật: `http://127.0.0.1:4717/?demo=stress`.

## Người dân đang làm gì

| Việc của Claude | Trong làng |
|---|---|
| Suy nghĩ | Ngồi ngắm trời 💭 |
| Đọc file, tìm kiếm trong code | Cầm sách 📖 |
| Sửa file | Đóng búa, cưa gỗ 🔨 |
| Chạy lệnh | Làm việc ở lò ⚙️ |
| Tìm trên mạng | Chống gậy đi quanh đảo 🧭 |
| Giao việc cho subagent | Vẫy tay, hô hào 📣 |
| Tool khác | Dùng đồ nghề 🧰 |
| Tool chạy lâu | Đào, cưa ở lò ⏳ |
| Vừa gặp lỗi | Giật mình ❗ |
| Đang chờ | Nghỉ ngơi, uống trà, tập thể dục 🍵 |
| Process đã tắt | Nằm ngủ 💤 |

"Đang chờ bạn duyệt quyền" chưa có tín hiệu đáng tin nên chưa hiển thị riêng.

## Kiểm tra

```bash
npm run typecheck
```

```bash
npm run coverage
```

```bash
npm run build
```

```bash
node scripts/e2e.mjs
```

```bash
npm run perf
```

`e2e` và `perf` mở Microsoft Edge có giao diện.
