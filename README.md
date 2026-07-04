# Google Workspace MCP

A unified MCP server for Google Workspace APIs: Chat, Gmail, and Calendar.

## Installation

```bash
npm install
```

## Setup

The MCP handles authentication automatically via OpenCode:

1. **First Run**: When OpenCode starts the MCP, it passes `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` via environment variables
2. **OAuth Flow**: On first run, the server checks for tokens in `~/.local/share/opencode/mcp-auth.json`
3. **If No Tokens**: Server initiates OAuth flow (browser login)
4. **Subsequent Runs**: Tokens are loaded automatically

**No manual setup needed** when running via OpenCode.

### Manual Setup (if needed)

For testing outside OpenCode, set environment variables and run the server:

```bash
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="your-secret-here"
node server.js
```

The server will detect missing tokens and initiate OAuth flow automatically.

## Usage

The MCP provides 16 tools across 3 services:

### Chat (4 tools)
- `chat_search_conversations` — Search/list Google Chat spaces
- `chat_list_messages` — Retrieve messages from a space or thread
- `chat_search_messages` — Search messages by keywords, sender, time
- `chat_send_message` — Send message to space or reply to thread

### Gmail (6 tools)
- `gmail_list_messages` — List emails with optional query
- `gmail_get_message` — Retrieve full message details
- `gmail_search_messages` — Search emails with Gmail syntax
- `gmail_send_message` — Send new email
- `gmail_list_labels` — List all labels and counts
- `gmail_modify_message` — Add/remove labels from message

### Calendar (6 tools)
- `calendar_list_events` — List events in time range
- `calendar_get_event` — Retrieve event details
- `calendar_create_event` — Create new calendar event
- `calendar_update_event` — Modify existing event
- `calendar_delete_event` — Delete calendar event
- `calendar_find_free_slots` — Find available time slots

## Testing

```bash
npm run test
```

Tests require tokens to exist. Run `npm run setup` first if you haven't authenticated.

## Configuration

The MCP is configured in `opencode.jsonc`:

```json
{
  "mcp": {
    "google-workspace": {
      "type": "local",
      "command": ["node", "D:\\OneDrive\\Workspace\\google-workspace-mcp\\server.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id-here.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "your-secret-here"
      },
      "enabled": true
    }
  }
}
```

Both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be set for OAuth to work.

## Architecture

- `server.js` — MCP dispatcher with all 16 tools (receives env from OpenCode)
- `services/` — Modular service implementations (Chat, Gmail, Calendar)
- `utils/` — Shared OAuth token management and HTTP client

## Token Refresh

Tokens are automatically refreshed when:
- Access token expires (< 60 seconds remaining)
- A tool request is made

Refresh logic is transparent — no manual intervention needed.

See `AGENTS.md` for repository conventions, contribution guidance, and security notes.
