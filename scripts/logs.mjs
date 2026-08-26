#!/usr/bin/env node
/**
 * Read a playtest back.
 *
 * The point of the whole logging system is that "did that game run fine?" has
 * an answer somebody can actually go and get, so this is the tool that gets
 * it. By default it summarises the most recent session: who was in it, what
 * each device did, and -- first, because it is the only part that usually
 * matters -- everything that went wrong.
 *
 *   npm run logs                     the latest session, summarised
 *   npm run logs -- --room LU84W9    one match, every device, merged
 *   npm run logs -- --errors         only what failed
 *   npm run logs -- --tail 80        the last 80 lines of the timeline
 *   npm run logs -- --game battle-of-pirates
 *   npm run logs -- --list           what sessions exist
 *   npm run logs -- --clear          start a fresh session file
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'dev-logs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

function files() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => ({ name: f, full: path.join(LOG_DIR, f), mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function read(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    // `ord` is the collector's arrival counter, the only ordering four
    // devices with four different clocks all agree on.
    .sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
}

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const CYA = '\x1b[36m';
const BLD = '\x1b[1m';
const OFF = '\x1b[0m';

function stamp(e) {
  return (e.t || '').slice(11, 23);
}

function line(e, width) {
  const colour = e.lvl === 'error' ? RED : e.lvl === 'warn' ? YEL : '';
  const who = (e.who || e.client || '??').slice(0, width);
  const data = e.data ? ` ${DIM}${JSON.stringify(e.data)}${OFF}` : '';
  return `${DIM}${stamp(e)}${OFF} ${CYA}${who.padEnd(width)}${OFF} ${colour}${e.ev}${OFF}${data}`;
}

// ── which file ─────────────────────────────────────────────────────────────

if (has('list')) {
  const all = files();
  if (all.length === 0) {
    console.log('no sessions yet — logs land in dev-logs/ once a game is played against `npm run serve` or a game dev server');
    process.exit(0);
  }
  for (const f of all) {
    const entries = read(f.full);
    const rooms = [...new Set(entries.map((e) => e.room).filter(Boolean))];
    console.log(
      `${BLD}${f.name}${OFF}  ${entries.length} lines  ${DIM}${new Date(f.mtime).toLocaleString()}${OFF}` +
        (rooms.length ? `  rooms: ${rooms.join(', ')}` : ''),
    );
  }
  process.exit(0);
}

if (has('clear')) {
  if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
  console.log('cleared dev-logs/');
  process.exit(0);
}

const all = files();
if (all.length === 0) {
  console.log(`${YEL}No logs yet.${OFF}`);
  console.log('Logs are written when a game is played against a server that collects them:');
  console.log('  • the LAN host  — npm run serve   (this is the one phones connect to)');
  console.log('  • a game dev server — npm run dev --prefix games/<id>');
  console.log('GitHub Pages has no collector; on a device there, run __gamelog.text() in the console.');
  process.exit(0);
}

const target = val('file', null);
const chosen = target ? all.find((f) => f.name.includes(target)) : all[0];
if (!chosen) {
  console.error(`no session file matching "${target}"`);
  process.exit(1);
}

let entries = read(chosen.full);

// ── filters ────────────────────────────────────────────────────────────────

const room = val('room', null);
if (room) entries = entries.filter((e) => e.room === room);
const game = val('game', null);
if (game) entries = entries.filter((e) => e.game === game);
if (has('errors')) entries = entries.filter((e) => e.lvl === 'error' || e.lvl === 'warn');
const grep = val('grep', null);
if (grep) {
  const re = new RegExp(grep, 'i');
  entries = entries.filter((e) => re.test(e.ev) || re.test(JSON.stringify(e.data ?? {})));
}

if (entries.length === 0) {
  console.log(`${YEL}Nothing in ${chosen.name} matched.${OFF}`);
  process.exit(0);
}

// ── the summary ────────────────────────────────────────────────────────────

const clients = new Map();
for (const e of entries) {
  const k = e.client || '??';
  const c = clients.get(k) ?? { who: e.who, room: e.room, game: e.game, n: 0, errors: 0, warns: 0, first: e.t, last: e.t };
  c.n++;
  if (e.who) c.who = e.who;
  if (e.room) c.room = e.room;
  if (e.lvl === 'error') c.errors++;
  if (e.lvl === 'warn') c.warns++;
  c.last = e.t;
  clients.set(k, c);
}

const errors = entries.filter((e) => e.lvl === 'error');
const warns = entries.filter((e) => e.lvl === 'warn');

console.log('');
console.log(`${BLD}${chosen.name}${OFF}  ${entries.length} lines  ${DIM}${new Date(chosen.mtime).toLocaleString()}${OFF}`);

const rooms = [...new Set(entries.map((e) => e.room).filter(Boolean))];
const games = [...new Set(entries.map((e) => e.game).filter(Boolean))];
console.log(`${DIM}games:${OFF} ${games.join(', ') || '—'}    ${DIM}rooms:${OFF} ${rooms.join(', ') || '— (offline)'}`);

console.log('');
console.log(`${BLD}Devices (${clients.size})${OFF}`);
for (const [id, c] of clients) {
  const flag = c.errors ? `${RED}${c.errors} errors${OFF}` : c.warns ? `${YEL}${c.warns} warns${OFF}` : `${DIM}clean${OFF}`;
  console.log(`  ${CYA}${(c.who || id).padEnd(16)}${OFF} ${String(c.n).padStart(5)} lines  ${flag}  ${DIM}${id}${OFF}`);
}

// The verdict, which is the question actually being asked.
console.log('');
if (errors.length === 0 && warns.length === 0) {
  console.log(`${BLD}Verdict: clean.${OFF} No errors or warnings recorded.`);
} else {
  console.log(`${BLD}Verdict: ${RED}${errors.length} error(s)${OFF}${BLD}, ${YEL}${warns.length} warning(s)${OFF}${BLD}.${OFF}`);
  const grouped = new Map();
  for (const e of [...errors, ...warns]) {
    const key = `${e.lvl}|${e.ev}|${(e.data?.message ?? '').toString().slice(0, 120)}`;
    const g = grouped.get(key) ?? { e, n: 0, who: new Set() };
    g.n++;
    g.who.add(e.who || e.client);
    grouped.set(key, g);
  }
  for (const g of [...grouped.values()].sort((a, b) => b.n - a.n)) {
    const c = g.e.lvl === 'error' ? RED : YEL;
    console.log(`  ${c}${g.e.ev}${OFF} ×${g.n}  ${DIM}on ${[...g.who].join(', ')}${OFF}`);
    if (g.e.data) console.log(`    ${DIM}${JSON.stringify(g.e.data).slice(0, 220)}${OFF}`);
  }
}

// ── the timeline ───────────────────────────────────────────────────────────

const tail = Number(val('tail', has('errors') || has('room') || has('grep') ? 200 : 40));
const shown = entries.slice(-tail);
const width = Math.min(16, Math.max(6, ...entries.map((e) => (e.who || e.client || '').length)));

console.log('');
console.log(`${BLD}Timeline${OFF} ${DIM}(last ${shown.length} of ${entries.length}; --tail N for more)${OFF}`);
for (const e of shown) console.log('  ' + line(e, width));
console.log('');
