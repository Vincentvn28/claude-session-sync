import * as crypto from 'crypto';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';

/*
 * AES-256-GCM with scrypt-derived key. File layout:
 *
 *   [4 bytes  magic   ] "CSE1"          (Claude Sync Encrypted v1)
 *   [16 bytes salt    ]
 *   [12 bytes iv      ]
 *   [16 bytes authTag ]
 *   [N  bytes payload ]                  (ciphertext)
 *
 * Header is 48 bytes total. authTag is written ahead of the payload so
 * the decryption stream can configure GCM up front (Node's GCM
 * implementation requires authTag before the final read).
 */

const MAGIC = Buffer.from('CSE1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_COST = 1 << 14; // 16384 — OWASP-min, ~30ms, mem≈16MB
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64MB headroom (Node default is 32MB → boundary case)

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_COST,
    maxmem: SCRYPT_MAXMEM,
  });
}

export async function encryptFile(
  srcPath: string,
  dstPath: string,
  passphrase: string,
): Promise<void> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Two-pass: stream into a buffer to capture authTag before writing
  // the final file. The session zips are 30-100MB so an in-memory pass
  // is fine; if files ever grow much larger we'd switch to streaming
  // with a deferred header rewrite.
  const chunks: Buffer[] = [];
  await pipeline(
    fs.createReadStream(srcPath),
    cipher,
    async function* (source) {
      for await (const chunk of source) chunks.push(chunk as Buffer);
    },
  );
  const ciphertext = Buffer.concat(chunks);
  const authTag = cipher.getAuthTag();

  const out = fs.createWriteStream(dstPath);
  await new Promise<void>((res, rej) => {
    out.write(Buffer.concat([MAGIC, salt, iv, authTag, ciphertext]), (e) =>
      e ? rej(e) : res(),
    );
    out.end();
    out.on('finish', () => res());
    out.on('error', rej);
  });
}

export async function decryptFile(
  srcPath: string,
  dstPath: string,
  passphrase: string,
): Promise<void> {
  const fd = await fs.promises.open(srcPath, 'r');
  try {
    const headerLen = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
    const header = Buffer.alloc(headerLen);
    await fd.read(header, 0, headerLen, 0);

    if (!header.subarray(0, 4).equals(MAGIC)) {
      throw new Error('File này không phải file mã hoá Claude Sync (sai magic).');
    }
    const salt = header.subarray(4, 4 + SALT_BYTES);
    const iv = header.subarray(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
    const authTag = header.subarray(
      4 + SALT_BYTES + IV_BYTES,
      4 + SALT_BYTES + IV_BYTES + TAG_BYTES,
    );

    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const stat = await fd.stat();
    const ciphertextLen = stat.size - headerLen;
    const ciphertext = Buffer.alloc(ciphertextLen);
    await fd.read(ciphertext, 0, ciphertextLen, headerLen);

    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Sai passphrase hoặc file đã hỏng.');
    }
    await fs.promises.writeFile(dstPath, plaintext);
  } finally {
    await fd.close();
  }
}
