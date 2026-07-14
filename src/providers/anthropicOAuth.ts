import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';

function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier(): string {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64URLEncode(hash);
}

function generateState(): string {
  return base64URLEncode(crypto.randomBytes(32));
}

function startHttpServer(state: string): Promise<{ port: number; server: http.Server; codePromise: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    
    let resolver: (code: string) => void;
    let rejecter: (err: Error) => void;
    
    const codePromise = new Promise<string>((res, rej) => {
      resolver = res;
      rejecter = rej;
    });

    const timeout = setTimeout(() => {
      server.close();
      rejecter(new Error('Authentication timed out. Please try again.'));
    }, 5 * 60 * 1000); // 5 minutes timeout

    server.on('request', (req, res) => {
      const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      
      if (parsedUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = parsedUrl.searchParams.get('code');
      const returnedState = parsedUrl.searchParams.get('state');

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Authentication Failed</h1><p>No authorization code received.</p>');
        clearTimeout(timeout);
        rejecter(new Error('No authorization code received'));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Authentication Failed</h1><p>State parameter mismatch (CSRF protection).</p>');
        clearTimeout(timeout);
        rejecter(new Error('State mismatch'));
        return;
      }

      // Respond to browser with a clean HTML success page matching VS Code style
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Claude Login Successful</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background-color: #1e1e1e;
              color: #d4d4d4;
            }
            .container {
              text-align: center;
              padding: 2.5rem;
              border-radius: 8px;
              background-color: #252526;
              box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45);
              border: 1px solid #3c3c3c;
              max-width: 400px;
            }
            h1 {
              color: #4ec9b0;
              margin-top: 0;
              margin-bottom: 1rem;
              font-weight: 500;
            }
            p {
              font-size: 1rem;
              line-height: 1.5;
              color: #cccccc;
              margin-bottom: 1.5rem;
            }
            .success-icon {
              font-size: 3.5rem;
              color: #4ec9b0;
              margin-bottom: 1rem;
              line-height: 1;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">✓</div>
            <h1>Login Successful!</h1>
            <p>Frappe Copilot has been successfully authenticated. You can now close this tab and return to VS Code.</p>
          </div>
        </body>
        </html>
      `);
      
      clearTimeout(timeout);
      resolver(code);
    });

    server.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    server.listen(0, 'localhost', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        server,
        codePromise
      });
    });
  });
}

export function extractOAuthCode(input: string): string {
  const trimmed = input.trim();
  try {
    if (trimmed.includes('code=')) {
      let searchParams: URLSearchParams;
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        searchParams = url.searchParams;
      } else {
        const queryStart = trimmed.indexOf('?');
        const queryString = queryStart !== -1 ? trimmed.slice(queryStart) : '?' + trimmed;
        searchParams = new URLSearchParams(queryString);
      }
      const parsedCode = searchParams.get('code');
      if (parsedCode) {
        return parsedCode;
      }
    }
  } catch (e) {
    console.error('Failed to parse oauth code from input:', e);
  }
  return trimmed;
}

export async function runClaudeOAuthFlow(
  onAuthUrl: (url: string) => void,
  codeReceivedPromise: Promise<string>
): Promise<string> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  const { port, server, codePromise } = await startHttpServer(state);

  try {
    const authUrl = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A${port}%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

    // Notify the webview of the generated auth URL
    onAuthUrl(authUrl);

    // Open user's browser
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));

    // Prevent an unhandled rejection if the manual-code path wins the race and
    // the local callback server later times out or rejects on its own.
    codePromise.catch(() => {});

    // Wait for redirect to complete or user to submit manual code
    const rawCode = await Promise.race([codePromise, codeReceivedPromise]);

    if (!rawCode) {
      throw new Error('OAuth login cancelled by user.');
    }

    const cleanedCode = extractOAuthCode(rawCode);

    // Exchange code for token
    const tokenResponse = await fetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: cleanedCode,
        redirect_uri: `http://localhost:${port}/callback`,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        code_verifier: verifier,
        state: state
      })
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${text}`);
    }

    const tokenData = await tokenResponse.json() as any;
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new Error('Access token not found in response');
    }

    try {
      // Call API key creation endpoint (Console account flow)
      const apiKeyResponse = await fetch('https://api.anthropic.com/api/oauth/claude_cli/create_api_key', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (apiKeyResponse.ok) {
        const apiKeyData = await apiKeyResponse.json() as any;
        const rawKey = apiKeyData.raw_key;
        if (rawKey) {
          return rawKey;
        }
      } else {
        const text = await apiKeyResponse.text();
        console.warn('API Key creation returned non-ok status, falling back to OAuth token:', text);
      }
    } catch (e) {
      console.warn('API Key creation threw error, falling back to OAuth token:', e);
    }

    // Fallback to returning OAuth access/refresh token credential string for direct usage
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    return JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt
    });
  } finally {
    server.close();
  }
}
