import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import unzipper from 'unzipper';
import {
  getClaudeProjectHash,
  getClaudeProjectsDir,
  getClaudePlansDir,
  getClaudeRoot,
  getClaudeSettingsFile,
} from './pathUtils';
import type { SessionManifest } from './exporter';

export interface ImportSessionOptions {
  zipPath: string;
  /**
   * Path of the workspace currently open in the editor. If the
   * manifest's `source_path` differs from this, jsonl content is
   * rewritten and the session lands under the destination machine's
   * project hash so Claude Code picks it up under the new path.
   */
  targetWorkspacePath?: string;
  importSettings?: boolean;
}

export interface ImportSessionResult {
  manifest: SessionManifest;
  jsonlPath: string;
  pathRewrites: number;
  overwrote: boolean;
  ancillaryFilesCopied: number;
}

async function extractToTemp(zipPath: string): Promise<string> {
  const temp = path.join(
    os.tmpdir(),
    `claude-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.promises.mkdir(temp, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  await directory.extract({ path: temp, concurrency: 4 });
  return temp;
}

async function readManifest(tempDir: string): Promise<SessionManifest | null> {
  const f = path.join(tempDir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(await fs.promises.readFile(f, 'utf8'));
  } catch {
    return null;
  }
}

async function copyDir(src: string, dest: string): Promise<number> {
  await fs.promises.mkdir(dest, { recursive: true });
  let n = 0;
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      n += await copyDir(s, d);
    } else {
      await fs.promises.copyFile(s, d);
      n++;
    }
  }
  return n;
}

async function rmrf(p: string): Promise<void> {
  await fs.promises.rm(p, { recursive: true, force: true });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeReplacement(s: string): string {
  return s.replace(/\$/g, '$$$$');
}

async function rewriteJsonlPaths(
  jsonlPath: string,
  srcPath: string,
  dstPath: string,
): Promise<number> {
  if (srcPath === dstPath || !fs.existsSync(jsonlPath)) return 0;

  const variants: Array<[string, string]> = [
    [srcPath, dstPath],
    [srcPath.replace(/\\/g, '\\\\'), dstPath.replace(/\\/g, '\\\\')],
    [srcPath.replace(/\\/g, '/'), dstPath.replace(/\\/g, '/')],
  ];
  const seen = new Set<string>();
  const uniq = variants.filter(([s]) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  let content = await fs.promises.readFile(jsonlPath, 'utf8');
  let total = 0;
  for (const [old, neu] of uniq) {
    if (old === neu) continue;
    const re = new RegExp(escapeRegExp(old), 'g');
    const matches = content.match(re);
    if (!matches) continue;
    content = content.replace(re, escapeReplacement(neu));
    total += matches.length;
  }
  if (total > 0) {
    await fs.promises.writeFile(jsonlPath, content, 'utf8');
  }
  return total;
}

export async function importOneSession(
  opts: ImportSessionOptions,
): Promise<ImportSessionResult> {
  if (!fs.existsSync(opts.zipPath)) {
    throw new Error(`Zip file not found: ${opts.zipPath}`);
  }

  const tempDir = await extractToTemp(opts.zipPath);
  try {
    const manifest = await readManifest(tempDir);
    if (!manifest) {
      throw new Error('Invalid zip — missing manifest.json');
    }

    const projectsDir = getClaudeProjectsDir();
    await fs.promises.mkdir(projectsDir, { recursive: true });

    let projectHash = manifest.project_hash;
    if (
      opts.targetWorkspacePath &&
      manifest.source_path &&
      manifest.source_path !== opts.targetWorkspacePath
    ) {
      const targetHash = getClaudeProjectHash(opts.targetWorkspacePath);
      if (targetHash !== projectHash) {
        projectHash = targetHash;
      }
    }

    const srcSessionFolder = path.join(tempDir, 'projects', manifest.project_hash);
    if (!fs.existsSync(srcSessionFolder)) {
      throw new Error(
        `Zip does not contain folder projects/${manifest.project_hash} — corrupted file.`,
      );
    }

    const targetProjectFolder = path.join(projectsDir, projectHash);
    await fs.promises.mkdir(targetProjectFolder, { recursive: true });

    const srcJsonl = path.join(srcSessionFolder, `${manifest.session_id}.jsonl`);
    const dstJsonl = path.join(targetProjectFolder, `${manifest.session_id}.jsonl`);
    const overwrote = fs.existsSync(dstJsonl);
    if (!fs.existsSync(srcJsonl)) {
      throw new Error(`Zip is missing ${manifest.session_id}.jsonl`);
    }
    await fs.promises.copyFile(srcJsonl, dstJsonl);

    let ancillaryFilesCopied = 0;

    const srcSubagents = path.join(srcSessionFolder, manifest.session_id);
    if (fs.existsSync(srcSubagents)) {
      const dstSubagents = path.join(targetProjectFolder, manifest.session_id);
      await rmrf(dstSubagents);
      ancillaryFilesCopied += await copyDir(srcSubagents, dstSubagents);
    }

    const srcMemory = path.join(srcSessionFolder, 'memory');
    if (fs.existsSync(srcMemory)) {
      const dstMemory = path.join(targetProjectFolder, 'memory');
      await fs.promises.mkdir(dstMemory, { recursive: true });
      for (const entry of await fs.promises.readdir(srcMemory, { withFileTypes: true })) {
        const s = path.join(srcMemory, entry.name);
        const d = path.join(dstMemory, entry.name);
        if (entry.isDirectory()) {
          await rmrf(d);
          ancillaryFilesCopied += await copyDir(s, d);
        } else {
          await fs.promises.copyFile(s, d);
          ancillaryFilesCopied++;
        }
      }
    }

    const srcPlans = path.join(tempDir, 'plans');
    if (fs.existsSync(srcPlans)) {
      const dstPlans = getClaudePlansDir();
      await fs.promises.mkdir(dstPlans, { recursive: true });
      for (const entry of await fs.promises.readdir(srcPlans, { withFileTypes: true })) {
        const s = path.join(srcPlans, entry.name);
        const d = path.join(dstPlans, entry.name);
        if (entry.isDirectory()) {
          await rmrf(d);
          ancillaryFilesCopied += await copyDir(s, d);
        } else {
          await fs.promises.copyFile(s, d);
          ancillaryFilesCopied++;
        }
      }
    }

    if (opts.importSettings) {
      const srcSettings = path.join(tempDir, 'settings.json');
      if (fs.existsSync(srcSettings)) {
        await fs.promises.mkdir(getClaudeRoot(), { recursive: true });
        await fs.promises.copyFile(srcSettings, getClaudeSettingsFile());
        ancillaryFilesCopied++;
      }
    }

    let pathRewrites = 0;
    if (
      opts.targetWorkspacePath &&
      manifest.source_path &&
      manifest.source_path !== opts.targetWorkspacePath
    ) {
      pathRewrites = await rewriteJsonlPaths(
        dstJsonl,
        manifest.source_path,
        opts.targetWorkspacePath,
      );
    }

    return {
      manifest,
      jsonlPath: dstJsonl,
      pathRewrites,
      overwrote,
      ancillaryFilesCopied,
    };
  } finally {
    await rmrf(tempDir).catch(() => {});
  }
}
