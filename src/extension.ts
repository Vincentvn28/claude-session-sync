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
import { machineId, getClaudeProjectHash, listKnownProjects } from './pathUtils';

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
    if (!t) throw new Error('Not signed in. Run "Claude Sync: Sign in with Google".');
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
    vscode.commands.registerCommand('claudeSync.importFile', () => importLocalFile(ctx)),
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
    statusBar.setBusy('Opening browser…');
    const email = await auth.signIn();
    statusBar.setBusy(null);
    statusBar.setSignedIn(email);
    vscode.window.showInformationMessage(
      email ? `Signed in to Google: ${email}` : 'Signed in to Google.',
    );
  } catch (e) {
    statusBar.setBusy(null);
    logError('signIn failed', e);
    vscode.window.showErrorMessage(`Sign-in failed: ${(e as Error).message}`);
  }
}

async function signOut(): Promise<void> {
  await auth.signOut();
  statusBar.setSignedIn(undefined);
  vscode.window.showInformationMessage('Signed out of Google.');
}

async function ensureSignedIn(): Promise<boolean> {
  if (await auth.isSignedIn()) return true;
  const pick = await vscode.window.showInformationMessage(
    'Not signed in to Google. Sign in now?',
    'Sign in',
    'Cancel',
  );
  if (pick !== 'Sign in') return false;
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
    ? 'Set encryption passphrase (≥ 8 characters). Losing the passphrase = losing access to all uploaded files.'
    : 'Enter the passphrase you set when first pushing a session.';
  pass = await vscode.window.showInputBox({
    prompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length < 8 ? 'At least 8 characters required.' : null),
  });
  if (!pass) return null;

  if (forNew) {
    const confirm = await vscode.window.showInputBox({
      prompt: 'Re-enter the passphrase to confirm.',
      password: true,
      ignoreFocusOut: true,
    });
    if (confirm !== pass) {
      vscode.window.showErrorMessage('Passphrases do not match.');
      return null;
    }
  }
  await ctx.secrets.store(PASSPHRASE_KEY, pass);
  return pass;
}

async function setPassphrase(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(PASSPHRASE_KEY);
  await getOrAskPassphrase(ctx, true);
  vscode.window.showInformationMessage('New passphrase saved.');
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
      'No folder/workspace open. Open a project and try push again — the extension only pushes sessions for the open project.',
    );
    return null;
  }
  const projectHash = getClaudeProjectHash(ws);
  const all = await listAllSessions(projectHash);
  if (all.length === 0) {
    vscode.window.showWarningMessage(
      `No sessions found for the current project (${projectHash}). ` +
      'Chat with Claude Code in this project at least once before pushing.',
    );
    return null;
  }

  const items: SessionPickItem[] = all.map((s) => ({
    label: `$(comment-discussion) ${s.title || '(untitled)'}`,
    description: `${(s.sizeBytes / 1024 / 1024).toFixed(1)}MB`,
    detail: `modified ${new Date(s.modifiedMs).toLocaleString()} · ${s.sessionId.slice(0, 8)}`,
    picked: true,
    session: s,
  }));

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Pick sessions to push (current project — ${all.length} sessions)`,
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
    statusBar.setBusy('preparing');
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
        `✅ Push complete: ${succeeded} session · ${totalMB}MB → Drive/${folderName}`,
      );
    } else {
      vscode.window.showWarningMessage(
        `Push finished with errors: ${succeeded} OK, ${failed} failed. See Output → "Claude Session Sync".`,
      );
    }
  } catch (e) {
    statusBar.setBusy(null);
    logError('push (top-level) failed', e);
    vscode.window.showErrorMessage(
      `Push failed: ${(e as Error).message}. See Output → "Claude Session Sync".`,
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
      'No folder/workspace open. Open a project and try pull again — the extension needs a workspace to rewrite paths.',
    );
    return;
  }
  const projectName = path.basename(ws).toLowerCase();

  let files: DriveFile[];
  try {
    statusBar.setBusy('list Drive');
    const rootId = await ensureRootFolder(folderName);
    // List every .csz file in the folder, regardless of who created
    // it. Requires `drive.readonly` scope so we also see files the user
    // manually copied into the folder via Drive UI (those won't have
    // any appProperties from the extension).
    const all = await drive.listFiles(rootId);
    files = all.filter((f) => f.name.toLowerCase().endsWith('.csz'));
    statusBar.setBusy(null);
  } catch (e) {
    statusBar.setBusy(null);
    logError('pull list failed', e);
    vscode.window.showErrorMessage(
      `Pull failed: ${(e as Error).message}. See Output → "Claude Session Sync".`,
    );
    return;
  }

  if (files.length === 0) {
    vscode.window.showWarningMessage(
      `No .csz files found in Drive/${folderName}. Push from another machine first.`,
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
    // Surface source project (when known) so the user can tell sessions
    // from different projects apart. Files copied via Drive UI typically
    // lose appProperties, so we show '?' for those.
    const sourceProject = props.projectName || '?';
    return {
      label: `$(comment-discussion) ${title}`,
      description: `[${sourceProject}] · ${machine} · ${sizeMB}`,
      detail: f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '',
      picked: false, // never pre-select; user must explicitly pick
      file: f,
    };
  });

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Pick sessions to pull (${files.length} .csz file(s) on Drive — paths will be rewritten to workspace "${projectName}")`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picks || picks.length === 0) return;

  const confirm = await vscode.window.showWarningMessage(
    `Pull ${picks.length} session(s) into workspace "${projectName}". ` +
      'Paths inside the sessions will be rewritten to this machine. ' +
      'Sessions with matching UUIDs will be OVERWRITTEN. Continue?',
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
    `${succeeded} session(s) OK` +
    (overwrote > 0 ? ` (${overwrote} overwritten)` : '') +
    (pathRewrites > 0 ? ` · ${pathRewrites} path(s) rewritten` : '') +
    (failed > 0 ? ` · ${failed} failed` : '');

  if (succeeded > 0) {
    const reload = await vscode.window.showInformationMessage(
      `✅ Pull complete: ${summary}. Reload window for Claude Code to pick up new sessions.`,
      'Reload Window',
    );
    if (reload === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else {
    vscode.window.showErrorMessage(
      `Pull failed: ${summary}. See Output → "Claude Session Sync".`,
    );
  }
}

interface TargetPickItem extends vscode.QuickPickItem {
  /** undefined = "Browse for folder…" placeholder; resolved at pick time. */
  targetPath?: string;
}

/**
 * Ask the user where to import — current workspace, a detected project,
 * or an arbitrary folder via the OS folder picker. Returns null if the
 * user cancels at any step.
 */
async function pickTargetProject(): Promise<string | null> {
  const items: TargetPickItem[] = [];
  const ws = currentWorkspacePath();

  if (ws) {
    items.push({
      label: `$(folder-active) Current workspace — ${path.basename(ws)}`,
      detail: ws,
      targetPath: ws,
    });
  }

  const known = await listKnownProjects().catch(() => []);
  for (const k of known) {
    // Don't double-list the current workspace if it's also a detected project.
    if (ws && path.resolve(k.path).toLowerCase() === path.resolve(ws).toLowerCase()) continue;
    items.push({
      label: `$(folder) ${path.basename(k.path)}`,
      description: `${k.sessionCount} session${k.sessionCount === 1 ? '' : 's'}`,
      detail: k.path,
      targetPath: k.path,
    });
  }

  items.push({
    label: '$(folder-opened) Browse for folder…',
    description: 'pick any project folder on disk',
    targetPath: undefined,
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Import the session(s) into which project?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return null;
  if (pick.targetPath) return pick.targetPath;

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use as target project',
    title: 'Pick the target project folder',
  });
  if (!picked || picked.length === 0) return null;
  return picked[0].fsPath;
}

async function importLocalFile(ctx: vscode.ExtensionContext): Promise<void> {
  const passphrase = await getOrAskPassphrase(ctx, false);
  if (!passphrase) return;

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: 'Import',
    title: 'Pick .csz file(s) to import',
    filters: { 'Claude Sync Encrypted': ['csz'] },
  });
  if (!picked || picked.length === 0) return;

  const target = await pickTargetProject();
  if (!target) return;

  const targetName = path.basename(target);
  const ws = currentWorkspacePath();
  const targetIsCurrentWs = ws !== null && path.resolve(target).toLowerCase() === path.resolve(ws).toLowerCase();

  const sourceList = picked.map((p) => `  • ${path.basename(p.fsPath)}`).join('\n');
  const confirm = await vscode.window.showWarningMessage(
    `Import ${picked.length} file(s) into project "${targetName}":\n\n${sourceList}\n\n→ ${target}\n\n` +
      'Paths inside the sessions will be rewritten to this target. ' +
      'Sessions with matching UUIDs will be OVERWRITTEN. Continue?',
    { modal: true },
    'Import',
  );
  if (confirm !== 'Import') return;

  let succeeded = 0;
  let overwrote = 0;
  let failed = 0;
  let pathRewrites = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude Sync · Import', cancellable: true },
    async (progress, token) => {
      const total = picked.length;
      for (let i = 0; i < total; i++) {
        if (token.isCancellationRequested) {
          logInfo(`import cancelled at ${i}/${total}`);
          break;
        }
        const f = picked[i];
        const baseName = path.basename(f.fsPath);
        progress.report({
          message: `(${i + 1}/${total}) ${baseName}`,
          increment: 100 / total,
        });
        statusBar.setBusy(`import ${i + 1}/${total}`);

        const plainZip = path.join(os.tmpdir(), `csync-import-${i}-${Date.now()}.zip`);
        try {
          await decryptFile(f.fsPath, plainZip, passphrase);
          const r = await importOneSession({
            zipPath: plainZip,
            targetWorkspacePath: target,
          });
          succeeded++;
          if (r.overwrote) overwrote++;
          pathRewrites += r.pathRewrites;
          logInfo(
            `import ok · ${baseName} → ${r.jsonlPath}` +
            (r.overwrote ? ' (overwrote)' : '') +
            (r.pathRewrites > 0 ? ` (${r.pathRewrites} path rewrites)` : ''),
          );
        } catch (e) {
          failed++;
          logError(`import failed · ${baseName}`, e);
        } finally {
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
    `${succeeded} session(s) OK` +
    (overwrote > 0 ? ` (${overwrote} overwritten)` : '') +
    (pathRewrites > 0 ? ` · ${pathRewrites} path(s) rewritten` : '') +
    (failed > 0 ? ` · ${failed} failed` : '');

  if (succeeded > 0) {
    if (targetIsCurrentWs) {
      const action = await vscode.window.showInformationMessage(
        `✅ Import complete: ${summary}. Reload window for Claude Code to pick up new sessions.`,
        'Reload Window',
      );
      if (action === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } else {
      const action = await vscode.window.showInformationMessage(
        `✅ Import complete: ${summary}. Sessions imported into "${targetName}".`,
        'Open in new window',
      );
      if (action === 'Open in new window') {
        vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(target),
          { forceNewWindow: true },
        );
      }
    }
  } else {
    vscode.window.showErrorMessage(
      `Import failed: ${summary}. See Output → "Claude Session Sync".`,
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
    vscode.window.showErrorMessage(`Could not open Drive: ${(e as Error).message}`);
  }
}

async function showMenu(ctx: vscode.ExtensionContext): Promise<void> {
  const signed = await auth.isSignedIn();
  const items: Array<vscode.QuickPickItem & { cmd: string }> = [
    { label: '$(cloud-upload) Push session to Drive', description: 'one file per session', cmd: 'claudeSync.push' },
    { label: '$(cloud-download) Pull session from Drive', description: 'list all .csz in the Drive folder', cmd: 'claudeSync.pull' },
    { label: '$(file-zip) Import session from local .csz file', description: 'for manually copied / downloaded files', cmd: 'claudeSync.importFile' },
    { label: '$(folder) Open Drive folder', cmd: 'claudeSync.openDriveFolder' },
    { label: '$(key) Set / change passphrase', cmd: 'claudeSync.setPassphrase' },
    signed
      ? { label: '$(sign-out) Sign out of Google', description: await auth.getEmail(), cmd: 'claudeSync.signOut' }
      : { label: '$(sign-in) Sign in with Google', cmd: 'claudeSync.signIn' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Claude Sync — pick an action',
  });
  if (pick) await vscode.commands.executeCommand(pick.cmd);
}
