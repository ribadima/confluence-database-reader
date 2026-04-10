# Confluence Database — Yjs Document Schema

## Shared Maps

Canvas stores database content as a Yjs CRDT document with these shared Maps:

| Map | Purpose | Key | Value |
| --- | --- | --- | --- |
| `fbi` | Field (column) definitions | Field UUID | `{ n, t, sso[], ... }` |
| `ebi` | Entry (row) data | Entry UUID | `{ [fieldId]: { t, v, rt? } }` |
| `vbi` | View definitions | View UUID | `{ n, t, cf }` |
| `meta` | Document metadata | `version` | Integer |
| `s` | Settings | `dvi` | Default view ID |
| `_meta` | Internal metadata | `version` | Timestamp |

## Field Types

| Code | Type | Cell Value (`v`) | How to Resolve |
| --- | --- | --- | --- |
| `t` | Text | `"string"` | Direct. Rich text XML may be in `rt`. |
| `s` | Select / Tag | `["optionId", ...]` | `fbi[colId].sso.find(o => o.i === optId).l` |
| `h` | Hyperlink / Page Link | `[{u: "url", i: "uuid"}]` | `fbi[colId].sso.find(o => o.i === link.i).l` for label, `.u` for URL |
| `u` | Person | `[{a: "accountId", i: "uuid", t: "r"}]` | `.a` = Atlassian account ID. Resolve via `lookupJiraAccountId`. |
| `n` | Number | `123` | Direct |
| `d` | Date | `"ISO string"` | Direct |

## Select / Hyperlink Options (`fbi[colId].sso[]`)

```json
{ "i": "option-uuid", "l": "label text", "c": "color name" }
```

Colors: `blueLight`, `greenLight`, `limeLight`, `yellowLight`, `orangeLight`, `redLight`, `magentaLight`, `purpleLight`.

## resolveCell Function

```javascript
function resolveCell(colDef, cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  switch (cell.t) {
    case 't': return cell.v || '';
    case 's':
      if (!Array.isArray(cell.v)) return cell.v;
      return cell.v.map(optId => {
        const opt = (colDef.sso || []).find(o => o.i === optId);
        return opt ? opt.l : optId;
      }).join(', ');
    case 'h':
      if (!Array.isArray(cell.v)) return cell.v;
      return cell.v.map(link => {
        const opt = (colDef.sso || []).find(o => o.i === link.i);
        return opt ? opt.l : (link.u || link.i);
      }).join(', ');
    case 'u':
      if (!Array.isArray(cell.v)) return cell.v;
      return cell.v.map(u => u.a || u.i || '').join(', ');
    case 'n': return cell.v;
    case 'd': return cell.v;
    default:
      console.warn(`Unknown field type "${cell.t}" in column "${colDef?.n}"`);
      return typeof cell.v === 'object' ? JSON.stringify(cell.v) : cell.v;
  }
}
```

## Full Decode Script

```javascript
const Y = require('yjs');
const fs = require('fs');

function decodeDatabase(filePath) {
  const data = fs.readFileSync(filePath);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(data));

  const fbi = doc.getMap('fbi').toJSON();
  const ebi = doc.getMap('ebi').toJSON();
  const vbi = doc.getMap('vbi').toJSON();

  const columns = Object.entries(fbi).map(([id, col]) => ({
    id, name: col.n, type: col.t
  }));

  const rows = Object.entries(ebi).map(([rowId, cells]) => {
    const row = { _id: rowId };
    for (const [colId, cell] of Object.entries(cells)) {
      const colDef = fbi[colId];
      row[colDef?.n || colId] = resolveCell(colDef, cell);
    }
    return row;
  });

  const accountIds = new Set();
  for (const row of Object.values(ebi)) {
    for (const cell of Object.values(row)) {
      if (cell.t === 'u' && Array.isArray(cell.v)) {
        cell.v.forEach(u => { if (u.a) accountIds.add(u.a); });
      }
    }
  }

  return {
    view: Object.values(vbi)[0]?.n || '',
    columns: columns.map(c => ({ name: c.name, type: c.type })),
    rowCount: rows.length,
    rows,
    accountIdsToResolve: [...accountIds]
  };
}
```

## Error Codes

| Error | Cause | Fix |
| --- | --- | --- |
| REST 404 | Not a database or wrong ID | Verify via CQL: `type = "database"` |
| Canvas 401 | Token expired (~15 min) | Re-run canvasToken GraphQL |
| Yjs decode empty | Wrong binary format | Check file is binary, not JSON error |
| `[object Object]` | Unhandled field type | Add handler in resolveCell |
| Unknown type warn | New Atlassian field type | Returns raw value, log for investigation |
