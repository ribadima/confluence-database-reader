---
name: confluence-database
description: "Read data from Confluence Database tables. Use when user asks to read a Confluence database, table, or URL matches /database/. Handles onboarding: checks Chrome MCP, Atlassian MCP, Node.js + yjs prerequisites. Используй когда пользователь просит прочитать таблицу из Confluence, Confluence database, или даёт ссылку на /database/."
argument-hint: "[URL таблицы или content ID]"
allowed-tools: Bash, Read, Write, Grep, Glob
---

# Confluence Database Reader

Read structured data from Confluence Database objects via Canvas API + Yjs decode.

## Language Rule

Always respond in the **language of the user's request**.

## Capability Mode

**Triggers:** "what can you do", "что умеешь", "help", "capabilities"

Respond with:
- Reads Confluence Database tables (the new table-type content, not page tables)
- Works via Canvas API + Yjs CRDT decode (primary) or DOM scraping (fallback)
- Resolves all field types: text, select, hyperlink, person, number, date
- Resolves user display names via Atlassian API
- Does NOT write to databases — read-only
- Does NOT work with regular Confluence page tables — use `getConfluencePage` for those

## Phase 0: Onboarding

Run this check on **first invocation per session**. Skip if `/tmp/.confluence-db-onboarded` exists.

### Step 0.1 — Check Prerequisites

Run these checks in parallel:

**Chrome MCP:**
```
Call: mcp__Control_Chrome__get_current_tab
Pass: returns tab info → "connected"
Fail: error/timeout → "not connected"
```

**Atlassian MCP:**
```
Call: mcp__21ec6106-62e6-4608-a1ee-654b1367a5c1__atlassianUserInfo
Pass: returns user info → "connected (user: {name})"
Fail: error → "not connected"
```

**Node.js:**
```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && node -v
```

**yjs package:**
```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && node -e "require('/tmp/node_modules/yjs'); console.log('ok')" 2>&1
```

### Step 0.2 — Display Status

Output a status table:

```
Prerequisites Check:
✅ Chrome MCP — connected
✅ Atlassian MCP — connected (user: Dmitry Rybalka)
✅ Node.js — v25.6.1
✅ yjs — installed
```

### Step 0.3 — Auto-fix Issues

- **yjs missing:** Auto-install: `cd /tmp && npm install yjs`
- **Chrome MCP missing:** Tell user: "Chrome MCP is required for Canvas token. Open Chrome with MCP extension."
- **Atlassian MCP missing:** Non-blocking warning: "User name resolution will return account IDs instead of names."
- **Node.js missing:** Blocking error: "Node.js is required for Yjs decode. Install via: brew install node"

### Step 0.4 — Save Onboarding Flag

If all blocking prerequisites pass:
```bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/.confluence-db-onboarded
```

## Phase 1: Parse Input

Extract `contentId` from user input:

| Input Format | Extraction |
| --- | --- |
| `https://{site}.atlassian.net/wiki/spaces/{key}/database/{id}` | `{id}` |
| `https://{site}.atlassian.net/wiki/x/{tinyId}` | Resolve via CQL search |
| Numeric ID (e.g. `4307976195`) | Direct use |
| Database name (e.g. "Members · DS") | Search via CQL: `type = "database" AND title = "{name}"` |

**CQL search via MCP:**
```
Tool: searchConfluenceUsingCql
Input: { cloudId: "{site}.atlassian.net", cql: "type = \"database\" AND space = \"{spaceKey}\"" }
```

## Phase 2: Get Metadata

Get `referenceId` via Chrome MCP (REST API v1 requires session cookies):

```
Tool: Control Chrome → execute_javascript
Code:
  fetch('/wiki/rest/api/content/{contentId}', {credentials:'include'})
  .then(r => r.json())
  .then(d => JSON.stringify({title: d.title, referenceId: d.referenceId, cloudId: '129eb80d-7ac7-4c64-8246-d7d7fec8a71a'}))
```

Extract: `title`, `referenceId`.

**Note:** cloudId for Larixon is `129eb80d-7ac7-4c64-8246-d7d7fec8a71a`.

## Phase 3: Get Canvas Token

```
Tool: Control Chrome → execute_javascript
Code:
  fetch('/gateway/api/graphql', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      operationName: 'GetCanvasToken',
      query: 'query GetCanvasToken { canvasToken(contentId: "{contentId}") { token expiryDateTime } }'
    })
  }).then(r => r.json()).then(d => d.data.canvasToken.token)
```

Save the token — it's valid for ~15 minutes.

## Phase 4: Fetch + Decode

**Fetch (headless via Bash):**

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
curl -s \
  -H "X-Access-Token: {TOKEN}" \
  "https://larixon.atlassian.net/gateway/api/canvas/api/_internal/collab/ari%3Acloud%3Acanvas%3A{CLOUD_ID}%3Adatabase%2F{REFERENCE_ID}?skipSteps=true&v=2" \
  -o /tmp/cfdb_{CONTENT_ID}.bin
```

**Decode (headless via Bash + Node.js):**

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node -e "
const Y = require('/tmp/node_modules/yjs');
const fs = require('fs');
const data = fs.readFileSync('/tmp/cfdb_{CONTENT_ID}.bin');
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(data));
const fbi = doc.getMap('fbi').toJSON();
const ebi = doc.getMap('ebi').toJSON();
const vbi = doc.getMap('vbi').toJSON();

function resolveCell(colDef, cell) {
  if (!cell || cell.v === undefined) return '';
  switch (cell.t) {
    case 't': return cell.v || '';
    case 's': return Array.isArray(cell.v) ? cell.v.map(id => (colDef.sso||[]).find(o=>o.i===id)?.l||id).join(', ') : cell.v;
    case 'h': return Array.isArray(cell.v) ? cell.v.map(l => (colDef.sso||[]).find(o=>o.i===l.i)?.l||(l.u||l.i)).join(', ') : cell.v;
    case 'u': return Array.isArray(cell.v) ? cell.v.map(u => u.a||u.i||'').join(', ') : cell.v;
    default: return typeof cell.v === 'object' ? JSON.stringify(cell.v) : (cell.v ?? '');
  }
}

const columns = Object.entries(fbi).map(([id,c])=>({id,name:c.n,type:c.t}));
const rows = Object.entries(ebi).map(([rid,cells])=>{
  const row = {};
  for (const [cid,cell] of Object.entries(cells)) {
    row[fbi[cid]?.n||cid] = resolveCell(fbi[cid], cell);
  }
  return row;
});
const aids = new Set();
for (const r of Object.values(ebi)) for (const c of Object.values(r)) if (c.t==='u'&&Array.isArray(c.v)) c.v.forEach(u=>{if(u.a)aids.add(u.a)});

console.log(JSON.stringify({
  view: Object.values(vbi)[0]?.n||'',
  columns: columns.map(c=>({name:c.name,type:c.type})),
  rowCount: rows.length,
  rows,
  accountIdsToResolve: [...aids]
}));
"
```

## Phase 5: Resolve User Names

If `accountIdsToResolve` is non-empty, resolve each via MCP Atlassian:

```
Tool: lookupJiraAccountId
Input: { cloudId: "{site}.atlassian.net", searchString: "{accountId}" }
```

Replace account IDs in rows with display names.

## Phase 6: Output

Format as a markdown table for the user:

```markdown
**{title}** (view: {viewName})

| # | Col1 | Col2 | Col3 |
|---|------|------|------|
| 1 | val  | val  | val  |
| 2 | val  | val  | val  |
```

## Error Recovery

| Error | Action |
| --- | --- |
| Canvas 401 | Token expired — re-run Phase 3 |
| REST 404 | Not a database — check content type via CQL |
| Yjs decode fails | Verify binary file, not JSON error |
| Chrome MCP unavailable | Cannot proceed — tell user to connect Chrome |
| Empty rows/columns | Database may be empty — confirm with user |

## Anti-Hallucination Baseline

1. Never invent APIs, endpoints, or field types not documented in `references/yjs-schema.md`.
2. Verify data by comparing row count and column names after decode.
3. If Yjs schema changes (new field types), warn user and return raw values.
4. Do not guess user display names — always resolve via API.

## Handoff Contract

```
Handoff:
- Task: Read Confluence Database "{title}"
- Scope: {rowCount} rows × {columnCount} columns extracted
- Artifacts: /tmp/cfdb_{contentId}.bin (Yjs binary), parsed JSON
- Decisions: Method A (API Pipeline) used
- Risks: Canvas token expires in ~15 min
- Next command: N/A
```
