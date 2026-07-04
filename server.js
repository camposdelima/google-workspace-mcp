#!/usr/bin/env node

/**
 * Google Workspace MCP Server - with Auto-Setup
 * 
 * On first run:
 * 1. Reads client_secret from opencode.jsonc (via env or direct read)
 * 2. Checks if tokens exist in ~/.local/share/opencode/mcp-auth.json
 * 3. If not, initiates OAuth flow automatically
 * 4. Starts MCP server
 * 
 * On subsequent runs:
 * 1. Loads existing tokens
 * 2. Starts MCP server immediately
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

// ========================================================================
// External Debug Logger (writes to file, bypasses stdio)
// ========================================================================

const DEBUG_LOG = path.join(os.tmpdir(), 'google-workspace-mcp-debug.log');

function debugLog(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
  const line = `[${timestamp}] ${message}\n`;
  
  try {
    fs.appendFileSync(DEBUG_LOG, line, 'utf8');
  } catch (err) {
    // Silent fail - don't break the server
  }
}

// Log startup
debugLog('=== SERVER STARTING ===');
debugLog('Process ID:', process.pid);
debugLog('Working directory:', process.cwd());
debugLog('Node version:', process.version);
debugLog('Environment variables:', {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? '***SET***' : 'MISSING',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? '***SET***' : 'MISSING',
  PATH: process.env.PATH?.substring(0, 200)
});

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import all service modules
import * as chatService from './services/chat.js';
import * as gmailService from './services/gmail.js';
import * as calendarService from './services/calendar.js';

// ========================================================================
// Constants
// ========================================================================

const REDIRECT_URI = 'http://127.0.0.1:19876/mcp/oauth/callback';
const AUTH_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(AUTH_DIR, 'mcp-auth.json');

const SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  'https://www.googleapis.com/auth/chat.users.readstate.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.readonly'
];

// ========================================================================
// Setup Functions
// ========================================================================

function parseJsonc(content) {
  let cleaned = content.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

function getClientId() {
  debugLog('getClientId() called');
  
  // Get from environment variable (passed by OpenCode)
  if (process.env.GOOGLE_CLIENT_ID) {
    const raw = process.env.GOOGLE_CLIENT_ID;
    const trimmed = raw.trim();
    debugLog('CLIENT_ID raw length:', raw.length, 'trimmed length:', trimmed.length);
    debugLog('CLIENT_ID first 20 chars:', trimmed.substring(0, 20));
    debugLog('CLIENT_ID last 20 chars:', trimmed.substring(trimmed.length - 20));
    return trimmed;
  }
  
  debugLog('CLIENT_ID NOT FOUND in environment');
  console.error('✗ GOOGLE_CLIENT_ID not found in environment');
  return null;
}

function getClientSecret() {
  debugLog('getClientSecret() called');
  
  // Get from environment variable (passed by OpenCode)
  if (process.env.GOOGLE_CLIENT_SECRET) {
    const raw = process.env.GOOGLE_CLIENT_SECRET;
    const trimmed = raw.trim();
    debugLog('CLIENT_SECRET raw length:', raw.length, 'trimmed length:', trimmed.length);
    debugLog('CLIENT_SECRET first 10 chars:', trimmed.substring(0, 10));
    debugLog('CLIENT_SECRET last 10 chars:', trimmed.substring(trimmed.length - 10));
    return trimmed;
  }

  debugLog('CLIENT_SECRET NOT FOUND in environment');
  console.error('✗ GOOGLE_CLIENT_SECRET not found in environment');
  return null;
}

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function tokensExist() {
  if (!fs.existsSync(AUTH_FILE)) {
    return false;
  }
  
  try {
    const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    return authData['google-workspace']?.tokens?.accessToken;
  } catch (e) {
    return false;
  }
}

function generateAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    console.error(`\n[DEBUG] Exchanging code for token...`);
    console.error(`[DEBUG] Client ID: ${clientId}`);
    console.error(`[DEBUG] Client Secret: ${clientSecret.substring(0, 15)}...`);
    console.error(`[DEBUG] Redirect URI: ${REDIRECT_URI}\n`);
    
    const postData = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
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
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(`${result.error_description || result.error}`));
          } else {
            resolve(result);
          }
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

function saveTokens(tokens) {
  ensureAuthDir();

  // Load existing auth data (preserves other MCP sections)
  let authData = {};
  if (fs.existsSync(AUTH_FILE)) {
    try {
      authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    } catch (e) {
      console.error('Warning: Could not parse existing auth file, creating new one');
    }
  }

  // Add/update only google-workspace section
  authData['google-workspace'] = {
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in
    }
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
}

function startCallbackServer(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    let serverReference = null;
    
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/mcp/oauth/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Authentication failed: ${error}`);
        serverReference.close();
        reject(new Error(error));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No authorization code received');
        serverReference.close();
        reject(new Error('No authorization code'));
        return;
      }

      try {
        const tokens = await exchangeCodeForToken(code, clientId, clientSecret);
        saveTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <head>
              <title>Google Workspace MCP - Authentication Successful</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 40px; background: #f5f5f5; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
                h1 { color: #1f2937; margin-bottom: 10px; }
                p { color: #6b7280; line-height: 1.6; }
                .success { color: #10b981; font-weight: 600; margin: 20px 0; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>✓ Authentication Successful!</h1>
                <p class="success">Google Workspace tokens saved.</p>
                <p>You can now close this window.</p>
                <p style="margin-top: 30px; font-size: 12px; color: #9ca3af;">
                  Tokens stored at: <code>${AUTH_FILE}</code>
                </p>
              </div>
            </body>
          </html>
        `);

        // Give browser time to display success message before closing
        setTimeout(() => {
          serverReference.close();
          resolve(tokens);
        }, 500);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Token exchange failed: ${error.message}`);
        serverReference.close();
        reject(error);
      }
    });

    server.listen(19876, '127.0.0.1', () => {
      console.error('✓ OAuth callback server listening on http://127.0.0.1:19876/mcp/oauth/callback');
      serverReference = server;
    });

    server.on('error', reject);
  });
}

function openBrowser(url) {
  return new Promise((resolve) => {
    const commands = {
      win32: `start "" "${url}"`,
      darwin: `open "${url}"`,
      linux: `xdg-open "${url}"`
    };

    const cmd = commands[process.platform];
    if (!cmd) {
      console.error(`\n→ Please open this URL in your browser:\n${url}\n`);
      resolve();
      return;
    }

    spawn(cmd, { shell: true, stdio: 'ignore' });
    resolve();
  });
}

async function initializeOAuth() {
  debugLog('initializeOAuth() started');
  
  console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('  Google Workspace MCP - First Time Setup');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const clientId = getClientId();
  const clientSecret = getClientSecret();

  if (!clientId || !clientSecret) {
    debugLog('OAuth credentials missing - exiting');
    console.error('✗ Error: OAuth credentials not found');
    console.error('\nAdd them to opencode.jsonc:');
    console.error('  "google-workspace": {');
    console.error('    "env": {');
    console.error('      "GOOGLE_CLIENT_ID": "your-client-id-here",');
    console.error('      "GOOGLE_CLIENT_SECRET": "your-secret-here"');
    console.error('    }');
    console.error('  }\n');
    process.exit(1);
  }

  debugLog('OAuth credentials validated');
  console.error('✓ OAuth credentials loaded\n');
  console.error('Starting OAuth flow...\n');

  try {
    debugLog('Generating auth URL...');
    const authUrl = generateAuthUrl(clientId);
    debugLog('Auth URL generated:', authUrl.substring(0, 100) + '...');
    
    // Start callback server but don't wait for it yet
    debugLog('Starting callback server...');
    const callbackServerPromise = startCallbackServer(clientId, clientSecret);
    
    // Open browser immediately
    debugLog('Opening browser...');
    await openBrowser(authUrl);
    
    console.error('→ Opening browser for Google login...');
    console.error(`→ If browser didn't open, visit:\n   ${authUrl}\n`);
    
    // Now wait for the callback to complete
    debugLog('Waiting for OAuth callback...');
    await callbackServerPromise;

  } catch (error) {
    console.error(`✗ OAuth setup failed: ${error.message}\n`);
    process.exit(1);
  }
}

// ========================================================================
// Tool Definitions
// ========================================================================

const TOOL_DEFINITIONS = [
  // ========== CHAT TOOLS ==========
  {
    name: 'chat_search_conversations',
    description: 'Searches for Google Chat spaces by display name. Lists all spaces the user is a member of.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceNameQuery: {
          type: 'string',
          description: 'Optional. Text to search for within space display names (case-insensitive substring).'
        },
        pageSize: {
          type: 'integer',
          description: 'Optional. Max spaces to return (default: 100, max: 100).'
        },
        pageToken: {
          type: 'string',
          description: 'Optional. Pagination token from previous call.'
        }
      }
    }
  },
  {
    name: 'chat_list_messages',
    description: 'Retrieves messages from a specified Google Chat space. Returns newest messages first.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Required. The conversation ID (format: spaces/{space})'
        },
        threadId: {
          type: 'string',
          description: 'Optional. Filter to specific thread (format: spaces/{space}/threads/{thread})'
        },
        pageSize: {
          type: 'integer',
          description: 'Optional. Max messages to return (default: 20, max: 50)'
        },
        pageToken: {
          type: 'string',
          description: 'Optional. Pagination token from previous call'
        },
        startTime: {
          type: 'string',
          description: 'Optional. ISO 8601 timestamp - only messages after this time'
        },
        endTime: {
          type: 'string',
          description: 'Optional. ISO 8601 timestamp - only messages before this time'
        }
      },
      required: ['conversationId']
    }
  },
  {
    name: 'chat_search_messages',
    description: 'Searches for Google Chat messages using keywords and filters.',
    inputSchema: {
      type: 'object',
      properties: {
        searchParameters: {
          type: 'object',
          properties: {
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to filter messages by'
            },
            conversationId: {
              type: 'string',
              description: 'Optional. Scope search to specific conversation'
            },
            sender: {
              type: 'string',
              description: 'Optional. Filter by sender email or user ID'
            },
            startTime: {
              type: 'string',
              description: 'Optional. Only messages after this time (ISO 8601)'
            },
            endTime: {
              type: 'string',
              description: 'Optional. Only messages before this time (ISO 8601)'
            },
            hasLink: {
              type: 'boolean',
              description: 'Optional. Filter to messages containing URLs'
            }
          }
        },
        orderBy: {
          type: 'string',
          enum: ['ORDER_BY_UNSPECIFIED', 'CREATE_TIME_DESC', 'CREATE_TIME_ASC', 'RELEVANCE_DESC'],
          description: 'Sort order (default: RELEVANCE_DESC)'
        },
        pageSize: {
          type: 'integer',
          description: 'Max results to return (default: 25, max: 100)'
        },
        pageToken: {
          type: 'string',
          description: 'Pagination token'
        }
      },
      required: ['searchParameters']
    }
  },
  {
    name: 'chat_send_message',
    description: 'Sends a message to a Google Chat space.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Required. Conversation ID (format: spaces/{space})'
        },
        messageText: {
          type: 'string',
          description: 'Required. Message text (supports Markdown formatting)'
        },
        threadId: {
          type: 'string',
          description: 'Optional. Thread ID to reply to'
        }
      },
      required: ['conversationId', 'messageText']
    }
  },

  // ========== GMAIL TOOLS ==========
  {
    name: 'gmail_list_messages',
    description: 'Lists Gmail messages with optional filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional. Gmail search query (e.g., "from:user@example.com", "is:unread")'
        },
        maxResults: {
          type: 'integer',
          description: 'Optional. Max results (default: 10, max: 100)'
        },
        pageToken: {
          type: 'string',
          description: 'Optional. Pagination token from previous call'
        }
      }
    }
  },
  {
    name: 'gmail_get_message',
    description: 'Retrieves full details of a specific Gmail message.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Required. The message ID'
        },
        format: {
          type: 'string',
          enum: ['full', 'metadata', 'minimal', 'raw'],
          description: 'Optional. Response format (default: full)'
        }
      },
      required: ['messageId']
    }
  },
  {
    name: 'gmail_search_messages',
    description: 'Searches Gmail messages with flexible query syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Required. Gmail search query'
        },
        maxResults: {
          type: 'integer',
          description: 'Optional. Max results (default: 25, max: 100)'
        },
        pageToken: {
          type: 'string',
          description: 'Optional. Pagination token'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'gmail_send_message',
    description: 'Sends a new Gmail message.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Required. Recipient email address'
        },
        subject: {
          type: 'string',
          description: 'Required. Email subject'
        },
        body: {
          type: 'string',
          description: 'Required. Email body (plain text)'
        },
        cc: {
          type: 'string',
          description: 'Optional. CC email address(es), comma-separated'
        },
        bcc: {
          type: 'string',
          description: 'Optional. BCC email address(es), comma-separated'
        }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'gmail_list_labels',
    description: 'Lists all Gmail labels and their message counts.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'gmail_modify_message',
    description: 'Adds or removes labels from a Gmail message.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Required. The message ID'
        },
        addLabels: {
          type: ['string', 'array'],
          description: 'Optional. Label ID(s) to add'
        },
        removeLabels: {
          type: ['string', 'array'],
          description: 'Optional. Label ID(s) to remove'
        }
      },
      required: ['messageId']
    }
  },

  // ========== CALENDAR TOOLS ==========
  {
    name: 'calendar_list_events',
    description: 'Lists calendar events within a time range.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Optional. Calendar ID (default: primary)'
        },
        timeMin: {
          type: 'string',
          description: 'Optional. Lower bound (ISO 8601, e.g., 2026-07-03T00:00:00Z)'
        },
        timeMax: {
          type: 'string',
          description: 'Optional. Upper bound (ISO 8601)'
        },
        maxResults: {
          type: 'integer',
          description: 'Optional. Max events (default: 10, max: 250)'
        },
        pageToken: {
          type: 'string',
          description: 'Optional. Pagination token'
        }
      }
    }
  },
  {
    name: 'calendar_get_event',
    description: 'Retrieves full details of a specific calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Optional. Calendar ID (default: primary)'
        },
        eventId: {
          type: 'string',
          description: 'Required. The event ID'
        }
      },
      required: ['eventId']
    }
  },
  {
    name: 'calendar_create_event',
    description: 'Creates a new calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Optional. Calendar ID (default: primary)'
        },
        title: {
          type: 'string',
          description: 'Required. Event title'
        },
        description: {
          type: 'string',
          description: 'Optional. Event description'
        },
        start: {
          type: 'string',
          description: 'Required. Start time (ISO 8601, e.g., 2026-07-03T14:00:00Z)'
        },
        end: {
          type: 'string',
          description: 'Required. End time (ISO 8601)'
        },
        location: {
          type: 'string',
          description: 'Optional. Event location'
        },
        attendeeEmails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. List of attendee emails'
        }
      },
      required: ['title', 'start', 'end']
    }
  },
  {
    name: 'calendar_update_event',
    description: 'Updates an existing calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Optional. Calendar ID (default: primary)'
        },
        eventId: {
          type: 'string',
          description: 'Required. The event ID'
        },
        title: {
          type: 'string',
          description: 'Optional. New event title'
        },
        description: {
          type: 'string',
          description: 'Optional. New event description'
        },
        start: {
          type: 'string',
          description: 'Optional. New start time (ISO 8601)'
        },
        end: {
          type: 'string',
          description: 'Optional. New end time (ISO 8601)'
        },
        location: {
          type: 'string',
          description: 'Optional. New event location'
        }
      },
      required: ['eventId']
    }
  },
  {
    name: 'calendar_delete_event',
    description: 'Deletes a calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Optional. Calendar ID (default: primary)'
        },
        eventId: {
          type: 'string',
          description: 'Required. The event ID'
        }
      },
      required: ['eventId']
    }
  },
  {
    name: 'calendar_find_free_slots',
    description: 'Finds free time slots in the calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Optional. Calendar ID (default: primary)'
        },
        timeMin: {
          type: 'string',
          description: 'Required. Start time (ISO 8601)'
        },
        timeMax: {
          type: 'string',
          description: 'Required. End time (ISO 8601)'
        },
        interval: {
          type: 'integer',
          description: 'Optional. Slot duration in minutes (default: 30)'
        }
      },
      required: ['timeMin', 'timeMax']
    }
  }
];

// ========================================================================
// MCP Server Setup
// ========================================================================

const server = new Server(
  {
    name: 'google-workspace',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    // Chat tools
    if (name === 'chat_search_conversations') {
      result = await chatService.search_conversations(args || {});
    } else if (name === 'chat_list_messages') {
      result = await chatService.list_messages(args || {});
    } else if (name === 'chat_search_messages') {
      result = await chatService.search_messages(args || {});
    } else if (name === 'chat_send_message') {
      result = await chatService.send_message(args || {});
    }

    // Gmail tools
    else if (name === 'gmail_list_messages') {
      result = await gmailService.list_messages(args || {});
    } else if (name === 'gmail_get_message') {
      result = await gmailService.get_message(args || {});
    } else if (name === 'gmail_search_messages') {
      result = await gmailService.search_messages(args || {});
    } else if (name === 'gmail_send_message') {
      result = await gmailService.send_message(args || {});
    } else if (name === 'gmail_list_labels') {
      result = await gmailService.list_labels();
    } else if (name === 'gmail_modify_message') {
      result = await gmailService.modify_message(args || {});
    }

    // Calendar tools
    else if (name === 'calendar_list_events') {
      result = await calendarService.list_events(args || {});
    } else if (name === 'calendar_get_event') {
      result = await calendarService.get_event(args || {});
    } else if (name === 'calendar_create_event') {
      result = await calendarService.create_event(args || {});
    } else if (name === 'calendar_update_event') {
      result = await calendarService.update_event(args || {});
    } else if (name === 'calendar_delete_event') {
      result = await calendarService.delete_event(args || {});
    } else if (name === 'calendar_find_free_slots') {
      result = await calendarService.find_free_slots(args || {});
    }

    else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

// ========================================================================
// Main
// ========================================================================

async function main() {
  debugLog('main() called');
  
  try {
    // Start MCP server FIRST so OpenCode gets the initialize response
    debugLog('Creating StdioServerTransport...');
    console.error('\n✓ Starting Google Workspace MCP server...');
    const transport = new StdioServerTransport();
    
    debugLog('Connecting server to transport...');
    await server.connect(transport);
    debugLog('Server connected successfully');
    
    // Then check tokens - OAuth runs in background, tools will error until it completes
    const hasTokens = tokensExist();
    debugLog('Tokens exist?', hasTokens);
    
    if (!hasTokens) {
      debugLog('Starting OAuth initialization in background...');
      initializeOAuth().catch(err => {
        debugLog('OAuth failed:', err.message, err.stack);
        console.error('OAuth setup failed:', err.message);
        process.exit(1);
      });
    } else {
      debugLog('Tokens found, skipping OAuth');
    }
    
    console.error('✓ Server running with 16 tools (Chat, Gmail, Calendar)');
    debugLog('Server ready and listening');
  } catch (error) {
    debugLog('FATAL ERROR in main():', error.message, error.stack);
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();

// Catch any unhandled errors
process.on('uncaughtException', (err) => {
  debugLog('UNCAUGHT EXCEPTION:', err.message, err.stack);
  console.error('Uncaught exception:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  debugLog('UNHANDLED REJECTION:', err);
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
