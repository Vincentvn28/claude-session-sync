import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';

/*
 * Embedded OAuth client for the `claude-session-sync` Google Cloud project.
 * For installed / native apps Google explicitly allows the client_secret
 * to be distributed in source — see
 * https://developers.google.com/identity/protocols/oauth2#installed.
 *
 * Project setup (one-time, already done):
 *   1. Drive API enabled on the claude-session-sync project
 *   2. `auth/drive.file` scope added on the OAuth consent screen
 *   3. Consent screen published (unverified, capped at 100 users)
 */
const CLIENT_ID =
  '324073497482-udgl8cd8d63r6vvovf1tbl2tt9purc9v.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

const REDIRECT_PORT = 54321;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/`;

/* drive.file = only files this app creates. We never see other Drive files,
 * which (a) keeps the user safe and (b) makes the app eligible for
 * Google's verification fast track. */
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
];

const SECRET_KEY = 'claudeSync.googleTokens';

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email?: string;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export class GoogleAuth {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async isSignedIn(): Promise<boolean> {
    return (await this.loadTokens()) !== null;
  }

  async getEmail(): Promise<string | undefined> {
    return (await this.loadTokens())?.email;
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  /**
   * Run the loopback OAuth flow. Returns the email of the signed-in
   * user. Throws on cancel / error.
   */
  async signIn(): Promise<string> {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(
      crypto.createHash('sha256').update(verifier).digest(),
    );
    const state = base64url(crypto.randomBytes(16));

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('prompt', 'consent select_account');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    const code = await this.captureLoopbackCode(authUrl.toString(), state);
    const tokens = await this.exchangeCodeForTokens(code, verifier);
    const email = await this.fetchEmail(tokens.access_token).catch(() => undefined);

    const stored: StoredTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? '',
      expires_at: Date.now() + tokens.expires_in * 1000 - 60_000,
      email,
      scope: tokens.scope,
    };
    await this.secrets.store(SECRET_KEY, JSON.stringify(stored));
    return email ?? '';
  }

  /**
   * Get a valid access token (refreshing if needed). Returns null if
   * the user is not signed in.
   */
  async getAccessToken(): Promise<string | null> {
    const t = await this.loadTokens();
    if (!t) return null;
    if (Date.now() < t.expires_at) return t.access_token;
    if (!t.refresh_token) {
      await this.secrets.delete(SECRET_KEY);
      return null;
    }
    const refreshed = await this.refreshAccessToken(t.refresh_token);
    const updated: StoredTokens = {
      ...t,
      access_token: refreshed.access_token,
      expires_at: Date.now() + refreshed.expires_in * 1000 - 60_000,
      scope: refreshed.scope ?? t.scope,
    };
    await this.secrets.store(SECRET_KEY, JSON.stringify(updated));
    return updated.access_token;
  }

  private async loadTokens(): Promise<StoredTokens | null> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  private captureLoopbackCode(authUrl: string, expectedState: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let resolved = false;
      const server = http.createServer((req, res) => {
        if (!req.url) return;
        const u = new URL(req.url, REDIRECT_URI);
        const code = u.searchParams.get('code');
        const error = u.searchParams.get('error');
        const state = u.searchParams.get('state');

        const html = (title: string, body: string) =>
          `<!doctype html><html lang="vi"><head><meta charset="utf-8">` +
          `<title>${title}</title>` +
          `<style>body{font-family:system-ui,Segoe UI,sans-serif;` +
          `display:flex;align-items:center;justify-content:center;height:100vh;` +
          `margin:0;background:#0d1117;color:#c9d1d9;}` +
          `.card{padding:48px;border-radius:16px;background:#161b22;` +
          `text-align:center;max-width:420px;}h1{margin:0 0 12px;font-size:22px;}` +
          `p{margin:0;color:#8b949e;}</style></head><body>` +
          `<div class="card">${body}</div></body></html>`;

        if (error) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html('OAuth error',
            `<h1>❌ ${error}</h1><p>Có thể đóng tab này.</p>`));
          if (!resolved) {
            resolved = true;
            server.close();
            reject(new Error(`Google OAuth error: ${error}`));
          }
          return;
        }
        if (!code) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html('OAuth error',
            `<h1>❌ Thiếu code</h1><p>Có thể đóng tab này.</p>`));
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html('OAuth error',
            `<h1>❌ State không khớp</h1><p>Thử đăng nhập lại.</p>`));
          if (!resolved) {
            resolved = true;
            server.close();
            reject(new Error('OAuth state mismatch — possible CSRF'));
          }
          return;
        }

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html('Đăng nhập thành công',
          `<h1>✅ Đăng nhập thành công</h1>` +
          `<p>Có thể đóng tab này và quay lại Antigravity.</p>`));

        if (!resolved) {
          resolved = true;
          server.close();
          resolve(code);
        }
      });

      server.on('error', (e) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(
            `Không bind được port ${REDIRECT_PORT}: ${e.message}\n` +
            `App khác đang dùng port này, đóng nó đi rồi thử lại.`));
        }
      });

      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });

      // 5-minute budget — long enough for a slow manual sign-in, short
      // enough that an abandoned flow doesn't leak the loopback server.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          server.close();
          reject(new Error('OAuth timeout sau 5 phút — thử lại.'));
        }
      }, 5 * 60_000);
    });
  }

  private async exchangeCodeForTokens(
    code: string,
    verifier: string,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) {
      throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
    }
    return (await r.json()) as TokenResponse;
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) {
      throw new Error(`Refresh token failed: ${r.status} ${await r.text()}`);
    }
    return (await r.json()) as TokenResponse;
  }

  private async fetchEmail(accessToken: string): Promise<string | undefined> {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { email?: string };
    return j.email;
  }
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
