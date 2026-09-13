#!/usr/bin/env node
/**
 * Read public-site playtests from Firestore.
 *
 * Authentication is intentionally admin-only. Point PLAYBUDDIES_SERVICE_ACCOUNT
 * at a local service-account JSON file (gitignored), or use standard Google
 * Application Default Credentials. No credential is ever accepted in an
 * argument where it would end up in shell history.
 *
 *   npm run diagnostics -- --room ABC123
 *   npm run diagnostics -- --room ABC123 --errors
 *   npm run diagnostics -- --room ABC123 --watch
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const val = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const room = String(val('room', '')).trim().toUpperCase();
if (!/^[A-Z0-9]{6}$/.test(room)) {
  console.error('Pass a six-character room code: npm run diagnostics -- --room ABC123');
  process.exit(1);
}

const projectId = process.env.PLAYBUDDIES_FIREBASE_PROJECT || 'playbuddies-556cd';
const credentialPath = process.env.PLAYBUDDIES_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const scopes = ['https://www.googleapis.com/auth/cloud-platform'];
let authClient;
if (credentialPath) {
  const absolute = path.resolve(credentialPath);
  if (!fs.existsSync(absolute)) {
    console.error(`Diagnostics credential file does not exist: ${absolute}`);
    process.exit(1);
  }
  const credentials = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  authClient = await new GoogleAuth({ credentials, scopes, projectId }).getClient();
} else {
  // On a development PC that already deployed this project, reuse that
  // existing Firebase CLI session. This does not start a login flow and never
  // prints or copies its token; it only gives firebase-admin the same short-
  // lived access token firebase-tools would use for a deploy.
  try {
    const { configstore } = require('firebase-tools/lib/configstore.js');
    const cliApi = require('firebase-tools/lib/api.js');
    const tokens = configstore.get('tokens');
    if (!tokens?.refresh_token) throw new Error('no Firebase CLI session');
    authClient = new OAuth2Client(cliApi.clientId(), cliApi.clientSecret());
    authClient.setCredentials({ refresh_token: tokens.refresh_token });
  } catch {
    authClient = await new GoogleAuth({ scopes, projectId }).getClient();
  }
}
const firestoreRoot = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
const pollMs = Math.max(2000, Number(val('poll', 5000)) || 5000);
const batchLimit = Math.min(1000, Math.max(1, Number(val('batches', 400)) || 400));
const sinceMinutes = Math.max(1, Number(val('since', 180)) || 180);
const seen = new Set();
let pruned = false;

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const CYA = '\x1b[36m';
const GRN = '\x1b[32m';
const BLD = '\x1b[1m';
const OFF = '\x1b[0m';

function timestamp(value) {
  const date = new Date(value ?? 0);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

async function firestore(pathname, init = {}) {
  const tokenResult = await authClient.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) throw new Error('Google authentication returned no access token.');
  const response = await fetch(`${firestoreRoot}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Firestore ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
}

function decode(value) {
  if (!value || typeof value !== 'object') return value;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {});
  return undefined;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));
}

async function queryBatches({ expired = false } = {}) {
  const structuredQuery = {
    from: [{ collectionId: 'batches' }],
    ...(expired ? {
      where: { fieldFilter: { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: new Date().toISOString() } } },
    } : {
      orderBy: [{ field: { fieldPath: 'receivedAt' }, direction: 'DESCENDING' }],
    }),
    limit: expired ? 400 : batchLimit,
  };
  const rows = await firestore(`/diagnostics/${room}:runQuery`, {
    method: 'POST',
    body: JSON.stringify({ structuredQuery }),
  });
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row.document)
    .map((row) => ({
      id: row.document.name.split('/').pop(),
      name: row.document.name,
      ...decodeFields(row.document.fields ?? {}),
    }));
}

async function load() {
  if (!pruned) {
    pruned = true;
    const expired = await queryBatches({ expired: true });
    if (expired.length) {
      await firestore(':commit', {
        method: 'POST',
        body: JSON.stringify({ writes: expired.map((doc) => ({ delete: doc.name })) }),
      });
    }
  }
  const snapshot = await queryBatches();
  const cutoff = Date.now() - sinceMinutes * 60_000;
  const docs = snapshot
    .filter((batch) => timestamp(batch.receivedAt).getTime() >= cutoff)
    .sort((a, b) => timestamp(a.receivedAt) - timestamp(b.receivedAt));

  let order = 0;
  const entries = [];
  for (const batch of docs) {
    for (const entry of Array.isArray(batch.entries) ? batch.entries : []) {
      entries.push({
        ...entry,
        room: batch.room ?? room,
        game: entry.game ?? batch.game,
        who: entry.who ?? batch.who,
        session: batch.session,
        build: batch.build,
        rt: timestamp(batch.receivedAt).toISOString(),
        ord: ++order,
        batchId: batch.id,
      });
    }
  }
  return entries;
}

function filtered(entries) {
  let next = entries;
  const game = val('game');
  if (game) next = next.filter((entry) => entry.game === game);
  if (has('errors')) next = next.filter((entry) => entry.lvl === 'warn' || entry.lvl === 'error');
  const pattern = val('grep');
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    next = next.filter((entry) => re.test(entry.ev ?? '') || re.test(JSON.stringify(entry.data ?? {})));
  }
  return next;
}

function renderLine(entry) {
  const colour = entry.lvl === 'error' ? RED : entry.lvl === 'warn' ? YEL : '';
  const stamp = String(entry.t ?? entry.rt ?? '').slice(11, 23);
  const who = String(entry.who || entry.client || 'unknown').slice(0, 18).padEnd(18);
  const data = entry.data ? ` ${DIM}${JSON.stringify(entry.data)}${OFF}` : '';
  return `${DIM}${stamp}${OFF} ${CYA}${who}${OFF} ${colour}${entry.ev}${OFF}${data}`;
}

function stateConflicts(entries) {
  const latest = new Map();
  for (const entry of entries) {
    if (entry.ev !== 'state:heartbeat') continue;
    latest.set(entry.client, entry);
  }
  const active = [...latest.values()].filter((entry) => Date.now() - Date.parse(entry.t) < 15_000);
  if (active.length < 2) return [];
  const conflicts = [];

  // A seed identifies the match itself and must agree regardless of progress.
  const invariantFields = ['seed'];
  for (const field of invariantFields) {
    const groups = new Map();
    for (const entry of active) {
      if (!(field in (entry.data ?? {}))) continue;
      const key = JSON.stringify(entry.data[field]);
      const names = groups.get(key) ?? [];
      names.push(entry.who || entry.client);
      groups.set(key, names);
    }
    if (groups.size > 1) conflicts.push({ field, groups });
  }

  // Compare mutable state only among clients at the same deterministic
  // revision. One device can honestly be a packet ahead for a moment; two
  // devices at the same turn/history revision cannot honestly disagree about
  // whose turn it is or what the resulting health/score is.
  const revisions = new Map();
  for (const entry of active) {
    const revision = entry.data?.rev;
    if (revision === undefined) continue;
    const key = JSON.stringify(revision);
    const group = revisions.get(key) ?? [];
    group.push(entry);
    revisions.set(key, group);
  }
  const mutableFields = ['turn', 'phase', 'round', 'hole', 'history', 'score', 'totals', 'hp', 'charges', 'winner', 'positions', 'stock', 'players', 'pieces', 'scores', 'wave', 'lives', 'phases', 'board'];
  for (const [revision, peers] of revisions) {
    if (peers.length < 2) continue;
    for (const field of mutableFields) {
      const groups = new Map();
      for (const entry of peers) {
        if (!(field in (entry.data ?? {}))) continue;
        const key = JSON.stringify(entry.data[field]);
        const names = groups.get(key) ?? [];
        names.push(entry.who || entry.client);
        groups.set(key, names);
      }
      if (groups.size > 1) conflicts.push({ field: `${field} @ rev ${revision}`, groups });
    }
  }
  return conflicts;
}

function summary(entries) {
  const devices = new Map();
  for (const entry of entries) {
    const device = devices.get(entry.client) ?? { who: entry.who, lines: 0, errors: 0, warns: 0, last: entry.t };
    device.who = entry.who || device.who;
    device.lines++;
    if (entry.lvl === 'error') device.errors++;
    if (entry.lvl === 'warn') device.warns++;
    device.last = entry.t;
    devices.set(entry.client, device);
  }
  const errors = entries.filter((entry) => entry.lvl === 'error');
  const warns = entries.filter((entry) => entry.lvl === 'warn');
  const conflicts = stateConflicts(entries);
  console.log(`\n${BLD}Remote diagnostics · room ${room}${OFF}`);
  console.log(`${DIM}${entries.length} lines · ${devices.size} devices · last ${sinceMinutes} minutes${OFF}`);
  for (const [id, device] of devices) {
    const status = device.errors ? `${RED}${device.errors} errors${OFF}` : device.warns ? `${YEL}${device.warns} warnings${OFF}` : `${GRN}clean${OFF}`;
    console.log(`  ${CYA}${String(device.who || id).padEnd(18)}${OFF} ${String(device.lines).padStart(4)} lines  ${status}  ${DIM}${id}${OFF}`);
  }
  if (conflicts.length) {
    console.log(`\n${RED}${BLD}DESYNC DETECTED${OFF}`);
    for (const conflict of conflicts) {
      const views = [...conflict.groups].map(([value, names]) => `${names.join(', ')}=${value}`).join(' | ');
      console.log(`  ${YEL}${conflict.field}${OFF}: ${views}`);
    }
  } else if (errors.length || warns.length) {
    console.log(`\n${YEL}${BLD}${errors.length} errors, ${warns.length} warnings${OFF}`);
  } else {
    console.log(`\n${GRN}${BLD}No recorded errors or live state disagreement.${OFF}`);
  }
}

function timeline(entries, onlyNew = false) {
  const selected = filtered(entries);
  const fresh = onlyNew ? selected.filter((entry) => !seen.has(`${entry.batchId}:${entry.client}:${entry.seq}`)) : selected;
  for (const entry of fresh) {
    seen.add(`${entry.batchId}:${entry.client}:${entry.seq}`);
    console.log('  ' + renderLine(entry));
  }
}

async function run() {
  const entries = await load();
  if (entries.length === 0) {
    console.log(`No remote diagnostics found for room ${room} in the last ${sinceMinutes} minutes.`);
    return;
  }
  summary(entries);
  const tail = Math.max(1, Number(val('tail', 100)) || 100);
  console.log(`\n${BLD}Timeline${OFF} ${DIM}(last ${Math.min(tail, filtered(entries).length)})${OFF}`);
  timeline(entries.slice(-tail));
}

try {
  await run();
  if (has('watch')) {
    console.log(`\n${DIM}Watching every ${pollMs / 1000}s. Ctrl+C to stop.${OFF}`);
    setInterval(async () => {
      try {
        const entries = await load();
        const conflicts = stateConflicts(entries);
        if (conflicts.length) {
          console.log(`\n${RED}${BLD}DESYNC DETECTED${OFF}`);
          for (const conflict of conflicts) {
            console.log(`  ${conflict.field}: ${[...conflict.groups].map(([v, n]) => `${n.join(', ')}=${v}`).join(' | ')}`);
          }
        }
        timeline(entries, true);
      } catch (error) {
        console.error(`${RED}Diagnostics poll failed:${OFF}`, error.message);
      }
    }, pollMs);
  }
} catch (error) {
  console.error(`${RED}Could not read remote diagnostics.${OFF}`);
  console.error(error.message);
  if (!credentialPath) {
    console.error('\nSet PLAYBUDDIES_SERVICE_ACCOUNT to a local service-account JSON path,');
    console.error('use an existing Firebase CLI session, or configure Google Application Default Credentials.');
    console.error('Never commit a credential file.');
  }
  process.exit(1);
}
