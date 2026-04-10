# Confluence Database Reader

Claude Code skill for reading Confluence Database tables via Canvas API + Yjs CRDT decode.

## What is a Confluence Database?

**Confluence Database** is a standalone content type in Confluence Cloud (GA since August 2024) — a structured table with typed columns, filters, views, and sorting. It is **not** a regular table inside a Confluence page.

How to tell the difference:

| | Confluence Database | Regular page table |
|---|---|---|
| URL | `/wiki/spaces/XX/database/123456` | `/wiki/spaces/XX/pages/123456` |
| CQL type | `type = "database"` | `type = "page"` |
| `getConfluencePage` | Returns **404** | Returns page content |
| Created via | "+" → "Database" in space sidebar | Insert table inside a page editor |
| Has views/filters | Yes (built-in) | No |
| Column types | Text, Select, Person, Date, Number, Page Link | Plain text only |

**This skill reads Confluence Databases.** For regular page tables, use `getConfluencePage` with `body.storage` — no special skill needed.

## Problem

Confluence Databases have **no REST API for reading row data** ([CONFCLOUD-77328](https://jira.atlassian.com/browse/CONFCLOUD-77328)). The standard `getConfluencePage` returns 404 for database content.

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

Works with **any Confluence Cloud** instance. The skill runs onboarding on first use — checks everything and guides you through setup.

**Auto-handled (skill checks and fixes):**
- **Node.js** — onboarding detects, suggests `brew install node`
- **yjs** — auto-installs via `npm install yjs`

**You need beforehand:**
- **Chrome MCP** ([Control Chrome](https://chromewebstore.google.com/detail/control-chrome-mcp-server/lhoefnbcfegijhgmgbdaingbhbclhgab) or [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome/jjddolbgeaodckkcjakddoekmmknokpb)) — browser extension must be installed and connected
- **Logged into Confluence** in Chrome — the skill needs your browser session to obtain a Canvas API token

**Optional:**
- **Atlassian MCP** — for resolving user display names. Without it, person fields return account IDs instead of names

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
