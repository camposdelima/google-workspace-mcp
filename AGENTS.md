# AGENTS.md

This file provides guidance for contributors and coding agents working in this repository.

## Project Purpose

`google-workspace-mcp` is a local MCP server that exposes Google Workspace capabilities:

- Google Chat
- Gmail
- Calendar

Core entrypoint: `server.js`.

## Local Development

Prerequisites:

- Node.js 22+

Install dependencies:

```bash
npm install
```

Run server:

```bash
npm start
```

Run tests:

```bash
npm test
```

## Configuration

Runtime credentials must be provided through environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Do not hardcode credentials in source files.

## Security Rules

- Never commit real secrets, tokens, or private keys.
- Keep secrets out of logs and examples.
- Use placeholders in docs (for example: `your-secret-here`).
- If a secret is exposed, rotate it immediately in Google Cloud Console.

## Repository Conventions

- Keep service logic modular under `services/`.
- Keep shared auth/http helpers under `utils/`.
- Prefer small, focused changes over broad refactors.
- Update `README.md` when behavior or setup changes.

## Publish Checklist

Before publishing, verify:

1. No sensitive values are committed.
2. `README.md` setup instructions still match the code.
3. `npm test` passes locally.
4. No debug artifacts are tracked.
