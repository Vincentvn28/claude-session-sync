# Claude Session Sync — extension for Antigravity / VS Code / Cursor / Windsurf

Sync Claude Code sessions (chat history + memory + plans) across machines via Google Drive.
**1-click push** on machine A → **1-click pull** on machine B. Client-side AES-256 encrypted, no USB, no GitHub required.

## Features

- 🔐 **End-to-end encrypted** — files are AES-256-GCM encrypted before they leave your machine. Google can't read the contents.
- ☁️ **Narrow Drive scope** — uses `drive.file` so the extension can only see files it created itself, never your other Drive files.
- 🧠 **Auto-fix path mismatch** — home machine at `D:\Project`, work machine at `C:\dev\Project`? On pull the extension rewrites paths inside the JSONL automatically.
- 🔁 **Choose snapshot on pull** — never auto-overwrites the current machine; you pick which version to restore.
- 🆔 **Correct folder hashing** — uses the same algorithm Claude Code uses internally (lowercase drive letter, all non-alphanumeric → `-`), fixing the wrong-hash bug present in legacy PowerShell scripts.

## Install

### From Open VSX (Antigravity, Cursor, Windsurf, VSCodium)

Open Extensions panel (Ctrl+Shift+X) → search **"claude session sync"** → Install.

Or via CLI:

```bash
antigravity --install-extension Vincentvn28.claude-session-sync
# Cursor / Windsurf / VSCodium — same command with their respective binary
```

### From VSIX (VS Code or any fork)

Download `claude-session-sync.vsix` from [GitHub Releases](https://github.com/Vincentvn28/claude-session-sync/releases) and:

```bash
code --install-extension claude-session-sync.vsix
```

## Usage

### First time (each machine)

1. Click `☁ Claude Sync` in the bottom-right status bar
2. Choose **"Sign in with Google"** → browser opens → pick your account → you may see a warning *"Google hasn't verified this app"* (because it's in unverified mode, capped at <100 users) → click **Advanced → Continue**
3. Choose **"Set passphrase"** → enter a password to encrypt the file (≥ 8 characters). **Save it** — losing the passphrase means losing access to all uploaded files.

### Push (source machine)

- Click `☁` in the status bar → **"Push session to Drive"**
- Or `Ctrl+Shift+P` → **"Claude Sync: Push"**

The extension exports the session → encrypts it → uploads to `Google Drive/ClaudeCodeSync/<file>.csz`.

### Pull (target machine)

- Open the project at any path (the extension auto-fixes paths)
- Click `☁` → **"Pull session from Drive"**
- Pick a snapshot from the list (newest first)
- Enter passphrase → decrypt → import → reload window

### Sign out / change passphrase

Status bar `☁` → menu → pick the corresponding item.

## Drive file structure

```
Google Drive (yours)
└── ClaudeCodeSync/                              ← configurable; default name
    ├── 20260428 1830 Refactor auth flow.csz    ← format: YYYYMMDD HHmm <title>.csz
    ├── 20260428 1305 Add export feature.csz
    └── ...
```

`.csz` = **C**laude **S**ync **E**ncrypted. Format: 48-byte header (magic + salt + IV + authTag) + AES-256-GCM ciphertext. Key is derived via scrypt from your passphrase.

Sessions are de-duplicated by their internal `sessionId` (stored in Drive `appProperties`), not by filename — so re-pushing the same session overwrites cleanly instead of accumulating duplicates.

## Google Cloud setup (already done for users of this extension)

The extension uses an OAuth client embedded in the source. For the extension to work, the underlying Google Cloud project needs:

1. **Drive API enabled**: https://console.cloud.google.com/apis/library/drive.googleapis.com → Enable on the project
2. **Add scope `auth/drive.file`** to the OAuth consent screen: APIs & Services → OAuth consent screen → Edit → Scopes → add `https://www.googleapis.com/auth/drive.file`

Steps 1 and 2 are done once per project. After that every user who installs the extension can use it directly.

## Known limits

- **Unverified app**: max 100 users while we haven't submitted Google verification yet. Beyond that → submit verification (~4-6 weeks).
- **Drive API quota**: 1 billion requests/day — never relevant for this use case.
- **File size**: chunked resumable upload — OK up to several GB. Session zips are typically 30–100MB.

## Troubleshooting

**"Cannot bind port 54321"** — another app is using it. Close it (often the Python core app `core/google_oauth.py`) and try again.

**"Wrong passphrase or file is corrupted"** — passphrase is wrong, or the `.csz` file was encrypted with a different passphrase (happens if you changed passphrase between machines).

**Pull succeeded but the IDE doesn't see the session** — Reload the window (Ctrl+Shift+P → "Developer: Reload Window"). If still not visible, check that the folder `~/.claude/projects/<hash>/` contains the `.jsonl` file.

## Build from source

Requires Node.js ≥ 18.

```bash
git clone https://github.com/Vincentvn28/claude-session-sync.git
cd claude-session-sync
npm install
npm run build      # bundle TypeScript with esbuild
npm run package    # produce claude-session-sync.vsix
```

Or one-shot via the included PowerShell script:

```powershell
.\build.ps1
```

The script handles the dependency check, build, package, and auto-installs into Antigravity if its CLI is found.

## Roadmap

- [ ] Auto-push on window close (config flag exists, not yet wired)
- [ ] Auto-pull every N minutes
- [ ] Conflict resolution when 2 machines push simultaneously
- [ ] Wider scope option (`drive.file` → `drive.appdata`) for users who want it

## License

[MIT](LICENSE)
