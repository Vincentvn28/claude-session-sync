# Claude Session Sync — extension for Antigravity / VS Code / Cursor / Windsurf

Sync Claude Code sessions (chat history + memory + plans) across machines via Google Drive.
**1-click push** on machine A → **1-click pull** on machine B. No passphrase, no USB, no GitHub required.

## Features

- ☁️ **Narrow Drive scope** — uses `drive.file` so the extension can only see files it created itself, never your other Drive files.
- 🧠 **Auto-fix path mismatch** — home machine at `D:\Project`, work machine at `C:\dev\Project`? On pull the extension rewrites paths inside the JSONL automatically.
- 🔁 **Choose snapshot on pull** — never auto-overwrites the current machine; you pick which version to restore.
- 📦 **Import from local file** — pick any `.zip` exported by the extension and import it into a target project of your choice (current workspace, a detected project, or any folder).
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

### Push (source machine)

- Click `☁` in the status bar → **"Push session to Drive"**
- Or `Ctrl+Shift+P` → **"Claude Sync: Push"**

The extension exports the session and uploads it to `Google Drive/ClaudeCodeSync/<file>.zip`.

### Pull (target machine)

- Open the project at any path (the extension auto-fixes paths)
- Click `☁` → **"Pull session from Drive"**
- Pick a snapshot from the list (newest first)
- Download → import → reload window

### Import from a local file

If you have a `.zip` you downloaded from Drive (or got via any other channel) and want to import it into a specific project:

- Click `☁` → **"Import session from local .zip file"**
- Pick the file(s) → pick the target project (current workspace, a detected project, or Browse) → confirm

### Sign out

Status bar `☁` → menu → **"Sign out of Google"**.

## Drive file structure

```
Google Drive (yours)
└── ClaudeCodeSync/                              ← configurable; default name
    ├── 20260428 1830 Refactor auth flow.zip    ← format: YYYYMMDD HHmm <title>.zip
    ├── 20260428 1305 Add export feature.zip
    └── ...
```

Each `.zip` is a plain archive with the session's `.jsonl`, the project's `memory/` folder, the global `plans/` folder, and a `manifest.json`. Drive's `drive.file` scope means only this app can list these files via the API; no client-side encryption is applied. If you need stronger isolation, share the Drive folder with no one and treat it as your personal backup.

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
- [ ] Optional client-side encryption (off by default; opt-in for users who want it back)

## License

[MIT](LICENSE)
