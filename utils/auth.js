/**
 * Authentication & Token Management
 * Handles OAuth token refresh for all Google APIs
 * 
 * Supports loading client secret from:
 * 1. Environment variable: GOOGLE_CLIENT_SECRET
 * 2. MCP config: passed via env from opencode.jsonc
 * 3. Stored auth file
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

const AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'mcp-auth.json');
const OAUTH_TOKEN_URL = 'oauth2.googleapis.com';

// Get OAuth credentials from environment (set by opencode.jsonc via env config)
function getClientId() {
  return process.env.GOOGLE_CLIENT_ID || null;
}

function getClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || null;
}

function loadAuthData() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch (e) {
    throw new Error(`No auth tokens found. Run: npm run setup-oauth`);
  }
}

function saveAuthData(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

export async function getAccessToken() {
  const authData = loadAuthData();
  const gwAuth = authData['google-workspace'];

  if (!gwAuth || !gwAuth.tokens) {
    throw new Error('No Google Workspace auth found. Run: npm run setup-oauth');
  }

  const { accessToken, refreshToken, expiresAt } = gwAuth.tokens;
  const now = Date.now() / 1000;

  // Refresh if expiring in next 60 seconds
  if (expiresAt - now < 60 && refreshToken) {
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    
    if (!clientId || !clientSecret) {
      throw new Error('OAuth credentials not available. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars in opencode.jsonc');
    }

    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token'
      }).toString();

      const req = https.request({
        hostname: OAUTH_TOKEN_URL,
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': postData.length
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const tokens = JSON.parse(data);
            if (tokens.error) {
              reject(new Error(`Token refresh failed: ${tokens.error_description || tokens.error}`));
              return;
            }

            // Update stored tokens
            authData['google-workspace'].tokens.accessToken = tokens.access_token;
            authData['google-workspace'].tokens.expiresAt = Date.now() / 1000 + tokens.expires_in;
            saveAuthData(authData);

            resolve(tokens.access_token);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  return accessToken;
}
