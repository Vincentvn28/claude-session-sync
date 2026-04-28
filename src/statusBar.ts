import * as vscode from 'vscode';

export class SyncStatusBar {
  private item: vscode.StatusBarItem;
  private lastSync: number | null = null;
  private signedInEmail: string | undefined;
  private busyText: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.item.command = 'claudeSync.showMenu';
    this.item.show();
    this.refresh();
    // refresh "Last 5m ago" every minute
    this.timer = setInterval(() => this.refresh(), 60_000);
  }

  setSignedIn(email: string | undefined): void {
    this.signedInEmail = email;
    this.refresh();
  }

  setLastSync(ts: number): void {
    this.lastSync = ts;
    this.refresh();
  }

  setBusy(label: string | null): void {
    this.busyText = label;
    this.refresh();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  private refresh(): void {
    if (this.busyText) {
      this.item.text = `$(sync~spin) ${this.busyText}`;
      this.item.tooltip = 'Claude Sync đang chạy…';
      return;
    }
    if (!this.signedInEmail) {
      this.item.text = `$(cloud) Claude Sync`;
      this.item.tooltip = new vscode.MarkdownString(
        '**Claude Sync** — chưa đăng nhập\n\nClick để đăng nhập Google.',
      );
      return;
    }
    const lastLabel = this.lastSync
      ? humanRelative(this.lastSync)
      : 'chưa sync';
    this.item.text = `$(cloud) ${lastLabel}`;
    const md = new vscode.MarkdownString(
      `**Claude Sync** — ${this.signedInEmail}\n\nLần sync cuối: ${lastLabel}\n\nClick để hiện menu.`,
    );
    md.isTrusted = true;
    this.item.tooltip = md;
  }
}

function humanRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'vừa xong';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m trước`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / 3600_000)}h trước`;
  return `${Math.round(diff / 86_400_000)} ngày trước`;
}
