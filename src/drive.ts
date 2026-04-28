import * as fs from 'fs';

/*
 * Tiny Google Drive REST client — only the few endpoints we need:
 *   - find/create folder by name
 *   - upload file (multipart for small, resumable for large)
 *   - list files in a folder
 *   - download file by id
 *   - delete file by id
 *
 * We deliberately avoid the `googleapis` npm package — it pulls in
 * ~30MB of transitive deps and a discovery loader we don't need.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

export class DriveClient {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return { authorization: `Bearer ${token}` };
  }

  /**
   * Get-or-create a folder by name under an optional parent. With
   * scope `drive.file` we can only see folders this app created, so
   * the lookup is reliably scoped to our own data.
   */
  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const q = [
      `name = '${escapeQuery(name)}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `trashed = false`,
      parentId ? `'${parentId}' in parents` : `'root' in parents`,
    ].join(' and ');
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id,name)');
    url.searchParams.set('spaces', 'drive');
    const r = await fetch(url, { headers: await this.authHeaders() });
    if (!r.ok) throw await driveError('list folder', r);
    const j = (await r.json()) as { files: DriveFile[] };
    if (j.files.length > 0) return j.files[0].id;

    const create = await fetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: { ...(await this.authHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      }),
    });
    if (!create.ok) throw await driveError('create folder', create);
    const created = (await create.json()) as DriveFile;
    return created.id;
  }

  /**
   * Upload a local file into a Drive folder. For files larger than
   * RESUMABLE_THRESHOLD we use resumable upload with progress
   * callbacks, otherwise multipart in a single request.
   */
  async uploadFile(
    localPath: string,
    parentId: string,
    name: string,
    appProperties: Record<string, string> = {},
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<DriveFile> {
    const stat = await fs.promises.stat(localPath);
    const total = stat.size;

    if (total < RESUMABLE_THRESHOLD) {
      return this.multipartUpload(localPath, parentId, name, appProperties);
    }

    const sessionUrl = await this.startResumable(parentId, name, appProperties, total);

    const fd = await fs.promises.open(localPath, 'r');
    try {
      let uploaded = 0;
      while (uploaded < total) {
        const end = Math.min(uploaded + CHUNK_SIZE, total) - 1;
        const chunkLen = end - uploaded + 1;
        const buf = Buffer.alloc(chunkLen);
        await fd.read(buf, 0, chunkLen, uploaded);

        const r = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'content-length': String(chunkLen),
            'content-range': `bytes ${uploaded}-${end}/${total}`,
          },
          body: buf,
        });

        if (r.status === 200 || r.status === 201) {
          onProgress?.(total, total);
          return (await r.json()) as DriveFile;
        }
        if (r.status !== 308) {
          throw await driveError('resumable chunk', r);
        }
        uploaded = end + 1;
        onProgress?.(uploaded, total);
      }
      throw new Error('Upload ended unexpectedly — server did not return file metadata.');
    } finally {
      await fd.close();
    }
  }

  private async startResumable(
    parentId: string,
    name: string,
    appProperties: Record<string, string>,
    total: number,
  ): Promise<string> {
    const url = `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name,size,modifiedTime,appProperties`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        ...(await this.authHeaders()),
        'content-type': 'application/json',
        'x-upload-content-length': String(total),
        'x-upload-content-type': 'application/octet-stream',
      },
      body: JSON.stringify({ name, parents: [parentId], appProperties }),
    });
    if (!r.ok) throw await driveError('start resumable', r);
    const loc = r.headers.get('location');
    if (!loc) throw new Error('Drive resumable upload: missing Location header');
    return loc;
  }

  private async multipartUpload(
    localPath: string,
    parentId: string,
    name: string,
    appProperties: Record<string, string>,
  ): Promise<DriveFile> {
    const data = await fs.promises.readFile(localPath);
    const boundary = `csb${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name, parents: [parentId], appProperties });

    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${meta}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, data, tail]);

    const url = `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size,modifiedTime,appProperties`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        ...(await this.authHeaders()),
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!r.ok) throw await driveError('multipart upload', r);
    return (await r.json()) as DriveFile;
  }

  /**
   * Find all files under `parentId` whose `appProperties.sessionId`
   * exactly matches `sessionId`. Returns 0 or 1 in normal use; the
   * array shape is to make duplicate cleanup easy.
   */
  async findBySessionId(parentId: string, sessionId: string): Promise<DriveFile[]> {
    const escaped = sessionId.replace(/'/g, "\\'");
    return this.listFiles(
      parentId,
      `appProperties has { key='sessionId' and value='${escaped}' }`,
    );
  }

  async listFiles(parentId: string, query?: string): Promise<DriveFile[]> {
    const q = [
      `'${parentId}' in parents`,
      `trashed = false`,
      query,
    ].filter(Boolean).join(' and ');
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id,name,size,modifiedTime,appProperties)');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('pageSize', '100');
    const r = await fetch(url, { headers: await this.authHeaders() });
    if (!r.ok) throw await driveError('list files', r);
    return ((await r.json()) as { files: DriveFile[] }).files;
  }

  async downloadFile(
    fileId: string,
    dstPath: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<void> {
    const r = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: await this.authHeaders(),
    });
    if (!r.ok || !r.body) throw await driveError('download', r);

    const total = Number(r.headers.get('content-length') ?? '0');
    let downloaded = 0;
    const out = fs.createWriteStream(dstPath);
    const reader = r.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out.write(Buffer.from(value));
        downloaded += value.byteLength;
        if (total > 0) onProgress?.(downloaded, total);
      }
    } finally {
      out.end();
      await new Promise<void>((res, rej) => {
        out.on('finish', () => res());
        out.on('error', rej);
      });
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    const r = await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!r.ok && r.status !== 404) throw await driveError('delete', r);
  }
}

function escapeQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveError(op: string, r: Response): Promise<Error> {
  const text = await r.text().catch(() => '');
  return new Error(`Drive ${op} failed: ${r.status} ${text.slice(0, 400)}`);
}
