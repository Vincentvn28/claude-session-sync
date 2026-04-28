import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GoogleAuth } from './auth';
import { DriveClient, DriveFile } from './drive';
import { listAllSessions, exportOneSession, SessionInfo } from './exporter';
import { importOneSession } from './importer';
import { encryptFile, decryptFile } from './crypto';
import { SyncStatusBar } from './statusBar';
import { machineId, getClaudeProjectHash } from './pathUtils';

const PASSPHRASE_KEY = 'claudeSync.passphrase';
const LAST_SYNC_KEY = 'claudeSync.lastSync';
const FILE_EXT = '.csz';

let auth: GoogleAuth;
let drive: DriveClient;
let statusBar: SyncStatusBar;
let lastSyncMs: number | null = null;
let output: vscode.OutputChannel;

function logInfo(msg: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function logError(label: string, e: unknown): void {
  const err = e as Error;
  output.appendLine(`[${new Date().toISOString()}] ${label}`);
  output.appendLine(`  message: ${err?.message ?? e}`);
  if (err?.stack) output.appendLine(`  stack: ${err.stack}`);
  output.appendLine('');
  output.show(true);
}

export async function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Claude Session Sync');
  ctx.subscriptions.push(output);
  logInfo(`boot · node=${process.version} platform=${process.platform}`);

  auth = new GoogleAuth(ctx.secrets);
  drive = new DriveClient(async () => {
    const t = await auth.getAccessToken();
    if (!t) throw new Error('Chưa đăng nhập Google. Chạy "Claude Sync: Đăng nhập Google".');
    return t;
  });
  statusBar = new SyncStatusBar();
  ctx.subscriptions.push(statusBar);

  lastSyncMs = ctx.globalState.get<number | null>(LAST_SYNC_KEY, null);
  if (lastSyncMs) statusBar.setLastSync(lastSyncMs);
  statusBar.setSignedIn(await auth.getEmail());

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeSync.signIn', () => signIn()),
    vscode.commands.registerCommand('claudeSync.signOut', () => signOut()),
    vscode.commands.registerCommand('claudeSync.push', () => pushSessions(ctx)),
    vscode.commands.registerCommand('claudeSync.pull', () => pullSessions(ctx)),
    vscode.commands.registerCommand('claudeSync.setPassphrase', () => setPassphrase(ctx)),
    vscode.commands.registerCommand('claudeSync.openDriveFolder', () => openDriveFolder()),
    vscode.commands.registerCommand('claudeSync.showMenu', () => showMenu(ctx)),
  );
}

export function deactivate() { /* nothing */ }

function currentWorkspacePath(): string | null {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) return null;
  return f.uri.fsPath;
}

async function signIn(): Promise<void> {
  try {
    statusBar.setBusy('Đang mở browser…');
    const email = await auth.signIn();
    statusBar.setBusy(null);
    statusBar.setSignedIn(email);
    vscode.window.showInformationMessage(
      email ? `Đã đăng nhập Google: ${email}` : 'Đã đăng nhập Google.',
    );
  } catch (e) {
    statusBar.setBusy(null);
    logError('signIn failed', e);
    vscode.window.showErrorMessage(`Đăng nhập thất bại: ${(e as Error).message}`);
  }
}

async function signOut(): Promise<void> {
  await auth.signOut();
  statusBar.setSignedIn(undefined);
  vscode.window.showInformationMessage('Đã đăng xuất Google.');
}

async function ensureSignedIn(): Promise<boolean> {
  if (await auth.isSignedIn()) return true;
  const pick = await vscode.window.showInformationMessage(
    'Chưa đăng nhập Google. Đăng nhập ngay?',
    'Đăng nhập',
    'Huỷ',
  );
  if (pick !== 'Đăng nhập') return false;
  try {
    await signIn();
    return await auth.isSignedIn();
  } catch {
    return false;
  }
}

async function getOrAskPassphrase(
  ctx: vscode.ExtensionContext,
  forNew: boolean,
): Promise<string | null> {
  let pass = await ctx.secrets.get(PASSPHRASE_KEY);
  if (pass) return pass;

  const prompt = forNew
    ? 'Đặt passphrase mã hoá (≥ 8 ký tự). Mất passphrase = mất tất cả file đã đẩy.'
    : 'Nhập passphrase đã đặt khi push session lần đầu.';
  pass = await vscode.window.showInputBox({
    prompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length < 8 ? 'Tối thiểu 8 ký tự.' : null),
  });
  if (!pass) return null;

  if (forNew) {
    const confirm = await vscode.window.showInputBox({
      prompt: 'Nhập lại passphrase để xác nhận.',
      password: true,
      ignoreFocusOut: true,
    });
    if (confirm !== pass) {
      vscode.window.showErrorMessage('Passphrase không khớp.');
      return null;
    }
  }
  await ctx.secrets.store(PASSPHRASE_KEY, pass);
  return pass;
}

async function setPassphrase(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(PASSPHRASE_KEY);
  await getOrAskPassphrase(ctx, true);
  vscode.window.showInformationMessage('Đã lưu passphrase mới.');
}

async function ensureRootFolder(folderName: string): Promise<string> {
  return await drive.ensureFolder(folderName);
}

interface SessionPickItem extends vscode.QuickPickItem {
  session: SessionInfo;
}

async function pickSessionsToPush(): Promise<SessionInfo[] | null> {
  const ws = currentWorkspacePath();
  if (!ws) {
    vscode.window.showWarningMessage(
      'Chưa mở folder/workspace nào. Mở project rồi push lại — extension chỉ push session của project đang mở.',
    );
    return null;
  }
  const projectHash = getClaudeProjectHash(ws);
  const all = await listAllSessions(projectHash);
  if (all.length === 0) {
    vscode.window.showWarningMessage(
      `Không có session nào của project hiện tại (${projectHash}). ` +
      'Chat với Claude Code trong project này ít nhất 1 lần trước khi push.',
    );
    return null;
  }

  const items: SessionPickItem[] = all.map((s) => ({
    label: `$(comment-discussion) ${s.title || '(untitled)'}`,
    description: `${(s.sizeBytes / 1024 / 1024).toFixed(1)}MB`,
    detail: `sửa ${new Date(s.modifiedMs).toLocaleString()} · ${s.sessionId.slice(0, 8)}`,
    picked: true,
    session: s,
  }));

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Chọn session để push (project hiện tại — ${all.length} session)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picks || picks.length === 0) return null;
  return picks.map((p) => p.session);
}

async function pushSessions(ctx: vscode.ExtensionContext): Promise<void> {
  if (!(await ensureSignedIn())) return;

  const sessions = await pickSessionsToPush();
  if (!sessions) return;

  const passphrase = await getOrAskPassphrase(ctx, true);
  if (!passphrase) return;

  const folderName = vscode.workspace.getConfiguration('claudeSync')
    .get<string>('driveFolderName') || 'ClaudeCodeSync';
  const includeSettings = vscode.workspace.getConfiguration('claudeSync')
    .get<boolean>('includeSettings') ?? false;

  let succeeded = 0;
  let failed = 0;
  let totalBytes = 0;

  try {
    statusBar.setBusy('chuẩn bị');
    const rootId = await ensureRootFolder(folderName);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Claude Sync · Push', cancellable: true },
      async (progress, token) => {
        const total = sessions.length;
        for (let i = 0; i < total; i++) {
          if (token.isCancellationRequested) {
            logInfo(`push cancelled at ${i}/${total}`);
            break;
          }
          const s = sessions[i];
          progress.report({
            message: `(${i + 1}/${total}) ${s.title || s.sessionId.slice(0, 8)}`,
            increment: 100 / total,
          });
          statusBar.setBusy(`push ${i + 1}/${total}`);

          const tempZip = path.join(os.tmpdir(), `csync-${s.sessionId}.zip`);
          const encZip = path.join(os.tmpdir(), `csync-${s.sessionId}${FILE_EXT}`);
          try {
            const exp = await exportOneSession(s, tempZip, includeSettings);
            await encryptFile(tempZip, encZip, passphrase);

            // Replace existing Drive file for this sessionId so re-pushes
            // overwrite cleanly instead of accumulating duplicates.
            const existing = await drive.findBySessionId(rootId, s.sessionId);
            for (const old of existing) {
              await drive.deleteFile(old.id).catch((err) => {
                logInfo(`warn: could not delete old file ${old.id}: ${(err as Error).message}`);
              });
            }

            const stat = await fs.promises.stat(encZip);
            const projectName = s.sourcePath
              ? path.basename(s.sourcePath).toLowerCase()
              : '';
            await drive.uploadFile(
              encZip,
              rootId,
              s.fileName,
              {
                schema: 'claude-session-sync/v3',
                sessionId: s.sessionId,
                projectHash: s.projectHash,
                projectName,
                machine: machineId(),
                title: s.title.slice(0, 100),
                sourcePath: s.sourcePath ?? '',
                origSize: String(exp.sizeBytes),
              },
            );
            totalBytes += stat.size;
            succeeded++;
            logInfo(`push ok · ${s.fileName} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`);
          } catch (e) {
            failed++;
            logError(`push failed · ${s.fileName}`, e);
          } finally {
            await fs.promises.unlink(tempZip).catch(() => {});
            await fs.promises.unlink(encZip).catch(() => {});
          }
        }
      },
    );

    statusBar.setBusy(null);
    if (succeeded > 0) {
      lastSyncMs = Date.now();
      statusBar.setLastSync(lastSyncMs);
      ctx.globalState.update(LAST_SYNC_KEY, lastSyncMs);
    }

    const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
    if (failed === 0) {
      vscode.window.showInformationMessage(
        `✅ Push xong: ${succeeded} session · ${totalMB}MB → Drive/${folderName}`,
      );
    } else {
      vscode.window.showWarningMessage(
        `Push xong với lỗi: ${succeeded} OK, ${failed} fail. Xem Output → "Claude Session Sync".`,
      );
    }
  } catch (e) {
    statusBar.setBusy(null);
    logError('push (top-level) failed', e);
    vscode.window.showErrorMessage(
      `Push thất bại: ${(e as Error).message}. Xem Output → "Claude Session Sync".`,
    );
  }
}

interface RemotePickItem extends vscode.QuickPickItem {
  file: DriveFile;
}

async function pullSessions(ctx: vscode.ExtensionContext): Promise<void> {
  if (!(await ensureSignedIn())) return;
  const passphrase = await getOrAskPassphrase(ctx, false);
  if (!passphrase) return;

  const folderName = vscode.workspace.getConfiguration('claudeSync')
    .get<string>('driveFolderName') || 'ClaudeCodeSync';
  const ws = currentWorkspacePath();
  if (!ws) {
    vscode.window.showWarningMessage(
      'Chưa mở folder/workspace nào. Mở project rồi pull lại — extension chỉ pull session của project đang mở.',
    );
    return;
  }
  // Match by project NAME (folder basename, lowercase) instead of
  // project HASH because different machines have different absolute
  // paths — `D:\Project` and `C:\dev\Project` share name but not hash.
  // The whole point of this extension is to bridge that gap.
  const projectName = path.basename(ws).toLowerCase();

  let files: DriveFile[];
  try {
    statusBar.setBusy('list Drive');
    const rootId = await ensureRootFolder(folderName);
    const escapedName = projectName.replace(/'/g, "\\'");
    files = await drive.listFiles(
      rootId,
      `appProperties has { key='projectName' and value='${escapedName}' }`,
    );
    statusBar.setBusy(null);
  } catch (e) {
    statusBar.setBusy(null);
    logError('pull list failed', e);
    vscode.window.showErrorMessage(
      `Pull thất bại: ${(e as Error).message}. Xem Output → "Claude Session Sync".`,
    );
    return;
  }

  if (files.length === 0) {
    vscode.window.showWarningMessage(
      `Không có session nào cho project "${projectName}" trên Drive/${folderName}. ` +
      'Push từ máy khác trước. (Lưu ý: file đẩy lên trước v0.4 không có projectName, ' +
      'cần re-push từ máy nguồn để pull thấy.)',
    );
    return;
  }

  const items: RemotePickItem[] = files.map((f) => {
    const props = f.appProperties ?? {};
    const title =
      props.title ||
      // New format: `YYYYMMDD HHmm <title>.csz`
      f.name.replace(/^\d{8} \d{4} /, '').replace(/\.csz$/, '') ||
      // Legacy format: `<title>--<uuid8>.csz`
      f.name.replace(/--[a-f0-9]{8}\.csz$/, '');
    const machine = props.machine || '?';
    const sizeMB = f.size ? (Number(f.size) / 1024 / 1024).toFixed(1) + 'MB' : '';
    return {
      label: `$(comment-discussion) ${title}`,
      description: `${machine} · ${sizeMB}`,
      detail: f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '',
      picked: true,
      file: f,
    };
  });

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Chọn session để pull về (mặc định tất cả ${files.length} session)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picks || picks.length === 0) return;

  const confirm = await vscode.window.showWarningMessage(
    `Pull ${picks.length} session về máy này. Session UUID trùng với hiện có sẽ bị ĐÈ. Tiếp tục?`,
    { modal: true },
    'Pull',
  );
  if (confirm !== 'Pull') return;

  let succeeded = 0;
  let overwrote = 0;
  let failed = 0;
  let pathRewrites = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude Sync · Pull', cancellable: true },
    async (progress, token) => {
      const total = picks.length;
      for (let i = 0; i < total; i++) {
        if (token.isCancellationRequested) {
          logInfo(`pull cancelled at ${i}/${total}`);
          break;
        }
        const f = picks[i].file;
        progress.report({
          message: `(${i + 1}/${total}) ${f.name}`,
          increment: 100 / total,
        });
        statusBar.setBusy(`pull ${i + 1}/${total}`);

        const safeFn = f.name.replace(/[\\\/:*?"<>|]/g, '_');
        const encZip = path.join(os.tmpdir(), `csync-pull-${i}-${safeFn}`);
        const plainZip = encZip.replace(/\.csz$/, '.zip');
        try {
          await drive.downloadFile(f.id, encZip);
          await decryptFile(encZip, plainZip, passphrase);
          const r = await importOneSession({
            zipPath: plainZip,
            targetWorkspacePath: ws ?? undefined,
          });
          succeeded++;
          if (r.overwrote) overwrote++;
          pathRewrites += r.pathRewrites;
          logInfo(
            `pull ok · ${f.name} → ${r.jsonlPath}` +
            (r.overwrote ? ' (overwrote)' : '') +
            (r.pathRewrites > 0 ? ` (${r.pathRewrites} path rewrites)` : ''),
          );
        } catch (e) {
          failed++;
          logError(`pull failed · ${f.name}`, e);
        } finally {
          await fs.promises.unlink(encZip).catch(() => {});
          await fs.promises.unlink(plainZip).catch(() => {});
        }
      }
    },
  );

  statusBar.setBusy(null);
  if (succeeded > 0) {
    lastSyncMs = Date.now();
    statusBar.setLastSync(lastSyncMs);
    ctx.globalState.update(LAST_SYNC_KEY, lastSyncMs);
  }

  const summary =
    `${succeeded} session OK` +
    (overwrote > 0 ? ` (${overwrote} đè cũ)` : '') +
    (pathRewrites > 0 ? ` · ${pathRewrites} path rewritten` : '') +
    (failed > 0 ? ` · ${failed} fail` : '');

  if (succeeded > 0) {
    const reload = await vscode.window.showInformationMessage(
      `✅ Pull xong: ${summary}. Reload window để Claude Code nhận session mới.`,
      'Reload Window',
    );
    if (reload === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else {
    vscode.window.showErrorMessage(
      `Pull thất bại: ${summary}. Xem Output → "Claude Session Sync".`,
    );
  }
}

async function openDriveFolder(): Promise<void> {
  if (!(await ensureSignedIn())) return;
  const folderName = vscode.workspace.getConfiguration('claudeSync')
    .get<string>('driveFolderName') || 'ClaudeCodeSync';
  try {
    const rootId = await ensureRootFolder(folderName);
    await vscode.env.openExternal(
      vscode.Uri.parse(`https://drive.google.com/drive/folders/${rootId}`),
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Không mở được Drive: ${(e as Error).message}`);
  }
}

async function showMenu(ctx: vscode.ExtensionContext): Promise<void> {
  const signed = await auth.isSignedIn();
  const items: Array<vscode.QuickPickItem & { cmd: string }> = [
    { label: '$(cloud-upload) Push session lên Drive', description: 'mỗi session 1 file riêng', cmd: 'claudeSync.push' },
    { label: '$(cloud-download) Pull session từ Drive', description: 'chọn session muốn restore', cmd: 'claudeSync.pull' },
    { label: '$(folder) Mở folder Drive', cmd: 'claudeSync.openDriveFolder' },
    { label: '$(key) Đặt / đổi passphrase', cmd: 'claudeSync.setPassphrase' },
    signed
      ? { label: '$(sign-out) Đăng xuất Google', description: await auth.getEmail(), cmd: 'claudeSync.signOut' }
      : { label: '$(sign-in) Đăng nhập Google', cmd: 'claudeSync.signIn' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Claude Sync — chọn hành động',
  });
  if (pick) await vscode.commands.executeCommand(pick.cmd);
}
