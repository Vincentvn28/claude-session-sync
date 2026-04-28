import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Convert an absolute project path to the folder name Claude Code uses
 * inside `~/.claude/projects/`. Replicates the algorithm Claude Code's
 * own loader uses: lowercase the drive letter, then replace any
 * character that isn't [a-zA-Z0-9-] with `-`.
 *
 * Crucially this differs from the simpler version in the legacy
 * `import-claude.ps1` script (which only replaced `:` `\` `/` ` `) —
 * that script produces wrong hashes for paths containing `.` or
 * uppercase drive letters, which is why a session imported with the
 * legacy script ends up in a folder Claude Code doesn't read.
 */
export function getClaudeProjectHash(projectPath: string): string {
  let p = projectPath.replace(/[\\\/]+$/, '');
  if (/^[A-Z]:/.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
  return p.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function getClaudeRoot(): string {
  return path.join(os.homedir(), '.claude');
}

export function getClaudeProjectsDir(): string {
  return path.join(getClaudeRoot(), 'projects');
}

export function getClaudePlansDir(): string {
  return path.join(getClaudeRoot(), 'plans');
}

export function getClaudeSettingsFile(): string {
  return path.join(getClaudeRoot(), 'settings.json');
}

export function getClaudeProjectDir(projectPath: string): string {
  return path.join(getClaudeProjectsDir(), getClaudeProjectHash(projectPath));
}

export function machineId(): string {
  return os.hostname() || 'unknown-machine';
}

export interface KnownProject {
  /** Original project path (read from a session jsonl's `cwd` field). */
  path: string;
  /** Folder name under `~/.claude/projects/` (the hashed form). */
  hash: string;
  /** Number of `.jsonl` session files in this project's folder. */
  sessionCount: number;
}

/**
 * Scan `~/.claude/projects/` and return one entry per project folder we
 * can map back to a real on-disk path. Used by the "Import from local
 * file" UI so the user can pick a target project without remembering
 * its hashed folder name.
 *
 * For each `<hash>/` folder we read the FIRST `.jsonl`'s `cwd` field —
 * that's the original project path. Folders whose `cwd` no longer
 * exists on disk are filtered out so we never offer a broken target.
 */
export async function listKnownProjects(): Promise<KnownProject[]> {
  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  const out: KnownProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);

    let jsonlNames: string[] = [];
    try {
      const files = await fs.promises.readdir(projectDir);
      jsonlNames = files.filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (jsonlNames.length === 0) continue;

    const cwd = await readCwdFromJsonl(path.join(projectDir, jsonlNames[0]));
    if (!cwd) continue;
    if (!fs.existsSync(cwd)) continue;

    out.push({ path: cwd, hash: entry.name, sessionCount: jsonlNames.length });
  }

  // Sort by session count desc, then path — frequently-used projects rise to the top.
  out.sort((a, b) =>
    b.sessionCount - a.sessionCount || a.path.localeCompare(b.path),
  );
  return out;
}

async function readCwdFromJsonl(jsonlPath: string): Promise<string | null> {
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0;
  try {
    for await (const line of rl) {
      scanned++;
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
      } catch {
        // skip malformed lines
      }
      if (scanned > 50) break; // cwd is in the first few lines if anywhere
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}
