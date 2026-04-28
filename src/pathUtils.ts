import * as os from 'os';
import * as path from 'path';

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
