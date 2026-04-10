# Confluence Database Reader

Claude Code skill for reading Confluence Database tables via Canvas API + Yjs CRDT decode.

## Problem

Confluence Databases (the new table-type content) have **no REST API for reading row data** ([CONFCLOUD-77328](https://jira.atlassian.com/browse/CONFCLOUD-77328)). The standard `getConfluencePage` returns 404 for database content.

## Solution

This skill uses a reverse-engineered pipeline:

1. **REST API v1** — get database metadata (`referenceId`)
2. **AGG GraphQL** — obtain Canvas JWT token (`canvasToken`)
3. **Canvas Collab API** — download Yjs CRDT binary document
4. **yjs decode** — extract columns (`fbi`), rows (`ebi`), views (`vbi`)
5. **Resolve** — map field types (text, select, hyperlink, person) to readable values

## Install

```bash
# Copy to Claude Code skills directory
cp -r . ~/.claude/skills/confluence-database/
```

Then invoke:

```
/confluence-database https://your-site.atlassian.net/wiki/spaces/XX/database/1234567890
```

## Prerequisites

| Tool | Required | Purpose |
| --- | --- | --- |
| Chrome MCP (Control Chrome) | Yes | Canvas token (session cookies) |
| Atlassian MCP | Optional | User name resolution |
| Node.js | Yes | Yjs CRDT decode |
| yjs npm package | Yes (auto-installed) | Decode library |

The skill checks prerequisites on first run and auto-fixes what it can (e.g., installs `yjs`).

## Supported Field Types

| Code | Type | Resolution |
| --- | --- | --- |
| `t` | Text | Direct |
| `s` | Select / Tag | Resolve via column options |
| `h` | Hyperlink / Page Link | Resolve label from options, URL from value |
| `u` | Person | Atlassian account ID → `lookupJiraAccountId` |
| `n` | Number | Direct |
| `d` | Date | Direct |

## Files

```
├── README.md                  # This file
├── SKILL.md                   # Claude Code skill definition
└── references/
    └── yjs-schema.md          # Yjs document schema + resolveCell function
```

## Limitations

- `canvasToken` requires browser session cookies — no fully headless path
- Token TTL ~15 minutes
- Read-only — cannot write to databases
- Yjs schema is reverse-engineered and may change

## License

MIT
