# Claude Session Sync — extension cho Antigravity / VS Code

Đồng bộ Claude Code session (chat history + memory + plans) giữa các máy qua Google Drive.
**1 click push** ở máy A → **1 click pull** ở máy B. Mã hoá AES-256 client-side, không cần USB, không cần GitHub.

## Tính năng

- 🔐 **Mã hoá end-to-end** — file đẩy lên Drive đã mã hoá AES-256-GCM trước khi rời máy. Google không đọc được nội dung.
- ☁️ **Drive scope hẹp** — extension chỉ thấy file nó tự tạo (`drive.file`), không động đến Drive khác của anh.
- 🧠 **Tự động fix path mismatch** — máy nhà ở `D:\Project`, máy cty ở `C:\dev\Project`? Khi pull về extension tự rewrite đường dẫn trong JSONL.
- 🔁 **Chọn snapshot khi pull** — không tự động đè máy hiện tại, anh chọn version nào để restore.
- 🆔 **Hash folder đúng** — dùng đúng thuật toán Claude Code dùng nội bộ (lowercase ổ đĩa, mọi ký tự non-alphanumeric thành `-`), khắc phục bug folder hash sai trong script PowerShell legacy.

## Build & cài

### Yêu cầu

- **Node.js ≥ 18** ([tải về](https://nodejs.org/en/download)) — cài 1 lần, click Next hết, Install.
- **Antigravity** hoặc **VS Code**

### Build (1 lệnh)

Mở PowerShell ở folder `tools/claude-session-sync/`:

```powershell
.\build.ps1
```

Script sẽ:
1. Check Node.js (báo lỗi nếu chưa cài + chỉ link tải)
2. `npm install` (chỉ chạy lần đầu, ~1-2 phút)
3. Bundle TypeScript bằng esbuild
4. Đóng gói thành `claude-session-sync.vsix`
5. Cài thẳng vào Antigravity qua CLI (nếu phát hiện)

Nếu không tự cài được thì:
- Mở Antigravity
- `Ctrl+Shift+P` → gõ "Install from VSIX"
- Chọn file `claude-session-sync.vsix` vừa build

Reload window là xong.

## Cách dùng

### Lần đầu (mỗi máy)

1. Status bar góc dưới phải sẽ thấy `☁ Claude Sync` → click vào
2. Chọn **"Đăng nhập Google"** → browser mở → chọn account → có thể thấy cảnh báo "Google chưa verify app này" (vì đang ở chế độ unverified, chỉ <100 user) → click **Advanced → Continue**
3. Chọn **"Đặt passphrase"** → nhập 1 mật khẩu để mã hoá file (≥ 8 ký tự). Lưu lại — mất passphrase = mất hết file đã đẩy.

### Push (máy nguồn)

- Click `☁` trên status bar → **"Push session lên Drive"**
- Hoặc `Ctrl+Shift+P` → **"Claude Sync: Push"**

Extension sẽ: export session → mã hoá → upload lên `Google Drive/ClaudeCodeSync/<project-hash>/session-<máy>-<thời gian>.csz`

### Pull (máy đích)

- Mở project ở đường dẫn bất kỳ (extension tự fix path)
- Click `☁` → **"Pull session từ Drive"**
- Chọn snapshot từ list (mới nhất ở trên)
- Nhập passphrase → giải mã → import → reload window

### Đăng xuất / đổi passphrase

Status bar `☁` → menu → chọn item tương ứng.

## Cấu trúc file Drive

```
Google Drive (của anh)
└── ClaudeCodeSync/                        ← config được, mặc định
    └── d--Cad-translator-pro-v20/         ← hash của project path
        ├── session-MAYNHA-2026-04-28T07-46.csz
        ├── session-MAYCTY-2026-04-28T13-05.csz
        └── ...
```

`.csz` = Claude Sync Encrypted. Format: header 48 byte (magic + salt + IV + authTag) + ciphertext AES-256-GCM. Key derive bằng scrypt từ passphrase.

## Setup phía Google Cloud (đã làm sẵn cho user của project này)

Extension dùng OAuth client `cad-translator-auth` đã có sẵn trong `core/_google_creds.py`. Để extension hoạt động, project Google Cloud cần:

1. **Enable Google Drive API**: https://console.cloud.google.com/apis/library/drive.googleapis.com → chọn project `cad-translator-auth` → Enable
2. **Add scope `auth/drive.file`** vào OAuth consent screen: APIs & Services → OAuth consent screen → Edit → Scopes → add `https://www.googleapis.com/auth/drive.file`

Bước 1 và 2 chỉ làm 1 lần cho cả project. Sau đó mọi user cài extension đều dùng được luôn.

## Known limits

- **Unverified app**: tối đa 100 user (giai đoạn chưa submit Google verification). Vượt → submit verification (4-6 tuần).
- **Quota Drive API**: 1 tỷ request/ngày — không bao giờ chạm trong use case này.
- **File size**: chunked resumable upload, OK đến vài GB. Session zip thường 30-100MB.

## Troubleshooting

**"Không bind được port 54321"** — App khác đang dùng. Đóng nó (thường là chính core Python app `core/google_oauth.py` đang chạy) rồi thử lại.

**"Sai passphrase hoặc file đã hỏng"** — passphrase nhập sai, hoặc file `.csz` được mã hoá bằng passphrase khác (xảy ra nếu anh đổi passphrase giữa các máy).

**Pull xong nhưng Antigravity không thấy session** — Reload window (Ctrl+Shift+P → "Developer: Reload Window"). Nếu vẫn không thấy, kiểm tra folder `~/.claude/projects/<hash>/` có file `.jsonl` không.

## Roadmap

- [ ] Auto-push khi đóng VS Code (đã có config flag, chưa wire)
- [ ] Auto-pull mỗi N phút
- [ ] Conflict resolution khi 2 máy push cùng lúc
- [ ] Hỗ trợ scope rộng hơn nếu user muốn (đổi `drive.file` → `drive.appdata`)
