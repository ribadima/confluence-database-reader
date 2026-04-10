---
name: confluence-database
description: "Read data from Confluence Database tables (the standalone database content type in Confluence Cloud, NOT regular page tables). Use when: URL contains /database/, getConfluencePage returns 404, CQL type='database', or user mentions Confluence database/table. Trigger on: 'прочитай таблицу из конфлюенса', 'что в этой базе данных', 'open this confluence table', 'extract data from confluence db', any atlassian.net/database/ URL. Do NOT use for regular Confluence page tables or inline tables — use getConfluencePage for those."
argument-hint: "[URL таблицы или content ID]"
license: MIT
metadata:
  author: ribadima
  version: 3.1.0
  repository: https://github.com/ribadima/confluence-database-reader
  compatibility: Requires Chrome MCP for Canvas token auth. Requires Node.js + yjs for decode. Works with any Confluence Cloud instance.
---

# Confluence Database Reader

Read structured data from Confluence Database objects via Canvas API + Yjs decode.

**Speed target: 3 tool calls for standard URLs, 4 for tiny URLs.**

## Language Rule

Always respond in the **language of the user's request**.
- Russian input → Russian response
- English input → English response

## Capability Mode

**Triggers:** "what can you do", "что умеешь", "help", "capabilities"

Do NOT launch full workflow. Respond with bullets:
- Reads Confluence Database tables (the new table-type content, not page tables)
- Works via Canvas API + Yjs CRDT decode
- Resolves all field types: text, select, hyperlink, person, number, date
- Resolves user display names via Atlassian API
- Does NOT write to databases — read-only
- Does NOT work with regular Confluence page tables — use `getConfluencePage` for those

## Phase 0: Onboarding

Skip if `/tmp/.confluence-db-onboarded` exists. Otherwise run checks in parallel:

- **Chrome MCP:** `ControlChrome:get_current_tab` → connected/not
- **Atlassian MCP:** `atlassianUserInfo` → connected/not (non-blocking)
- **Node.js + yjs:** single Bash: `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && node -v && node -e "try{require('yjs');console.log('yjs:ok')}catch(e){try{require('/tmp/node_modules/yjs');console.log('yjs:ok')}catch(e2){console.log('yjs:missing')}}" 2>&1`

Auto-fix: yjs missing → `cd /tmp && npm install yjs`. Save flag: `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/.confluence-db-onboarded`

## Phase 1: Parse Input → contentId + site

| Input | How |
|-------|-----|
| `https://{site}.atlassian.net/wiki/spaces/{key}/database/{id}` | Parse directly: site + id |
| `https://{site}.atlassian.net/wiki/x/{tinyId}` | `open_url` → read `window.location.href` from resolved page |
| Numeric ID | Direct use, resolve site via Atlassian MCP if unknown |
| Database name | CQL: `type = "database" AND title = "{name}"` |

For tiny URLs: open the URL in Chrome, then read `window.location.href` to get the resolved `/database/{id}` URL.

## Phase 2: Metadata + Token (ONE Chrome call)

Combine metadata fetch and canvas token into a **single** `execute_javascript` call using `Promise.all`:

```javascript
(async () => {
  const cid = '{CONTENT_ID}';
  const [meta, tok] = await Promise.all([
    fetch('/wiki/rest/api/content/' + cid, {credentials:'include'}).then(r => r.json()),
    fetch('/gateway/api/graphql', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        operationName: 'GetCanvasToken',
        query: 'query GetCanvasToken { canvasToken(contentId: "' + cid + '") { token expiryDateTime } }'
      })
    }).then(r => r.json())
  ]);
  const cloudId = document.querySelector('meta[name="ajs-cloud-id"]')?.content || '';
  document.title = JSON.stringify({
    token: tok.data.canvasToken.token, site: '{SITE}', cloudId: cloudId,
    referenceId: meta.referenceId, contentId: cid, title: meta.title
  });
})();
```

Then read result: `document.title` → parse JSON → extract token, site, cloudId, referenceId, contentId, title.

**Important:** Chrome must be on the target Confluence domain. If Chrome is on a different domain, first `open_url` to any page on `{site}.atlassian.net/wiki/` so relative fetches work.

**Important:** The `document.title` JSON must include all fields needed for Phase 3: `token`, `site`, `cloudId`, `referenceId`, `contentId`, `title`.

## Phase 3: Fetch + Decode (ONE Bash call)

Save the `document.title` JSON to a temp file, then pass it to `fetch-decode.js`:

```bash
cat << 'EOF' > /tmp/cfdb_params.json
{DOCUMENT_TITLE_JSON}
EOF
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node ~/.claude/skills/confluence-database/scripts/fetch-decode.js /tmp/cfdb_params.json
```

**Why a file?** JWT tokens are ~1400 chars and get corrupted when passed as CLI arguments due to shell escaping. The JSON file approach is reliable.

Output: JSON with `view`, `columns`, `rows`, `rowCount`, `accountIdsToResolve`.

## Phase 4: Resolve User Names (ONE Chrome call, only if needed)

Skip if `accountIdsToResolve` is empty.

Batch ALL account IDs in a single `execute_javascript`:

```javascript
(async () => {
  const ids = ['{ID1}', '{ID2}'];
  const results = await Promise.all(ids.map(id =>
    fetch('/wiki/rest/api/user?accountId=' + id, {credentials:'include'})
    .then(r => r.json()).then(d => ({id, name: d.displayName}))
    .catch(() => ({id, name: id}))
  ));
  document.title = JSON.stringify(results);
})();
```

Read `document.title` → replace account IDs with display names in rows.

## Phase 5: Output

```markdown
**{title}** (view: {viewName})

| # | Col1 | Col2 | Col3 |
|---|------|------|------|
| 1 | val  | val  | val  |
```

## Call Summary

| Scenario | Tool calls |
|----------|-----------|
| Standard URL, no users | 2: Chrome(meta+token) → Bash(fetch+decode) |
| Standard URL, with users | 3: Chrome(meta+token) → Bash(fetch+decode) → Chrome(resolve users) |
| Tiny URL, no users | 3: Chrome(open+resolve URL) → Chrome(meta+token) → Bash(fetch+decode) |
| Tiny URL, with users | 4: Chrome(open) → Chrome(meta+token) → Bash(fetch+decode) → Chrome(users) |

## Error Recovery

| Error | Action |
|-------|--------|
| Canvas 401 | Token expired — re-run Phase 2 |
| REST 404 | Not a database — check via CQL |
| Yjs decode fails | Verify binary, not JSON error page |
| Chrome not on Confluence | `open_url` to target site first |
| Empty rows | Database may be empty — confirm with user |

## Anti-Hallucination

1. Never invent APIs not in `references/yjs-schema.md`
2. Always resolve user names via API, never guess
3. Return raw values for unknown field types

## Handoff Contract

```
Handoff:
- Task: Read Confluence Database "{title}"
- Scope: {rowCount} rows × {columnCount} columns
- Validation: Row count and column names verified
- Risks: Canvas token expires in ~15 min
```
