---
name: confluence-database
description: "Read data from Confluence Database tables (the standalone database content type in Confluence Cloud, NOT regular page tables). Use when: URL contains /database/, getConfluencePage returns 404, CQL type='database', or user mentions Confluence database/table. Trigger on: 'прочитай таблицу из конфлюенса', 'что в этой базе данных', 'open this confluence table', 'extract data from confluence db', any atlassian.net/database/ URL. Do NOT use for regular Confluence page tables or inline tables — use getConfluencePage for those."
argument-hint: "[URL таблицы или content ID]"
license: MIT
metadata:
  author: ribadima
  version: 4.0.0
  repository: https://github.com/ribadima/confluence-database-reader
  compatibility: Requires Chrome MCP only. No Node.js, no npm packages. Yjs loaded from CDN at runtime. Works with any Confluence Cloud instance.
---

# Confluence Database Reader

Read Confluence Database tables via Canvas API + Yjs decode. Everything runs in Chrome — no external dependencies.

## Language Rule

Always respond in the **language of the user's request**.

## Capability Mode

**Triggers:** "what can you do", "что умеешь", "help", "capabilities"

Do NOT launch full workflow. Respond with bullets:
- Reads Confluence Database tables (the new table-type content, not page tables)
- Everything runs in Chrome — no Node.js, no npm, no temp files
- Resolves all field types: text, select, hyperlink, person, number, date
- Resolves user display names automatically
- Read-only — does NOT write to databases

## Phase 0: Onboarding

Skip if `/tmp/.confluence-db-onboarded` exists. Otherwise check:

- **Chrome MCP:** `ControlChrome:get_current_tab` → must be connected
- **Atlassian MCP:** `atlassianUserInfo` → non-blocking, for fallback user resolution

Save flag: `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/.confluence-db-onboarded`

No Node.js or yjs installation needed — Yjs loads from CDN inside Chrome.

## Phase 1: Parse Input → contentId + site

| Input | How |
|-------|-----|
| `https://{site}.atlassian.net/wiki/spaces/{key}/database/{id}` | Parse directly |
| `https://{site}.atlassian.net/wiki/x/{tinyId}` | Resolve inside Phase 2 JS via `fetch(url, {redirect:'follow'}).then(r => r.url.match(/database\/(\d+)/)[1])` — no new tabs |
| Numeric ID | Direct use, resolve site via Atlassian MCP |
| Database name | CQL: `type = "database" AND title = "{name}"` |

**Important:** Chrome must be on the target Confluence domain for relative fetches to work. If not, first `open_url` to `https://{site}.atlassian.net/wiki/`.

## Phase 2: Read Database (ONE Chrome call)

Single `execute_javascript` that does everything in the current tab — **never opens new tabs**.

For tiny URLs, resolve the contentId inside the same JS via `fetch(url, {redirect:'follow'})`.

For multiple tables, pass an array of IDs and use `Promise.all`.

```javascript
(async () => {
  // For tiny URLs: resolve first (no new tab)
  // let cid = await fetch('{TINY_URL}', {credentials:'include', redirect:'follow'})
  //   .then(r => r.url.match(/database\/(\d+)/)?.[1]);
  const cid = '{CONTENT_ID}';

  // Step 1: Metadata + Token (parallel)
  const [meta, tok] = await Promise.all([
    fetch('/wiki/rest/api/content/' + cid, {credentials:'include'}).then(r => r.json()),
    fetch('/gateway/api/graphql', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({operationName:'GetCanvasToken',
        query:'query GetCanvasToken{canvasToken(contentId:"'+cid+'"){token}}'})
    }).then(r => r.json())
  ]);
  const cloudId = document.querySelector('meta[name="ajs-cloud-id"]')?.content;
  const token = tok.data.canvasToken.token;

  // Step 2: Fetch Canvas binary
  const ari = encodeURIComponent('ari:cloud:canvas:' + cloudId + ':database/' + meta.referenceId);
  const bin = await fetch('/gateway/api/canvas/api/_internal/collab/' + ari + '?skipSteps=true&v=2', {
    credentials: 'include', headers: {'X-Access-Token': token}
  }).then(r => r.arrayBuffer());

  // Step 3: Load Yjs from CDN + decode
  const Y = await import('https://cdn.jsdelivr.net/npm/yjs@13.6.24/+esm');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(bin));
  const fbi = doc.getMap('fbi').toJSON();
  const ebi = doc.getMap('ebi').toJSON();
  const vbi = doc.getMap('vbi').toJSON();

  // Step 4: Build rows
  const columns = Object.entries(fbi).map(([id, c]) => ({id, name: c.n, type: c.t}));
  const rows = Object.entries(ebi).map(([, cells]) => {
    const row = {};
    for (const [k, cell] of Object.entries(cells)) {
      const col = fbi[k];
      if (!cell || cell.v === undefined) { row[col?.n || k] = ''; continue; }
      if (cell.t === 't') row[col?.n || k] = cell.v || '';
      else if (cell.t === 's') row[col?.n || k] = Array.isArray(cell.v)
        ? cell.v.map(id => (col.sso || []).find(o => o.i === id)?.l || id).join(', ') : cell.v;
      else if (cell.t === 'u') row[col?.n || k] = Array.isArray(cell.v)
        ? cell.v.map(u => u.a || '').join(', ') : cell.v;
      else if (cell.t === 'h') row[col?.n || k] = Array.isArray(cell.v)
        ? cell.v.map(l => (col.sso || []).find(o => o.i === l.i)?.l || (l.u || l.i)).join(', ') : cell.v;
      else row[col?.n || k] = cell.v;
    }
    return row;
  });

  // Step 5: Resolve user names
  const aids = new Set();
  for (const r of Object.values(ebi))
    for (const c of Object.values(r))
      if (c.t === 'u' && Array.isArray(c.v)) c.v.forEach(u => { if (u.a) aids.add(u.a); });

  if (aids.size > 0) {
    const users = await Promise.all([...aids].map(id =>
      fetch('/wiki/rest/api/user?accountId=' + id, {credentials:'include'})
      .then(r => r.json()).then(d => ({id, name: d.displayName}))
      .catch(() => ({id, name: id}))
    ));
    const um = Object.fromEntries(users.map(u => [u.id, u.name]));
    for (const row of rows) for (const [k, v] of Object.entries(row)) if (um[v]) row[k] = um[v];
  }

  document.title = JSON.stringify({
    title: meta.title,
    view: Object.values(vbi)[0]?.n || '',
    columns: columns.map(c => ({name: c.name, type: c.type})),
    rowCount: rows.length,
    rows
  });
})();
```

## Phase 3: Read Result (ONE Chrome call)

```javascript
document.title
```

Parse JSON → output as markdown table.

## Call Summary

| Scenario | Tool calls |
|----------|-----------|
| Standard URL | **2**: Chrome(execute all) → Chrome(read title) |
| Tiny URL | **2**: Chrome(execute all with resolve) → Chrome(read title) |
| Multiple tables | **2**: Chrome(execute all in batch) → Chrome(read title) |

**Never open new tabs.** Tiny URLs are resolved via `fetch(url, {redirect:'follow'})` inside the same JS. Multiple tables are batched in a single `Promise.all`.

## Output Format

```markdown
**{title}** (view: {viewName})

| # | Col1 | Col2 | Col3 |
|---|------|------|------|
| 1 | val  | val  | val  |
```

## Error Recovery

| Error | Action |
|-------|--------|
| Canvas 401 | Token expired — re-run Phase 2 |
| REST 404 | Not a database — check via CQL |
| Yjs CDN fails | Retry or try alternate CDN: `https://unpkg.com/yjs@13.6.24/+esm` |
| Chrome not on Confluence | `open_url` to target site first |
| Empty rows | Database may be empty — confirm with user |

## Anti-Hallucination

1. Never invent APIs not in `references/yjs-schema.md`
2. Always resolve user names via API, never guess
3. Return raw values for unknown field types
