// Pulse Chat desktop app (1.6). An Electron program that does what the launchers do (chat-pulse-server.ps1 / .py)
// and shows chat-pulse.html in its own window: no console window, no browser.
//
// It runs the launcher's little web server inside itself, on this computer only (127.0.0.1 / ::1), and opens the page
// from it at http://localhost:<port>/ (the Twitch player only plays inside pages with a web address). Routes, the same
// as the launchers':
//   GET  /                  chat-pulse.html, read from disk on every request
//   POST /twitch/gql        forwarded to Twitch's GraphQL API with a Client-ID header
//   GET  /twitch/get?url=   one file from Twitch's CDN hosts (thumbnails, quality lists, audio); other hosts: 403
//   POST /clip/save         ffmpeg saves a clip / the full VOD as .mp4; asks where with Windows' own Save window
//   GET  /clip/status?id=   { state: running | done | failed | cancelled, done, secs, last, file, copy, error }
//   POST /clip/cancel?id=   stops ffmpeg, deletes the half-made file
//   GET  /clip/file?id=     a finished temp file, streamed (only used by browsers with their own Save window)
//   POST /clip/show?id=     shows the saved file in Explorer / Finder
//   POST /quit              quits the app
//
// Files: chat-pulse.html and ffmpeg(.exe) are looked for in the folder ABOVE the app's folder first (C:\claudio when
// the app is in C:\claudio\Pulse Chat App), then next to Pulse Chat.exe, then inside the app. So the page in
// C:\claudio is the one the app shows, the same file the old launcher serves.
//
// Saved work (starred clips, notes, transcripts, settings) lives in the app's own storage, separate from the
// browser's; carry it over with Backup… in the browser, then Restore in the app.
//
// Mac (app 1.1): the app is "Pulse Chat.app" in the Pulse Chat folder (made by install-app-mac.command), so the
// folder is three levels above the program (Pulse Chat.app/Contents/MacOS/Electron). The window is Apple's real
// Liquid Glass (macOS 26+, through the electron-liquid-glass add-on installed inside the app), with the page's panels
// and graph see-through over it (html.glass); without the add-on or on older macOS, Apple's frosted blur (vibrancy).
//
// iCloud Drive (app 1.2): when iCloud Drive has a "Pulse Chat" folder with chat-pulse.html in it (Mac: iCloud Drive,
// Windows: iCloud for Windows' iCloudDrive folder), the app runs that folder's app-src/main.js and shows its
// chat-pulse.html, so a change made on one computer reaches the other through iCloud. The local folder (next to the
// app) is the fallback when there is no iCloud copy, or when it can't be read yet. ffmpeg and the icons are still
// looked for in the local folder first (each computer keeps its own). PULSE_NO_SYNC=1 turns iCloud off.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------- a shared copy (app 1.6) ----------
   The installers built for other people (electron-builder, see BUILDING.md) set "pulseDist": true in the app's
   package.json. Such a copy runs only its own code and page, keeps ffmpeg and its settings in its own data folder, and
   syncs saved work only if its user picks a sync folder. Without the flag (this app on its owner's computers) it works
   as before: code and page from the Pulse Chat folder or iCloud. */
const PKG = require('./package.json');
const DIST = !!PKG.pulseDist;

/* ---------- iCloud Drive: run the shared copy when there is one ---------- */
const SYNC_DIRS = process.platform === 'darwin'
  ? [path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Pulse Chat')]
  : [path.join(os.homedir(), 'iCloudDrive', 'Pulse Chat'), path.join(os.homedir(), 'iCloud Drive', 'Pulse Chat')];
const SYNC_HOME = process.env.PULSE_NO_SYNC || DIST ? null : (SYNC_DIRS.find((d) => {
  try { return fs.statSync(path.join(d, 'chat-pulse.html')).isFile(); } catch (e) { return false; }
}) || null);
{
  const shared = SYNC_HOME && path.join(SYNC_HOME, 'app-src', 'main.js');
  if (shared && path.resolve(__filename) !== path.resolve(shared) && !process.env.PULSE_IN_SYNC) {
    let ok = false;
    try { // only a complete, readable copy (iCloud may still be downloading it, or show an empty placeholder)
      const src = fs.readFileSync(shared, 'utf8');
      if (!src.trimEnd().endsWith('// end of Pulse Chat main.js')) throw new Error('main.js is incomplete (still downloading?)');
      if (!fs.statSync(path.join(SYNC_HOME, 'app-src', 'preload.js')).size) throw new Error('preload.js is empty');
      // and it parses, checked the way Node runs a module: inside a function (main.js itself has a top-level return)
      new (require('vm').Script)(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: shared });
      ok = true;
    } catch (e) { console.warn(`[Pulse Chat] iCloud copy not usable, running the local one: ${e && e.message}`); }
    if (ok) {
      process.env.PULSE_IN_SYNC = '1';
      require(shared);
      return; // the iCloud copy runs the app; nothing more here
    }
  }
}

const { app, BrowserWindow, dialog, shell, Menu, nativeImage, Notification, ipcMain, session, powerSaveBlocker, screen } = require('electron');
// A shared copy keeps its saved work, settings and ffmpeg in its own data folder ("Pulse Chat (installed)"), never in
// the one this app uses on its owner's computers ("Pulse Chat"), so both can sit on the same computer without mixing
if (DIST) app.setPath('userData', path.join(app.getPath('appData'), 'Pulse Chat (installed)'));
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const APP_VERSION = PKG.version;
const PORTS = [8170, 8171, 8172, 8173, 8174, 8175, 8176, 8177, 8178, 8179]; // fixed: the saved work belongs to the address
const GQL_URL = process.env.PULSE_GQL_URL || 'https://gql.twitch.tv/gql'; // override only for testing
const CLIENT_WEB = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const CLIENT_IDS = new Set([CLIENT_WEB, 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp']);
const CDN_SUFFIXES = ['.ttvnw.net', '.cloudfront.net', '.jtvnw.net', '.live-video.net', '.twitch.tv', '.akamaized.net'];
if (process.env.PULSE_CDN_EXTRA) CDN_SUFFIXES.push(process.env.PULSE_CDN_EXTRA); // only for testing
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChatPulse/1.0';
const TIMEOUT = 30000;

/* ---------- where the files are ---------- */
const exeDir = path.dirname(process.execPath);
const IS_MAC = process.platform === 'darwin';
// The Pulse Chat folder: above "Pulse Chat App" on Windows, above "Pulse Chat.app" on a Mac
const appHome = IS_MAC ? path.resolve(exeDir, '..', '..', '..') : path.dirname(exeDir);
// A shared copy (DIST) uses only the page inside it; ffmpeg it fetched lives in its data folder (FF_DIR)
const FF_DIR = DIST ? app.getPath('userData') : appHome;
const searchDirs = DIST ? [...new Set([process.env.PULSE_HOME, app.getAppPath()].filter(Boolean))]
  : [...new Set([process.env.PULSE_HOME, SYNC_HOME, appHome, exeDir, app.getAppPath()].filter(Boolean))];
// Each computer's own files first (ffmpeg, icons): the local folder, then the shared one
const localDirs = [...new Set([process.env.PULSE_HOME, FF_DIR, appHome, exeDir, SYNC_HOME, app.getAppPath()].filter(Boolean))];
function iconFile(name) {
  for (const p of [...(DIST ? [] : [path.join(appHome, 'app-src', name)]), path.join(__dirname, name)]) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ } }
  return path.join(__dirname, name);
}

/* ---------- Mac: Liquid Glass ---------- */
let liquidGlass = null;
if (IS_MAC && !process.env.PULSE_NO_GLASS) {
  for (const where of ['electron-liquid-glass', path.join(process.resourcesPath || '', 'app', 'node_modules', 'electron-liquid-glass')]) {
    try { liquidGlass = require(where); if (liquidGlass && liquidGlass.default) liquidGlass = liquidGlass.default; break; } catch (e) { liquidGlass = null; }
  }
}
// 'liquid' (real Liquid Glass), 'vibrancy' (Apple's older frosted blur) or 'none' (Windows, Linux)
const GLASS = !IS_MAC || process.env.PULSE_NO_GLASS ? 'none'
  : (liquidGlass && typeof liquidGlass.isGlassSupported === 'function' && (() => { try { return liquidGlass.isGlassSupported(); } catch (e) { return false; } })()) ? 'liquid' : 'vibrancy';
function findFile(names, dirs = searchDirs) {
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ } }
  return null;
}
const pagePath = () => findFile(['chat-pulse.html']);
function findFfmpeg() {
  // Never the other computer's: ffmpeg.exe on Windows, ffmpeg on a Mac / Linux
  const own = findFile(process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'], localDirs);
  if (own) return own;
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'] : [];
  for (const d of [...extra, ...(process.env.PATH || '').split(path.delimiter)]) {
    const p = path.join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ }
  }
  return null;
}

/* ---------- small helpers ---------- */
function cdnAllowed(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  const host = u.hostname.toLowerCase();
  return u.protocol === 'https:' && CDN_SUFFIXES.some((s) => host === s.replace(/^\./, '') || host.endsWith(s));
}
function send(res, code, body, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
function readBody(req, max = 50 * 1024 * 1024) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { bad(new Error('Request too large.')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', bad);
  });
}
// One HTTPS request, following redirects; no User-Agent unless given (like curl -A '' / TwitchDownloader)
function fetchRaw(url, { method = 'GET', headers = {}, body = null, ua = null } = {}, hops = 0) {
  return new Promise((ok, bad) => {
    const h = Object.assign({ 'Accept-Encoding': 'gzip, deflate' }, headers);
    if (ua) h['User-Agent'] = ua;
    if (body) h['Content-Length'] = body.length;
    const req = https.request(url, { method, headers: h, timeout: TIMEOUT }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 5) {
        r.resume();
        const next = new URL(r.headers.location, url).toString();
        if (!cdnAllowed(next) && next !== GQL_URL) { bad(new Error('redirected off Twitch')); return; }
        ok(fetchRaw(next, { method: r.statusCode === 303 ? 'GET' : method, headers, body: r.statusCode === 303 ? null : body, ua }, hops + 1));
        return;
      }
      let s = r;
      const enc = (r.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = r.pipe(zlib.createGunzip()); else if (enc === 'deflate') s = r.pipe(zlib.createInflate());
      const parts = [];
      s.on('data', (c) => parts.push(c));
      s.on('end', () => ok({ status: r.statusCode, type: r.headers['content-type'] || '', body: Buffer.concat(parts) }));
      s.on('error', bad);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', bad);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------- clip / VOD downloads with ffmpeg ---------- */
const jobs = new Map();
let lastDir = null;
function clipName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|%^!&\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 120).trim();
  return n || 'Twitch clip';
}
function startJob(job, copy) {
  const fmt = (x) => x.toFixed(3);
  let codec;
  if (copy) { codec = ['-c', 'copy', '-bsf:a', 'aac_adtstoasc']; if (job.hevc) codec.push('-tag:v', 'hvc1'); }
  else codec = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'];
  let args;
  const local = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-allowed_extensions', 'ALL'];
  if (job.local && copy) {
    // Fast cut (1.3.4): from the 2 s keyframe at or before the start, lengthened by the difference
    const ss = Math.max(0, Math.floor(job.start / 2) * 2 - 0.25);
    args = [...local, '-i', job.url, '-ss', fmt(ss), '-t', fmt(job.dur + job.start - ss)];
  } else if (job.local) {
    args = [...local, '-i', job.url, '-ss', fmt(job.start), '-t', fmt(job.dur)];
  } else {
    args = ['-ss', fmt(job.start), '-i', job.url, '-t', fmt(job.dur)];
  }
  args = ['-hide_banner', '-nostdin', '-y', ...args, ...codec, '-movflags', '+faststart', job.out];
  Object.assign(job, { copy, log: [], done: 0, started: Date.now(), exit: null });
  const proc = spawn(job.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  job.proc = proc;
  let buf = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (ch) => {
    buf += ch;
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop();
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      job.log = [...job.log, t].slice(-20);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
      if (m) job.done = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
    }
  });
  proc.on('error', (e) => { job.exit = -1; job.log.push(`ffmpeg could not start: ${e.message}`); });
  proc.on('close', (code) => { if (job.proc === proc) job.exit = code == null ? -1 : code; });
}
const rm = (p) => { try { fs.unlinkSync(p); } catch (e) { /* gone */ } };

async function clipSave(req, res) {
  const ff = findFfmpeg();
  if (!ff) { sendJson(res, 400, { error: `ffmpeg was not found. Put ffmpeg${process.platform === 'win32' ? '.exe' : ''} in ${searchDirs[0]}.` }); return; }
  let o;
  try { o = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { sendJson(res, 400, { error: 'Bad clip request.' }); return; }
  const start = +o.start, end = +o.end, url = String(o.url || ''), playlist = String(o.playlist || '');
  let srcOk;
  if (playlist) {
    const uris = playlist.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const m of playlist.matchAll(/URI="([^"]+)"/g)) uris.push(m[1]);
    srcOk = uris.length > 0 && uris.every(cdnAllowed);
  } else srcOk = cdnAllowed(url);
  if (!srcOk || !(end > start)) { sendJson(res, 400, { error: 'Bad clip request (not a Twitch stream, or the end is before the start).' }); return; }
  const downloads = app.getPath('downloads');
  const name = clipName(o.name);
  let out = path.join(downloads, `${name}.mp4`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(downloads, `${name} (${n}).mp4`);
  let asked = false;
  if (o.temp) {
    out = path.join(os.tmpdir(), `pulse-chat-clip-${crypto.randomUUID()}.mp4`);
  } else if (o.ask) {
    // Windows' own Save window, in front of the app window (the old launcher's opened behind the browser)
    const r = process.env.PULSE_TEST_SAVE_AS // only for testing: answer the Save window without a person
      ? { canceled: process.env.PULSE_TEST_SAVE_AS === 'cancel', filePath: process.env.PULSE_TEST_SAVE_AS }
      : await dialog.showSaveDialog(win, {
        title: 'Save as',
        defaultPath: path.join(lastDir && fs.existsSync(lastDir) ? lastDir : downloads, path.basename(out)),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
    if (r.canceled || !r.filePath) { sendJson(res, 200, { cancelled: true }); return; }
    out = /\.mp4$/i.test(r.filePath) ? r.filePath : `${r.filePath}.mp4`;
    lastDir = path.dirname(out);
    asked = true;
  }
  const job = { temp: !!o.temp, ffmpeg: ff, url, start, dur: end - start, out, hevc: !!o.hevc };
  if (playlist) {
    const pl = path.join(os.tmpdir(), `pulse-chat-clip-${crypto.randomUUID()}.m3u8`);
    fs.writeFileSync(pl, playlist, 'utf8');
    Object.assign(job, { url: pl, local: true, start: +o.offset || 0, playlistFile: pl });
  }
  const id = crypto.randomUUID().replace(/-/g, '');
  startJob(job, !(o.exact == null || !!o.exact));
  jobs.set(id, job);
  sendJson(res, 200, { id, file: path.basename(out), asked, askError: null, temp: !!o.temp });
}

function clipStatus(job) {
  if (!job) return { state: 'failed', error: 'The app has no such download (was it restarted?).' };
  if (job.cancelled) return { state: 'cancelled' };
  if (job.exit === null) return { state: 'running', done: job.done, secs: Math.round((Date.now() - job.started) / 1000), last: job.log[job.log.length - 1] || '' };
  let size = 0;
  try { size = fs.statSync(job.out).size; } catch (e) { /* none */ }
  if (job.exit === 0 && size > 0) { if (job.playlistFile) rm(job.playlistFile); return { state: 'done', file: path.basename(job.out), copy: job.copy }; }
  if (!job.copy) { // re-encoding failed: a plain stream copy once
    rm(job.out);
    startJob(job, true);
    return { state: 'running', done: 0, secs: 0, last: 'Trying again with a stream copy' };
  }
  rm(job.out);
  if (job.playlistFile) rm(job.playlistFile);
  return { state: 'failed', error: `ffmpeg failed: ${job.log.slice(-2).join(' / ')}` };
}
function cancelJob(job) {
  if (!job) return;
  job.cancelled = true;
  if (job.proc && job.exit === null) { try { job.proc.kill(); } catch (e) { /* gone */ } }
  setTimeout(() => { rm(job.out); if (job.playlistFile) rm(job.playlistFile); }, 800); // after ffmpeg lets go of it
}
const runningJobs = () => [...jobs.values()].filter((j) => j.exit === null && !j.cancelled);

/* ---------- the web server ---------- */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname, q = u.searchParams;
  try {
    if ((p === '/' || p === '/chat-pulse.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = pagePath();
      if (!file) { send(res, 500, `chat-pulse.html was not found (looked in: ${searchDirs.join(', ')}).`); return; }
      send(res, 200, fs.readFileSync(file), 'text/html; charset=utf-8');
    } else if (p === '/twitch/gql' && req.method === 'POST') {
      const body = await readBody(req, 1000000);
      let cid = String(req.headers['x-client-id'] || '');
      if (!CLIENT_IDS.has(cid)) cid = CLIENT_WEB;
      try {
        // 1.3.9: the playback token goes without a User-Agent, like TwitchDownloader
        const ua = body.includes('PlaybackAccessToken_Template') ? null : BROWSER_UA;
        const r = await fetchRaw(GQL_URL, { method: 'POST', body, ua, headers: { 'Client-ID': cid, 'Content-Type': 'application/json', Accept: 'application/json' } });
        send(res, r.status || 502, r.body, r.type || 'application/json');
      } catch (e) { send(res, 502, `The app could not reach Twitch: ${e.message}`); }
    } else if (p === '/twitch/get' && req.method === 'GET') {
      const target = q.get('url') || '';
      if (!cdnAllowed(target)) { send(res, 403, 'Only addresses on Twitch can be fetched.'); return; }
      try {
        const ua = new URL(target).hostname === 'usher.ttvnw.net' ? null : BROWSER_UA; // 1.3.9: usher without one
        const r = await fetchRaw(target, { ua });
        send(res, r.status || 502, r.body, r.type || 'application/octet-stream');
      } catch (e) { send(res, 502, `The app could not fetch that: ${e.message}`); }
    } else if (p === '/clip/save' && req.method === 'POST') {
      await clipSave(req, res);
    } else if (p === '/clip/status' && req.method === 'GET') {
      sendJson(res, 200, clipStatus(jobs.get(q.get('id') || '')));
    } else if (p === '/clip/cancel' && req.method === 'POST') {
      cancelJob(jobs.get(q.get('id') || ''));
      send(res, 200, 'ok');
    } else if (p === '/clip/file' && req.method === 'GET') {
      const job = jobs.get(q.get('id') || '');
      let size = -1;
      try { if (job && job.temp) size = fs.statSync(job.out).size; } catch (e) { /* none */ }
      if (size < 0) { send(res, 404, 'No such clip.'); return; }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Cache-Control': 'no-store' });
      const s = fs.createReadStream(job.out);
      s.pipe(res);
      const done = () => { s.destroy(); setTimeout(() => rm(job.out), 300); };
      res.on('close', done);
    } else if (p === '/clip/show' && req.method === 'POST') {
      const job = jobs.get(q.get('id') || '');
      if (job && fs.existsSync(job.out)) shell.showItemInFolder(job.out);
      send(res, 200, 'ok');
    } else if (p === '/quit' && req.method === 'POST') {
      send(res, 200, 'Pulse Chat stopped.');
      setTimeout(() => app.quit(), 100);
    } else {
      send(res, 404, 'Not found');
    }
  } catch (e) {
    try { send(res, 500, `Server error: ${e.message}`); } catch (e2) { /* answer already started */ }
  }
}

function listen(port) {
  return new Promise((ok) => {
    const servers = [];
    const s4 = http.createServer(handle);
    s4.once('error', () => ok(null));
    s4.listen(port, '127.0.0.1', () => {
      servers.push(s4);
      // Also on IPv6 localhost when there is one, so "localhost" answers either way
      const s6 = http.createServer(handle);
      s6.once('error', () => ok(servers));
      s6.listen(port, '::1', () => { servers.push(s6); ok(servers); });
    });
  });
}

/* ---------- notifications (app 1.0.1) ----------
   The page's notifications come here (preload: pulseApp.notify) and go out as Windows notifications that play
   Windows' default notification sound, like the ones Chrome showed for the web version. A click brings the window
   forward and tells the page which one was clicked, so it can go to that moment or tab. */
const toasts = new Map(); // id → Notification, kept until closed (a collected one loses its click handler)
const xmlEsc = (t) => String(t || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
ipcMain.on('pulse-notify', (e, n) => {
  if (!n || typeof n !== 'object') return;
  const title = String(n.title || 'Pulse Chat').slice(0, 200), body = String(n.body || '').slice(0, 1000);
  if (process.env.PULSE_TEST_NOTIFY) { try { fs.appendFileSync(process.env.PULSE_TEST_NOTIFY, JSON.stringify({ id: n.id, title, body }) + '\n'); } catch (err) { /* test only */ } }
  if (!Notification.isSupported()) return;
  const opts = { title, body, silent: false };
  const icon = iconFile('icon.png');
  if (fs.existsSync(icon)) opts.icon = icon;
  if (process.platform === 'win32') {
    opts.toastXml = `<toast launch="pulse-chat"><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text>`
      + `${fs.existsSync(icon) ? `<image placement="appLogoOverride" src="${xmlEsc(icon)}"/>` : ''}</binding></visual>`
      + '<audio src="ms-winsoundevent:Notification.Default"/></toast>';
  }
  const toast = new Notification(opts);
  const id = String(n.id || '');
  toasts.set(id, toast);
  toast.on('click', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('pulse-notify-click', id); }
  });
  toast.on('close', () => toasts.delete(id));
  toast.on('failed', () => toasts.delete(id));
  toast.show();
  if (toasts.size > 30) toasts.delete(toasts.keys().next().value);
});

/* ---------- logins (app 1.0.2) ----------
   The app keeps its own cookies (separate from Chrome's), so Twitch and YouTube start out logged out. Their sign-in
   pages open in an app window (not the normal browser, where the login would end up in Chrome instead), from the
   chat embeds' own "Log in" or from the page's "Log in to Twitch / YouTube" buttons (pulseApp.login). The app's
   cookies are kept on disk, so a login lasts like it did in Chrome. Every other link still opens in the browser. */
function isLoginUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase(), p = u.pathname;
  return h === 'passport.twitch.tv' || h === 'id.twitch.tv'
    || ((h === 'www.twitch.tv' || h === 'twitch.tv') && /^\/(login|signup|passport|authorize|user\/two_factor)/i.test(p));
}
const LOGIN_PAGES = {
  twitch: 'https://www.twitch.tv/login',
};
const loginWindowOptions = () => ({
  width: 520, height: 780, parent: win || undefined, autoHideMenuBar: true, backgroundColor: '#0e0e10', title: 'Pulse Chat: log in',
  webPreferences: { contextIsolation: true, sandbox: true },
});
// Pop-ups from a page or a login window: sign-in pages in an app window, the rest in the normal browser
function popupRules(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isLoginUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: loginWindowOptions() };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => { child.setMenu(null); popupRules(child.webContents); });
}
function openLogin(site) {
  const url = LOGIN_PAGES[site];
  if (!url) return;
  const lw = new BrowserWindow(loginWindowOptions());
  lw.setMenu(null);
  popupRules(lw.webContents);
  // Logged in: Twitch moves on to its home page, Google to YouTube's; the window closes by itself then
  let left = false;
  const check = (e, to) => {
    try {
      const u = new URL(to), h = u.hostname;
      const done = /(^|\.)twitch\.tv$/.test(h) && !isLoginUrl(to);
      if (done && !left) { left = true; setTimeout(() => { if (!lw.isDestroyed()) lw.close(); }, 1200); }
    } catch (err) { /* not a web address */ }
  };
  lw.webContents.on('did-navigate', check);
  lw.on('closed', () => { if (win && !win.isDestroyed()) win.webContents.send('pulse-login-done', site); });
  lw.loadURL(url);
}
ipcMain.on('pulse-login', (e, site) => openLogin(String(site)));
// Who is logged in to Twitch in the app (app 1.0.3): Twitch's own "login" cookie holds the name, "auth-token" says the
// login is real. { twitch: name } or { twitch: null }.
ipcMain.handle('pulse-login-state', async () => {
  try {
    const all = await session.defaultSession.cookies.get({ url: 'https://www.twitch.tv' });
    const tok = all.find((c) => c.name === 'auth-token' && c.value), who = all.find((c) => c.name === 'login' && c.value);
    return { twitch: tok ? (who ? decodeURIComponent(who.value) : 'you') : null };
  } catch (e) { return { twitch: null }; }
});

/* ---------- what the page is doing (app 1.3) ----------
   The page reports once a second whether something long is running (a transcription or its queue, a loudness
   measurement, a download, live mode) and how far the transcription / loudness / downloads are (0..1, -1 = nothing
   with an end). While busy, the computer isn't allowed to sleep or to slow Pulse Chat down (App Nap on a Mac); the
   screen can still turn off. The progress shows on the Dock icon (Mac) or the taskbar button (Windows). */
let awakeId = null;
ipcMain.on('pulse-status', (e, s) => {
  const busy = !!(s && s.busy);
  if (busy && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  else if (!busy && awakeId !== null) { try { powerSaveBlocker.stop(awakeId); } catch (err) { /* already stopped */ } awakeId = null; }
  const p = Number(s && s.progress);
  if (win && !win.isDestroyed()) win.setProgressBar(p >= 0 ? Math.max(0.01, Math.min(1, p)) : -1);
});

/* ---------- ffmpeg on request (Mac: app 1.3, Windows: app 1.6) ----------
   Neither system comes with ffmpeg, which clip / VOD downloads need. On request the app fetches it once, checks it
   against the SHA-256 its publisher puts next to it, unpacks it with the system's own tool and keeps it on this
   computer (the Pulse Chat folder here, the app's data folder in a shared copy; never in iCloud):
   - Mac: the latest release build for this chip from Martin Riedl's FFmpeg build server (ffmpeg.martin-riedl.de), ditto;
   - Windows: BtbN's FFmpeg-Builds "latest" 64-bit build on GitHub (checksums.sha256 in the same release), tar.exe. */
const FF_BASE = process.env.PULSE_FF_BASE || 'https://ffmpeg.martin-riedl.de'; // override only for testing
const FF_HOST = new URL(FF_BASE).hostname, FF_PROTO = new URL(FF_BASE).protocol;
const FFW_BASE = process.env.PULSE_FFW_BASE || 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'; // test override
const FFW_ZIP = process.arch === 'arm64' ? 'ffmpeg-master-latest-winarm64-gpl.zip' : 'ffmpeg-master-latest-win64-gpl.zip'; // ~190 MB (x64)
// Hosts a download may come from (and be redirected to): the Mac build server; GitHub and its file storage for Windows
function ffHostOk(u) {
  if (u.protocol === FF_PROTO && u.hostname === FF_HOST) return true;
  const w = new URL(FFW_BASE);
  if (u.protocol === w.protocol && u.hostname === w.hostname) return true;
  return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'));
}
function ffGet(url, onBytes, hops = 0) {
  return new Promise((ok, bad) => {
    let u;
    try { u = new URL(url); } catch (e) { bad(new Error('bad address')); return; }
    if (!ffHostOk(u)) { bad(new Error(`refused to fetch from ${u.hostname}`)); return; }
    const req = (u.protocol === 'http:' ? http : https).get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'PulseChat' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 5) {
        r.resume();
        ok(ffGet(new URL(r.headers.location, url).toString(), onBytes, hops + 1));
        return;
      }
      if (r.statusCode !== 200) { r.resume(); bad(new Error(`HTTP ${r.statusCode} from ${u.hostname}`)); return; }
      const total = +r.headers['content-length'] || 0, parts = [];
      let n = 0;
      r.on('data', (c) => { parts.push(c); n += c.length; if (onBytes && total) onBytes(n / total); });
      r.on('end', () => ok({ url, body: Buffer.concat(parts) }));
      r.on('error', bad);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', bad);
  });
}
const runQuiet = (cmd, args) => new Promise((ok) => {
  let out = '';
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  p.on('error', (e) => ok({ code: -1, out: e.message }));
  p.on('close', (code) => ok({ code, out }));
});
let ffBusy = null;
ipcMain.handle('pulse-get-ffmpeg', (e) => {
  if (!IS_MAC && process.platform !== 'win32') return { ok: false, error: 'Install ffmpeg with your system\'s package manager.' };
  const progress = (f) => { try { e.sender.send('pulse-ffmpeg-progress', f); } catch (err) { /* window gone */ } };
  if (!ffBusy) ffBusy = (IS_MAC ? getFfmpegMac(progress) : getFfmpegWin(progress)).finally(() => { ffBusy = null; });
  return ffBusy;
});
async function getFfmpegWin(progress) {
  if (process.arch !== 'x64' && process.arch !== 'arm64') return { ok: false, error: 'there is no ready-made ffmpeg for 32-bit Windows.' }; // arm64 gets its own build
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ffmpeg-'));
  try {
    const sums = await ffGet(`${FFW_BASE}/checksums.sha256`);
    const line = sums.body.toString('utf8').split(/\r?\n/).find((l) => l.trim().endsWith(FFW_ZIP));
    const want = line && (line.match(/\b[0-9a-f]{64}\b/i) || [])[0];
    if (!want) return { ok: false, error: 'the download site gave no checksum to check it against. Nothing was installed.' };
    const zip = await ffGet(`${FFW_BASE}/${FFW_ZIP}`, progress);
    if (crypto.createHash('sha256').update(zip.body).digest('hex') !== want.toLowerCase()) return { ok: false, error: 'the download doesn\'t match its published checksum. Nothing was installed; try again.' };
    const zipPath = path.join(tmp, 'ffmpeg.zip'), out = path.join(tmp, 'x');
    fs.writeFileSync(zipPath, zip.body);
    fs.mkdirSync(out);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows 10 and 11 have it
    const unz = await runQuiet(fs.existsSync(tar) ? tar : 'tar', ['-xf', zipPath, '-C', out]);
    if (unz.code !== 0) return { ok: false, error: `couldn't unpack it (${unz.out.trim().slice(0, 200)})` };
    const found = (function find(d) {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n), st = fs.statSync(p);
        if (st.isDirectory()) { const f = find(p); if (f) return f; } else if (n.toLowerCase() === 'ffmpeg.exe') return p;
      }
      return null;
    })(out);
    if (!found) return { ok: false, error: 'there was no ffmpeg.exe in the download.' };
    fs.mkdirSync(FF_DIR, { recursive: true });
    const dest = path.join(FF_DIR, 'ffmpeg.exe'), part = path.join(FF_DIR, 'ffmpeg.part.exe');
    fs.copyFileSync(found, part);
    const test = await runQuiet(part, ['-hide_banner', '-version']);
    if (test.code !== 0) { rm(part); return { ok: false, error: `it doesn't run on this computer (${test.out.trim().slice(0, 200)})` }; }
    rm(dest);
    fs.renameSync(part, dest);
    const ver = (test.out.match(/ffmpeg version (\S+)/) || [])[1];
    return { ok: true, version: ver ? `ffmpeg ${ver}` : 'ffmpeg', path: dest };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* temp */ }
  }
}
async function getFfmpegMac(progress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ffmpeg-'));
  try {
    const latest = `${FF_BASE}/redirect/latest/macos/${arch}/release/ffmpeg.zip`;
    const zip = await ffGet(latest, progress);
    // the checksum sits next to the file the address led to; the "latest" address with .sha256 as a second try
    const sumFile = await ffGet(`${zip.url}.sha256`).catch(() => ffGet(`${latest}.sha256`));
    const want = (sumFile.body.toString('utf8').match(/\b[0-9a-f]{64}\b/i) || [])[0];
    const got = crypto.createHash('sha256').update(zip.body).digest('hex');
    if (!want) return { ok: false, error: 'the download site gave no checksum to check it against. Nothing was installed.' };
    if (want.toLowerCase() !== got) return { ok: false, error: 'the download doesn\'t match its published checksum. Nothing was installed; try again.' };
    const zipPath = path.join(tmp, 'ffmpeg.zip');
    fs.writeFileSync(zipPath, zip.body);
    const unz = await runQuiet('/usr/bin/ditto', ['-x', '-k', zipPath, path.join(tmp, 'x')]);
    if (unz.code !== 0) return { ok: false, error: `couldn't unpack it (${unz.out.trim().slice(0, 200)})` };
    const found = (function find(d) {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n), st = fs.statSync(p);
        if (st.isDirectory() && !n.startsWith('__MACOSX')) { const f = find(p); if (f) return f; } else if (n === 'ffmpeg') return p;
      }
      return null;
    })(path.join(tmp, 'x'));
    if (!found) return { ok: false, error: 'there was no ffmpeg program in the download.' };
    fs.mkdirSync(FF_DIR, { recursive: true });
    const dest = path.join(FF_DIR, 'ffmpeg'), part = `${dest}.part`;
    fs.copyFileSync(found, part);
    fs.chmodSync(part, 0o755);
    await runQuiet('/usr/bin/xattr', ['-c', part]);
    let test = await runQuiet(part, ['-hide_banner', '-version']);
    if (test.code !== 0) { // an unsigned build won't start on Apple Silicon: sign it for this Mac (ad hoc), as the app is
      await runQuiet('/usr/bin/codesign', ['--force', '--sign', '-', part]);
      test = await runQuiet(part, ['-hide_banner', '-version']);
    }
    if (test.code !== 0) { rm(part); return { ok: false, error: `it doesn't run on this Mac (${test.out.trim().slice(0, 200)})` }; }
    fs.renameSync(part, dest);
    const ver = (test.out.match(/ffmpeg version (\S+)/) || [])[1];
    return { ok: true, version: ver ? `ffmpeg ${ver}` : 'ffmpeg', path: dest };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* temp */ }
  }
}

/* ---------- commands for the page (app 1.4): menus, Dock menu, Windows jump list, files opened from Finder ----------
   Sent as 'pulse-command' { action, ... }; held back until the page has loaded (and again after a reload). */
let pageReady = false;
const pendingCmds = [];
function sendCmd(c) {
  if (win && !win.isDestroyed() && pageReady) { win.webContents.send('pulse-command', c); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  else pendingCmds.push(c);
}
function flushCmds() { pageReady = true; while (pendingCmds.length) sendCmd(pendingCmds.shift()); }
// A chat log (.json / .json.gz) given by path: dropped on the Dock icon, "Open With" in Finder, or File > Import
function openChatFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return;
    if (st.size > 1024 * 1024 * 1024) { dialog.showErrorBox('Pulse Chat', `${path.basename(p)} is over 1 GB; that's not a chat log.`); return; }
    sendCmd({ action: 'open-file', name: path.basename(p), data: fs.readFileSync(p) });
  } catch (e) { dialog.showErrorBox('Pulse Chat', `Couldn't open ${path.basename(p)}: ${e.message}`); }
}
// Mac: files dropped on the Dock icon or opened with Pulse Chat from Finder (may come before the window exists)
app.on('open-file', (e, p) => { e.preventDefault(); openChatFile(p); });
async function importChatLog() {
  const r = await dialog.showOpenDialog(win, { title: 'Import chat log', properties: ['openFile'], filters: [{ name: 'Chat log', extensions: ['json', 'gz'] }, { name: 'All files', extensions: ['*'] }] });
  if (!r.canceled && r.filePaths[0]) openChatFile(r.filePaths[0]);
}
// Windows jump list items start Pulse Chat.exe again with one of these; the running copy gets them (second-instance)
function argCommands(argv) {
  const out = [];
  for (const a of argv || []) {
    let m;
    if ((m = /^--pulse-open-vod=(\d{1,15})$/.exec(a))) out.push({ action: 'open-vod', id: m[1] });
    else if ((m = /^--pulse-go-live=([a-z0-9_]{2,25})$/i.exec(a))) out.push({ action: 'go-live', login: m[1].toLowerCase() });
    else if (a === '--pulse-open-dialog') out.push({ action: 'open-vod-dialog' });
  }
  return out;
}

/* Recent VODs and "Go live" (app 1.4): on the Dock icon's menu (Mac) and the taskbar button's jump list (Windows). The
   page sends its recent list whenever it changes. */
const short = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
ipcMain.on('pulse-recent', (e, r) => {
  const recent = (r && Array.isArray(r.recent) ? r.recent : []).filter((x) => x && /^\d{1,15}$/.test(String(x.id))).slice(0, 8);
  const goLive = r && /^[a-z0-9_]{2,25}$/i.test(String(r.goLive || '')) ? String(r.goLive).toLowerCase() : null;
  const label = (x) => short(`${x.streamer ? `${x.streamer}: ` : ''}${x.title || `VOD ${x.id}`}`, 60);
  if (IS_MAC && app.dock) {
    const items = recent.map((x) => ({ label: label(x), click: () => sendCmd({ action: 'open-vod', id: String(x.id) }) }));
    if (items.length) items.push({ type: 'separator' });
    if (goLive) items.push({ label: `Go live: ${goLive}`, click: () => sendCmd({ action: 'go-live', login: goLive }) });
    items.push({ label: 'Open Twitch VOD…', click: () => sendCmd({ action: 'open-vod-dialog' }) });
    try { app.dock.setMenu(Menu.buildFromTemplate(items)); } catch (err) { /* no Dock */ }
  } else if (process.platform === 'win32') {
    const task = (title, args, description) => ({ type: 'task', title, description: description || title, program: process.execPath, args, iconPath: process.execPath, iconIndex: 0 });
    const list = [];
    if (recent.length) list.push({ type: 'custom', name: 'Recent VODs', items: recent.map((x) => task(label(x), `--pulse-open-vod=${x.id}`, short(x.title || `VOD ${x.id}`, 200))) });
    list.push({ type: 'tasks', items: [
      ...(goLive ? [task(`Go live: ${goLive}`, `--pulse-go-live=${goLive}`, `Watch ${goLive} live in Pulse Chat`)] : []),
      task('Open Twitch VOD…', '--pulse-open-dialog', 'Paste a Twitch VOD link or a channel name'),
    ] });
    try { app.setJumpList(list); } catch (err) { /* older Windows */ }
  }
});

/* The window's size and place are remembered between starts (app 1.4); the first start, or a saved place that no
   longer fits any screen, opens maximized as before. Kept in the app's own data folder (on each computer). */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWinState() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const b = st && st.bounds;
    if (!b || !(b.width >= 600 && b.height >= 400)) return null;
    const onScreen = screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 10 && b.y < w.y + w.height - 80;
    });
    return onScreen ? st : null;
  } catch (e) { return null; }
}
let saveTimer = null;
function saveWinState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() })); } catch (e) { /* not important */ }
}
const saveWinStateSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWinState, 800); };

/* ---------- saved work synced through a cloud folder (app 1.5: iCloud; app 1.6: a choice) ----------
   With sync on, the page keeps a copy of its saved work in "<cloud folder>/Pulse Chat/Data": vod-<id>.json (starred
   clips, notes, tags, watched marks, downloaded marks, transcript offset), transcript-<id>.json, loudness-<id>.json and
   recent.json. The page decides what to merge; this side only lists, reads and writes those files (whole-file writes
   through a temporary file, so the other computer never reads half a file) and tells the page when one changed: a
   folder watcher, plus a look every 20 s (cloud apps don't always raise file events). Chats and settings aren't synced.
   Which folder (app 1.6): iCloud Drive, Dropbox, OneDrive, Google Drive or any folder, saved in the app's data folder
   (sync.json). With none saved: a shared copy doesn't sync; this app on its owner's computers keeps iCloud as before. */
const SYNC_NAME = /^(?:(?:vod|transcript|loudness)-\d{1,15}|recent)\.json$/;
const SYNC_SETTING = path.join(app.getPath('userData'), 'sync.json');
const SYNC_KINDS = { icloud: 'iCloud Drive', dropbox: 'Dropbox', onedrive: 'OneDrive', gdrive: 'Google Drive', folder: 'Another folder' };
const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const firstDir = (list) => list.find(isDir) || null;
const cloudStorage = (prefix) => { // Mac: ~/Library/CloudStorage/<Provider>-<account>
  const base = path.join(os.homedir(), 'Library', 'CloudStorage');
  try { return fs.readdirSync(base).filter((n) => n.startsWith(prefix)).map((n) => path.join(base, n)); } catch (e) { return []; }
};
// Where each cloud service keeps its folder on this computer (null: not found)
function cloudBase(kind) {
  const home = os.homedir();
  if (kind === 'icloud') return firstDir(IS_MAC ? [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')] : [path.join(home, 'iCloudDrive'), path.join(home, 'iCloud Drive')]);
  if (kind === 'dropbox') {
    for (const f of [path.join(home, '.dropbox', 'info.json'), path.join(process.env.LOCALAPPDATA || '', 'Dropbox', 'info.json'), path.join(process.env.APPDATA || '', 'Dropbox', 'info.json')]) {
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const p = (j.personal || j.business || {}).path; if (isDir(p)) return p; } catch (e) { /* not this one */ }
    }
    return firstDir([...cloudStorage('Dropbox'), path.join(home, 'Dropbox')]);
  }
  if (kind === 'onedrive') return firstDir([process.env.OneDriveConsumer, process.env.OneDrive, ...cloudStorage('OneDrive'), path.join(home, 'OneDrive')].filter(Boolean));
  if (kind === 'gdrive') {
    const mac = cloudStorage('GoogleDrive').map((d) => path.join(d, 'My Drive'));
    const win = process.platform === 'win32' ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\My Drive`) : [];
    return firstDir([...mac, ...win, path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'Google Drive')]);
  }
  return null;
}
function readSyncSetting() {
  try {
    const j = JSON.parse(fs.readFileSync(SYNC_SETTING, 'utf8'));
    if (j && j.kind === 'off') return { kind: 'off' };
    if (j && SYNC_KINDS[j.kind] && typeof j.path === 'string' && j.path) return { kind: j.kind, path: j.path };
  } catch (e) { /* none saved yet */ }
  return null;
}
// The Data folder in use, or null (sync off)
function syncChoice() {
  const s = readSyncSetting();
  if (s && s.kind === 'off') return { kind: 'off', base: null };
  if (s) return { kind: s.kind, base: s.path };
  if (!DIST && SYNC_HOME) return { kind: 'icloud', base: path.dirname(SYNC_HOME), legacy: true };
  return { kind: 'off', base: null };
}
let syncNow = syncChoice();
let SYNC_DATA = syncNow.base ? path.join(syncNow.base, 'Pulse Chat', 'Data') : null;
const syncInfo = () => ({ on: !!SYNC_DATA, kind: syncNow.kind, name: SYNC_KINDS[syncNow.kind] || 'Off', path: SYNC_DATA ? path.dirname(SYNC_DATA) : null, folderOk: !SYNC_DATA || isDir(syncNow.base) });
const syncSeen = new Map(); // name → mtime last reported to the page (or written by it)
function syncList() {
  if (!SYNC_DATA) return [];
  let names = [];
  try { names = fs.readdirSync(SYNC_DATA); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (!SYNC_NAME.test(name)) continue; // cloud apps' "name 2.json" conflict copies and temp files are left alone
    try { out.push({ name, mtime: fs.statSync(path.join(SYNC_DATA, name)).mtimeMs }); } catch (e) { /* gone */ }
  }
  return out;
}
ipcMain.handle('pulse-sync-info', () => syncInfo());
// app 1.6: the choices for the setup screen and the settings: [{ kind, name, path, found }], and which one is in use
ipcMain.handle('pulse-sync-options', () => ({
  current: syncInfo(),
  options: ['icloud', 'dropbox', 'onedrive', 'gdrive'].map((kind) => { const p = cloudBase(kind); return { kind, name: SYNC_KINDS[kind], path: p, found: !!p }; })
    .concat([{ kind: 'folder', name: SYNC_KINDS.folder, path: syncNow.kind === 'folder' ? syncNow.base : null, found: true }]),
}));
// kind: 'off' | 'icloud' | 'dropbox' | 'onedrive' | 'gdrive' | 'folder' (asks for the folder). The page reloads after.
ipcMain.handle('pulse-sync-choose', async (e, kind) => {
  kind = String(kind);
  let base = null;
  if (kind === 'folder') {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { title: 'Sync Pulse Chat through this folder', buttonLabel: 'Use this folder',
      message: 'Pick a folder that a sync app keeps in step between your computers (Syncthing, a network drive…). Pulse Chat makes a "Pulse Chat" folder in it.', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, info: syncInfo() };
    base = r.filePaths[0];
  } else if (kind !== 'off') {
    if (!SYNC_KINDS[kind]) return { ok: false, error: 'unknown choice', info: syncInfo() };
    base = cloudBase(kind);
    if (!base) return { ok: false, error: `${SYNC_KINDS[kind]} wasn't found on this computer.`, info: syncInfo() };
  }
  try {
    fs.mkdirSync(path.dirname(SYNC_SETTING), { recursive: true });
    fs.writeFileSync(SYNC_SETTING, JSON.stringify(kind === 'off' ? { kind: 'off' } : { kind, path: base }));
  } catch (err) { return { ok: false, error: `couldn't save the choice (${err.message})`, info: syncInfo() }; }
  syncNow = syncChoice();
  SYNC_DATA = syncNow.base ? path.join(syncNow.base, 'Pulse Chat', 'Data') : null;
  syncSeen.clear();
  syncWatch();
  return { ok: true, info: syncInfo() };
});
ipcMain.handle('pulse-sync-list', () => { const l = syncList(); for (const f of l) syncSeen.set(f.name, f.mtime); return l.map((f) => f.name); });
// { text } when read, { missing: true } when there's no such file yet, { error } when it couldn't be read (the cloud
// app still downloading it, offline): the page then leaves that file alone and tries again later, it never takes an
// unreadable file for an empty one
ipcMain.handle('pulse-sync-read', (e, name) => {
  if (!SYNC_DATA || !SYNC_NAME.test(String(name))) return { error: 'not a sync file' };
  try { return { text: fs.readFileSync(path.join(SYNC_DATA, name), 'utf8') }; } catch (err) {
    return err && err.code === 'ENOENT' ? { missing: true } : { error: (err && err.message) || 'unreadable' };
  }
});
ipcMain.handle('pulse-sync-write', (e, name, text) => {
  if (!SYNC_DATA || !SYNC_NAME.test(String(name)) || typeof text !== 'string' || text.length > 64 * 1024 * 1024) return false;
  try {
    fs.mkdirSync(SYNC_DATA, { recursive: true });
    const dest = path.join(SYNC_DATA, name), tmp = path.join(SYNC_DATA, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, dest);
    syncSeen.set(name, fs.statSync(dest).mtimeMs); // our own write isn't reported back as a change
    return true;
  } catch (err) { console.warn('[Pulse Chat] sync write failed', name, err && err.message); return false; }
});
let syncTimer = null;
function syncCheck() {
  if (!win || win.isDestroyed()) return;
  const changed = [];
  for (const f of syncList()) if (syncSeen.get(f.name) !== f.mtime) { syncSeen.set(f.name, f.mtime); changed.push(f.name); }
  if (changed.length) win.webContents.send('pulse-sync-changed', changed);
}
let syncWatcher = null, syncWatched = null, syncPoll = null;
function syncWatch() {
  if (syncWatched === SYNC_DATA) return; // once per folder, not again on every page reload
  if (syncWatcher) { try { syncWatcher.close(); } catch (e) { /* already closed */ } syncWatcher = null; }
  syncWatched = SYNC_DATA;
  if (!SYNC_DATA) return;
  try { fs.mkdirSync(SYNC_DATA, { recursive: true }); } catch (e) { /* the cloud folder isn't ready */ }
  try { syncWatcher = fs.watch(SYNC_DATA, () => { clearTimeout(syncTimer); syncTimer = setTimeout(syncCheck, 700); }); } catch (e) { /* the 20 s look still runs */ }
  if (!syncPoll) syncPoll = setInterval(syncCheck, 20000);
}

/* ---------- updates (app 1.6, shared copies) ----------
   The installers are published as GitHub releases (see BUILDING.md); the build writes the repository into the app's
   package.json (pulseRepo). The page asks now and then whether a newer release is out and offers to download it:
   nothing is installed by itself (the app isn't signed, so an update is a new installer the user runs). */
const UPDATE_REPO = typeof PKG.pulseRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(PKG.pulseRepo) ? PKG.pulseRepo : null;
const verParts = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }
ipcMain.handle('pulse-check-update', async () => {
  if (!UPDATE_REPO) return { ok: false, error: 'updates are only checked in the shared app' };
  try {
    const { net } = require('electron');
    const r = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `PulseChat/${APP_VERSION}` } });
    if (r.status === 404) return { ok: true, newer: false, current: APP_VERSION, latest: null };
    if (!r.ok) return { ok: false, error: `GitHub answered ${r.status}` };
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    const assets = Array.isArray(j.assets) ? j.assets : [];
    const want = IS_MAC ? /\.dmg$/i : process.platform === 'win32' ? /\.exe$/i : /\.AppImage$/i;
    const asset = assets.find((a) => want.test(a.name || ''));
    const pageUrl = /^https:\/\/github\.com\//.test(j.html_url || '') ? j.html_url : `https://github.com/${UPDATE_REPO}/releases/latest`;
    const assetUrl = asset && /^https:\/\/github\.com\//.test(asset.browser_download_url || '') ? asset.browser_download_url : null;
    // a release still being built has no installer yet: it's offered once the one for this computer is there
    return { ok: true, newer: !!latest && !!assetUrl && isNewer(latest, APP_VERSION), current: APP_VERSION, latest, pageUrl, assetUrl, notes: String(j.body || '').slice(0, 2000) };
  } catch (err) { return { ok: false, error: (err && err.message) || 'no answer' }; }
});
ipcMain.on('pulse-open-external', (e, url) => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(String(url)); });

/* ---------- diagnostics (app 1.6): what the page's "Copy diagnostics" adds about the app ---------- */
const tidyPath = (p) => (p ? String(p).split(os.homedir()).join('~') : p);
ipcMain.handle('pulse-diag', () => {
  const ff = findFfmpeg();
  const sy = syncInfo();
  return {
    app: APP_VERSION, shared: DIST, packaged: app.isPackaged, repo: UPDATE_REPO,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    os: `${IS_MAC ? `macOS ${typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release()}` : process.platform === 'win32' ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`} (${process.arch})`,
    glass: GLASS, port: servers && servers.port, page: tidyPath(pagePath()), code: tidyPath(__dirname),
    ffmpeg: tidyPath(ff) || 'not found', sync: sy.on ? `${sy.name}: ${tidyPath(sy.path)}${sy.folderOk ? '' : ' (folder missing)'}` : 'off',
    memoryMB: Math.round(process.memoryUsage().rss / 1048576), upMinutes: Math.round(process.uptime() / 60),
  };
});
ipcMain.handle('pulse-ffmpeg-info', () => ({ found: !!findFfmpeg(), canFetch: IS_MAC || process.platform === 'win32' }));

/* ---------- the window ---------- */
let win = null;

// Mac (app 1.1.1): a double-click on the page's top bar maximizes the window, or puts it back. If macOS zoomed the
// window by itself already (its own title-bar double-click), the size has moved by the time we look, so nothing more
// is done (otherwise the two would undo each other).
ipcMain.on('pulse-titlebar-dblclick', () => {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  const before = JSON.stringify(win.getBounds());
  setTimeout(() => {
    if (!win || win.isDestroyed() || JSON.stringify(win.getBounds()) !== before) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  }, 120);
});
let servers = null;

// Twitch's player and other sites see plain Chrome, not "Electron" / "pulse-chat" (some sites treat unknown browsers differently)
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|pulse-chat|PulseChat)\/\S+/gi, '');
const AUMID = 'PulseChat.App'; // Windows: groups the taskbar button and names the notifications "Pulse Chat"
if (process.platform === 'win32') app.setAppUserModelId(AUMID);

// Start menu and desktop shortcuts, made on the first start (and the Start menu one again if it goes missing: Windows
// shows the app's notifications only with it). A desktop shortcut you delete stays deleted.
function makeShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged || DIST) return; // a shared copy's installer makes its own
  const icon = iconFile('icon.ico');
  const link = { target: process.execPath, cwd: exeDir, appUserModelId: AUMID, description: 'Pulse Chat', icon: fs.existsSync(icon) ? icon : process.execPath, iconIndex: 0 };
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Pulse Chat.lnk');
  const flag = path.join(app.getPath('userData'), 'shortcuts-made');
  try { shell.writeShortcutLink(startMenu, fs.existsSync(startMenu) ? 'replace' : 'create', link); } catch (e) { /* no Start menu */ }
  if (!fs.existsSync(flag)) {
    try { shell.writeShortcutLink(path.join(app.getPath('desktop'), 'Pulse Chat.lnk'), 'create', link); } catch (e) { /* no desktop */ }
    try { fs.writeFileSync(flag, new Date().toISOString()); } catch (e) { /* no matter */ }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already open: the first copy comes to the front (second-instance below)
} else {
  app.on('second-instance', (e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    for (const c of argCommands(argv)) sendCmd(c); // a Windows jump list item (app 1.4)
    if (!IS_MAC) for (const a of argv.slice(1)) if (/\.json(\.gz)?$/i.test(a) && fs.existsSync(a)) openChatFile(a);
  });
  for (const c of argCommands(process.argv)) pendingCmds.push(c); // started from a jump list item
  app.whenReady().then(async () => {
    // Windows: no menu bar. Mac: the usual app menu, which also makes ⌘C / ⌘V / ⌘X / ⌘A, ⌘Q and ⌘R work
    Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([
      UPDATE_REPO ? { label: app.name, submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => sendCmd({ action: 'check-update' }) },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ] } : { role: 'appMenu' },
      // app 1.4: Pulse Chat's own commands, the Mac way
      { label: 'File', submenu: [
        { label: 'Open Twitch VOD…', accelerator: 'CmdOrCtrl+O', click: () => sendCmd({ action: 'open-vod-dialog' }) },
        { label: 'Import Chat Log…', accelerator: 'CmdOrCtrl+I', click: () => { importChatLog(); } },
        { type: 'separator' },
        { label: 'Go Live', accelerator: 'CmdOrCtrl+L', click: () => sendCmd({ action: 'go-live' }) },
        { type: 'separator' },
        { role: 'close' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => sendCmd({ action: 'shortcuts' }) },
        { label: 'Run Setup Again…', click: () => sendCmd({ action: 'setup' }) }] },
    ]) : null);
    makeShortcuts();
    for (const port of PORTS) { servers = await listen(port); if (servers) { servers.port = port; break; } }
    if (!servers) { dialog.showErrorBox('Pulse Chat', `Ports ${PORTS[0]}-${PORTS[PORTS.length - 1]} are all taken by other programs, so Pulse Chat can't start.`); app.quit(); return; }
    if (!pagePath()) { dialog.showErrorBox('Pulse Chat', `chat-pulse.html was not found. Keep the app folder inside the folder that has chat-pulse.html (looked in: ${searchDirs.join(', ')}).`); app.quit(); return; }
    const icon = iconFile('icon.png');
    const glassy = GLASS !== 'none';
    const saved = loadWinState();
    win = new BrowserWindow({
      width: 1600, height: 900, minWidth: 900, minHeight: 560, show: false, title: 'Pulse Chat',
      ...(saved ? saved.bounds : {}),
      backgroundColor: glassy ? '#00000000' : '#000c0b',
      icon: fs.existsSync(icon) ? nativeImage.createFromPath(icon) : undefined, autoHideMenuBar: true,
      // Mac: the traffic-light buttons sit over the page's header (it leaves room for them)
      ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } } : {}),
      // Liquid Glass needs a transparent window and NO vibrancy (they'd fight); vibrancy is the fallback
      ...(GLASS === 'liquid' ? { transparent: true } : GLASS === 'vibrancy' ? { transparent: true, vibrancy: 'under-window', visualEffectState: 'active' } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false,
        additionalArguments: [`--pulse-app-version=${APP_VERSION}`, `--pulse-glass=${GLASS}`, `--pulse-platform=${process.platform}`,
          `--pulse-files=${SYNC_HOME && path.resolve(__dirname) === path.resolve(SYNC_HOME, 'app-src') ? 'icloud' : 'local'}`, `--pulse-dist=${DIST ? 1 : 0}`, `--pulse-updates=${UPDATE_REPO ? 1 : 0}`] },
    });
    if (GLASS === 'liquid') {
      win.setWindowButtonVisibility(true);
      // The glass goes behind the page once, after the first load (the window's native view exists then)
      win.webContents.once('did-finish-load', () => {
        try {
          const id = liquidGlass.addView(win.getNativeWindowHandle(), { tintColor: '#00000026' });
          if (id < 0) console.warn('[Pulse Chat] Liquid Glass not available on this Mac');
        } catch (e) { console.warn('[Pulse Chat] Liquid Glass failed:', e && e.message); }
      });
    }
    // Links to twitch.tv and other sites open in the normal browser, never inside the app
    const home = `http://localhost:${servers.port}`;
    popupRules(win.webContents); // login pages in an app window, everything else in the browser
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(home)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
    // Keys the page doesn't use: F5 / Ctrl+R reload, F11 full screen, Ctrl+Shift+I developer tools
    win.webContents.on('before-input-event', (e, k) => {
      if (k.type !== 'keyDown') return;
      if (k.key === 'F5' || (k.control && !k.shift && k.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
      else if (k.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
      else if (k.control && k.shift && k.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
    });
    win.once('ready-to-show', () => {
      if (!saved || saved.maximized) win.maximize(); // first start: maximized, as before
      win.show();
      if (saved && saved.fullScreen) win.setFullScreen(true);
    });
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, saveWinStateSoon);
    win.on('close', saveWinState);
    win.webContents.on('did-start-loading', () => { pageReady = false; });
    win.webContents.on('did-finish-load', flushCmds);
    syncWatch();
    // app 1.3: the page leaves no room for the Mac's window buttons in full screen (they're hidden there)
    const sendFull = () => { if (!win.isDestroyed()) win.webContents.send('pulse-fullscreen', win.isFullScreen()); };
    win.on('enter-full-screen', sendFull);
    win.on('leave-full-screen', sendFull);
    win.webContents.on('did-finish-load', sendFull);
    // Closing while a clip or VOD is downloading: ask first
    win.on('close', (e) => {
      const n = runningJobs().length;
      if (!n || process.env.PULSE_TEST_SAVE_AS) return;
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep downloading', 'Quit and stop'], defaultId: 0, cancelId: 0,
        title: 'Pulse Chat', message: `${n === 1 ? 'A download is' : `${n} downloads are`} still running.`, detail: 'Quitting stops it and deletes the half-made file.' });
      if (r === 0) e.preventDefault();
    });
    win.loadURL(`${home}/`);
  });
  app.on('window-all-closed', () => app.quit());
  // Quitting: stop any ffmpeg still running and delete its half-made file (after ffmpeg has let go of it)
  let quitting = false;
  app.on('will-quit', (e) => {
    if (quitting) return;
    const left = runningJobs();
    if (servers) for (const s of servers) s.close();
    if (!left.length) return;
    e.preventDefault();
    quitting = true;
    for (const j of left) cancelJob(j);
    setTimeout(() => app.exit(0), 1500);
  });
}
// end of Pulse Chat main.js
