#!/usr/bin/env node
// Confluence Database Yjs Decoder
// Usage: node decode.js <binary-file>
// Output: JSON with columns, rows, accountIdsToResolve

const Y = require('/tmp/node_modules/yjs');
const fs = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node decode.js <canvas_data.bin>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

function resolveCell(colDef, cell) {
  if (!cell || cell.v === undefined) return '';
  switch (cell.t) {
    case 't': return cell.v || '';
    case 's':
      return Array.isArray(cell.v)
        ? cell.v.map(id => (colDef.sso || []).find(o => o.i === id)?.l || id).join(', ')
        : cell.v;
    case 'h':
      return Array.isArray(cell.v)
        ? cell.v.map(l => (colDef.sso || []).find(o => o.i === l.i)?.l || (l.u || l.i)).join(', ')
        : cell.v;
    case 'u':
      return Array.isArray(cell.v)
        ? cell.v.map(u => u.a || u.i || '').join(', ')
        : cell.v;
    case 'n': return cell.v;
    case 'd': return cell.v;
    default:
      process.stderr.write(`WARN: unknown field type "${cell.t}" in column "${colDef?.n || '?'}"\n`);
      return typeof cell.v === 'object' ? JSON.stringify(cell.v) : (cell.v ?? '');
  }
}

const data = fs.readFileSync(filePath);
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(data));

const fbi = doc.getMap('fbi').toJSON();
const ebi = doc.getMap('ebi').toJSON();
const vbi = doc.getMap('vbi').toJSON();

const columns = Object.entries(fbi).map(([id, c]) => ({ id, name: c.n, type: c.t }));
const rows = Object.entries(ebi).map(([rid, cells]) => {
  const row = {};
  for (const [cid, cell] of Object.entries(cells)) {
    row[fbi[cid]?.n || cid] = resolveCell(fbi[cid], cell);
  }
  return row;
});

const accountIds = new Set();
for (const r of Object.values(ebi)) {
  for (const c of Object.values(r)) {
    if (c.t === 'u' && Array.isArray(c.v)) {
      c.v.forEach(u => { if (u.a) accountIds.add(u.a); });
    }
  }
}

console.log(JSON.stringify({
  view: Object.values(vbi)[0]?.n || '',
  columns: columns.map(c => ({ name: c.name, type: c.type })),
  rowCount: rows.length,
  rows,
  accountIdsToResolve: [...accountIds]
}));
