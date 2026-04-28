import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import archiver from 'archiver';
import {
  getClaudeProjectsDir,
  getClaudePlansDir,
  getClaudeSettingsFile,
} from './pathUtils';

export interface SessionInfo {
  /** UUID basename of the .jsonl file (without extension) */
  sessionId: string;
  /** Absolute path to the .jsonl */
  jsonlPath: string;
  /** Project hash this session belongs to (folder name in ~/.claude/projects/) */
  projectHash: string;
  /** Project source path read from inside the jsonl, or null if not present */
  sourcePath: string | null;
  /** Title derived from first user message; empty string if none found */
  title: string;
  /** Suggested file name for Drive: `YYYYMMDD HHmm <title>.csz` */
  fileName: string;
  /** Last modified timestamp of the jsonl */
  modifiedMs: number;
  /** Size in bytes of the jsonl */
  sizeBytes: number;
}

export interface SessionManifest {
  schema: 'claude-session-sync/v3';
  exported_at: string;
  machine_name: string;
  user_name: string;
  session_id: string;
  project_hash: string;
  source_path: string | null;
  title: string;
}

export interface SessionExportResult {
  zipPath: string;
  fileName: string;
  sizeBytes: number;
  manifest: SessionManifest;
}

/**
 * Walk every project hash folder and yield each .jsonl with metadata.
 * If `projectHashFilter` is provided, only sessions inside that exact
 * project hash folder are returned — used to scope the push picker to
 * the workspace currently open.
 */
export async function listAllSessions(projectHashFilter?: string): Promise<SessionInfo[]> {
  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const out: SessionInfo[] = [];
  for (const projectEntry of await fs.promises.readdir(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    if (projectHashFilter && projectEntry.name !== projectHashFilter) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    for (const fileEntry of await fs.promises.readdir(projectDir, { withFileTypes: true })) {
      if (fileEntry.isDirectory()) continue;
      if (!fileEntry.name.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(projectDir, fileEntry.name);
      const sessionId = fileEntry.name.slice(0, -'.jsonl'.length);
      const stat = await fs.promises.stat(jsonlPath);
      const meta = await readSessionMeta(jsonlPath);
      out.push({
        sessionId,
        jsonlPath,
        projectHash: projectEntry.name,
        sourcePath: meta.sourcePath,
        title: meta.title,
        fileName: buildSessionFileName(meta.title, stat.mtimeMs),
        modifiedMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return out;
}

/**
 * Read up to ~500 lines of a jsonl to extract:
 *   - `aiTitle` from the `{"type":"ai-title", ...}` entry that Claude
 *     emits a few turns into a session — this matches what Antigravity
 *     shows in its session list. Preferred when present.
 *   - First user message text — fallback title before Claude has
 *     generated `aiTitle`.
 *   - `cwd` — used as project source path for path rewriting on pull.
 */
async function readSessionMeta(jsonlPath: string): Promise<{ title: string; sourcePath: string | null }> {
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let firstUserTitle = '';
  let aiTitle = '';
  let sourcePath: string | null = null;
  let scanned = 0;

  try {
    for await (const line of rl) {
      scanned++;
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
        aiTitle = obj.aiTitle.trim();
      }
      if (!sourcePath && typeof obj.cwd === 'string') sourcePath = obj.cwd;
      if (!firstUserTitle) {
        const fromContent = extractFirstUserText(obj);
        if (fromContent) firstUserTitle = fromContent;
      }

      if (aiTitle && sourcePath) break;
      if (scanned > 500) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { title: (aiTitle || firstUserTitle).trim(), sourcePath };
}

function extractFirstUserText(obj: any): string {
  if (!obj || typeof obj !== 'object') return '';

  if (typeof obj.content === 'string' && obj.content.trim()) {
    return obj.content;
  }
  if (obj.type === 'user' || obj.role === 'user') {
    const msg = obj.message;
    if (msg) {
      if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            return part.text;
          }
        }
      }
    }
  }
  if (obj.message?.role === 'user') {
    const c = obj.message.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          return part.text;
        }
      }
    }
  }
  return '';
}

/**
 * Build a human-readable Drive filename: `YYYYMMDD HHmm <title>.csz`
 * (local time of the session's last modification). Identity for
 * re-push deduplication lives in Drive `appProperties.sessionId`, not
 * in the filename — so the name is purely for display/sort.
 */
export function buildSessionFileName(title: string, modifiedMs: number): string {
  const d = new Date(modifiedMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const stamp = `${yyyy}${mm}${dd} ${hh}${mi}`;

  let stem = title || 'untitled';
  stem = stem
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stem.length > 80) stem = stem.slice(0, 80).trim();
  if (!stem) stem = 'untitled';
  return `${stamp} ${stem}.csz`;
}

/**
 * Build a zip containing exactly one session: its jsonl, its subagents
 * folder (`<uuid>/...` inside the project hash), the project's memory
 * folder, and the global plans folder. Memory + plans are duplicated
 * across sessions of the same project (a few KB each) — keeps each zip
 * fully self-contained so the importer never needs cross-zip context.
 */
export async function exportOneSession(
  info: SessionInfo,
  outputZipPath: string,
  includeSettings = false,
): Promise<SessionExportResult> {
  const manifest: SessionManifest = {
    schema: 'claude-session-sync/v3',
    exported_at: new Date().toISOString(),
    machine_name: os.hostname() || 'unknown',
    user_name: os.userInfo().username || 'unknown',
    session_id: info.sessionId,
    project_hash: info.projectHash,
    source_path: info.sourcePath,
    title: info.title,
  };

  await fs.promises.mkdir(path.dirname(outputZipPath), { recursive: true });

  return await new Promise<SessionExportResult>((resolve, reject) => {
    const out = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    out.on('close', () => {
      resolve({
        zipPath: outputZipPath,
        fileName: info.fileName,
        sizeBytes: archive.pointer(),
        manifest,
      });
    });
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') return;
      reject(err);
    });
    archive.pipe(out);

    archive.file(info.jsonlPath, {
      name: `projects/${info.projectHash}/${info.sessionId}.jsonl`,
    });

    const projectDir = path.dirname(info.jsonlPath);
    const subagentsDir = path.join(projectDir, info.sessionId);
    if (fs.existsSync(subagentsDir)) {
      archive.directory(subagentsDir, `projects/${info.projectHash}/${info.sessionId}`);
    }

    const memoryDir = path.join(projectDir, 'memory');
    if (fs.existsSync(memoryDir)) {
      archive.directory(memoryDir, `projects/${info.projectHash}/memory`);
    }

    const plansDir = getClaudePlansDir();
    if (fs.existsSync(plansDir)) {
      archive.directory(plansDir, 'plans');
    }

    if (includeSettings) {
      const settings = getClaudeSettingsFile();
      if (fs.existsSync(settings)) {
        archive.file(settings, { name: 'settings.json' });
      }
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.finalize();
  });
}
