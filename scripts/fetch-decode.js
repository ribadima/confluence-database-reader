#!/usr/bin/env node
// Confluence Database: Fetch Canvas binary + Yjs decode in one step
// Usage: node fetch-decode.js <json-params-file>
//   JSON file: { "token": "...", "site": "...", "cloudId": "...", "referenceId": "...", "contentId": "..." }
// Alt:   node fetch-decode.js <token> <site> <cloudId> <referenceId> <contentId>
// Output: JSON with view, columns, rows, rowCount, accountIdsToResolve

const https = require('https');
const fs = require('fs');
const Y = require('/tmp/node_modules/yjs');

let token, site, cloudId, referenceId, contentId;

if (process.argv.length === 3 && process.argv[2].endsWith('.json')) {
  const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  ({ token, site, cloudId, referenceId, contentId } = p);
} else {
  [,, token, site, cloudId, referenceId, contentId] = process.argv;
}

if (!token || !site || !cloudId || !referenceId) {
  console.error('Usage: node fetch-decode.js <params.json> OR <token> <site> <cloudId> <referenceId> <contentId>');
  process.exit(1);
}

const ari = encodeURIComponent(`ari:cloud:canvas:${cloudId}:database/${referenceId}`);
const url = `https://${site}.atlassian.net/gateway/api/canvas/api/_internal/collab/${ari}?skipSteps=true&v=2`;

const req = https.get(url, { headers: { 'X-Access-Token': token } }, (res) => {
  if (res.statusCode !== 200) {
    console.error(JSON.stringify({ error: `HTTP ${res.statusCode}`, url }));
    process.exit(1);
  }
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(buf));

      const fbi = doc.getMap('fbi').toJSON();
      const ebi = doc.getMap('ebi').toJSON();
      const vbi = doc.getMap('vbi').toJSON();

      const columns = Object.entries(fbi).map(([id, c]) => ({ id, name: c.n, type: c.t }));
      const rows = Object.entries(ebi).map(([, cells]) => {
        const row = {};
        for (const [cid, cell] of Object.entries(cells)) {
          row[fbi[cid]?.n || cid] = resolveCell(fbi[cid], cell);
        }
        return row;
      });

      const accountIds = new Set();
      for (const r of Object.values(ebi)) {
        for (const c of Object.values(r)) {
          if (c.t === 'u' && Array.isArray(c.v)) c.v.forEach(u => { if (u.a) accountIds.add(u.a); });
        }
      }

      console.log(JSON.stringify({
        view: Object.values(vbi)[0]?.n || '',
        columns: columns.map(c => ({ name: c.name, type: c.type })),
        rowCount: rows.length,
        rows,
        accountIdsToResolve: [...accountIds]
      }));
    } catch (e) {
      console.error(JSON.stringify({ error: 'Yjs decode failed', message: e.message }));
      process.exit(1);
    }
  });
});

req.on('error', e => {
  console.error(JSON.stringify({ error: 'Network error', message: e.message }));
  process.exit(1);
});
req.setTimeout(15000, () => { req.destroy(); console.error('Timeout'); process.exit(1); });

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
      process.stderr.write(`WARN: unknown type "${cell.t}" in "${colDef?.n || '?'}"\n`);
      return typeof cell.v === 'object' ? JSON.stringify(cell.v) : (cell.v ?? '');
  }
}
