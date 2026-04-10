---
name: confluence-database
description: "Read data from Confluence Database tables (the standalone database content type, NOT regular page tables). Use when: URL contains /database/, getConfluencePage returns 404, CQL returns type='database', or user asks to read a Confluence database/table. Handles onboarding: checks Chrome MCP, Atlassian MCP, Node.js + yjs. Используй когда: ссылка содержит /database/, getConfluencePage возвращает 404, пользователь просит прочитать таблицу/database из Confluence."
argument-hint: "[URL таблицы или content ID]"
allowed-tools: Bash, Read, Write, Grep, Glob
---

# Confluence Database Reader

Read structured data from Confluence Database objects via Canvas API + Yjs decode.

## Language Rule

Always respond in the **language of the user's request**.
- Russian input → Russian response
- English input → English response
Keep skill names and slash commands unchanged.

## Capability Mode

**Triggers:** "what can you do", "что умеешь", "help", "capabilities"

Do NOT launch full workflow. Respond with 4-8 bullets:
- Reads Confluence Database tables (the new table-type content, not page tables)
- Works via Canvas API + Yjs CRDT decode (primary) or DOM scraping (fallback)
- Resolves all field types: text, select, hyperlink, person, number, date
- Resolves user display names via Atlassian API
- Does NOT write to databases — read-only
- Does NOT work with regular Confluence page tables — use `getConfluencePage` for those

Example commands:
- `/confluence-database https://site.atlassian.net/wiki/spaces/XX/database/123456`
- `/confluence-database 1234567890`
- `/confluence-database Members · DS`

## Phase 0: Onboarding

Run this check on **first invocation per session**. Skip if `/tmp/.confluence-db-onboarded` exists.

### Step 0.1 — Check Prerequisites

Run these checks in parallel:

**Chrome MCP:**
```
Call: Control Chrome → get_current_tab
Pass: returns tab info → "connected"
Fail: error/timeout → "not connected"
```

**Atlassian MCP:**
```
Call: Atlassian MCP → atlassianUserInfo
Pass: returns user info → "connected (user: {name})"
Fail: error → "not connected"
Note: MCP tool UUID may change if connector is re-added. Use tool search if UUID is stale.
```

**Node.js:**
```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && node -v
```

**yjs package:**
```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && node -e "try{require('yjs');console.log('ok')}catch(e){try{require('/tmp/node_modules/yjs');console.log('ok')}catch(e2){console.log('missing')}}" 2>&1
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

Extract `contentId` and `site` from user input:

| Input Format | Extraction |
| --- | --- |
| `https://{site}.atlassian.net/wiki/spaces/{key}/database/{id}` | `site` and `{id}` from URL |
| `https://{site}.atlassian.net/wiki/x/{tinyId}` | `site` from URL, resolve ID via CQL |
| Numeric ID (e.g. `1234567890`) | Direct use, ask user for site if unknown |
| Database name (e.g. "Members · DS") | Search via CQL: `type = "database" AND title = "{name}"` |

If `site` is not provided, resolve via Atlassian MCP `getAccessibleAtlassianResources`.

**CQL search via MCP:**
```
Tool: Atlassian MCP → searchConfluenceUsingCql
Input: { cloudId: "{site}.atlassian.net", cql: "type = \"database\" AND space = \"{spaceKey}\"" }
```

## Phase 2: Get Metadata

Get `referenceId` and `cloudId` dynamically via Chrome MCP:

```
Tool: Control Chrome → execute_javascript
Code:
  fetch('/wiki/rest/api/content/{contentId}', {credentials:'include'})
  .then(r => r.json())
  .then(d => {
    var cloudId = document.querySelector('meta[name="ajs-cloud-id"]')?.content || '';
    return JSON.stringify({title: d.title, referenceId: d.referenceId, cloudId: cloudId});
  })
```

**Important:** `cloudId` is extracted from the page's meta tag — NOT hardcoded. Chrome must be on the target Confluence domain for relative URLs to work.

Extract: `title`, `referenceId`, `cloudId`.

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

The site URL and cloudId are derived from Phase 1 and Phase 2 — never hardcoded.

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
curl -s \
  -H "X-Access-Token: {TOKEN}" \
  "https://{SITE}.atlassian.net/gateway/api/canvas/api/_internal/collab/ari%3Acloud%3Acanvas%3A{CLOUD_ID}%3Adatabase%2F{REFERENCE_ID}?skipSteps=true&v=2" \
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
    case 'n': return cell.v;
    case 'd': return cell.v;
    default:
      process.stderr.write('WARN: unknown field type ' + cell.t + ' in column ' + (colDef?.n||'?') + '\n');
      return typeof cell.v === 'object' ? JSON.stringify(cell.v) : (cell.v ?? '');
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

If `accountIdsToResolve` is non-empty, resolve display names via Chrome MCP:

```
Tool: Control Chrome → execute_javascript
Code:
  fetch('/wiki/rest/api/user?accountId={accountId}', {credentials:'include'})
  .then(r => r.json())
  .then(d => d.displayName)
```

Batch all unique account IDs. If Atlassian MCP is available, `lookupJiraAccountId` can also be used as a fallback (search by account ID string).

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
| Unknown field type | Log warning, return raw value |

## Anti-Hallucination Baseline

1. Never invent APIs, endpoints, or field types not documented in `references/yjs-schema.md`.
2. Verify data by comparing row count and column names after decode.
3. If Yjs schema changes (new field types), warn user and return raw values.
4. Do not guess user display names — always resolve via API.
5. Do not execute destructive actions without explicit user confirmation.

## Handoff Contract

```
Handoff:
- Task: Read Confluence Database "{title}"
- Scope: {rowCount} rows × {columnCount} columns extracted
- Artifacts: /tmp/cfdb_{contentId}.bin (Yjs binary), parsed JSON
- Decisions: Method A (API Pipeline) used
- Validation: Row count and column names verified against metadata
- Risks: Canvas token expires in ~15 min
- Next command: N/A
```
