// Tells the page it runs inside the Pulse Chat desktop app (window.pulseApp), and carries its notifications to
// Windows (app 1.0.1: with Windows' notification sound) and their clicks back
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const arg = process.argv.find((a) => a.startsWith('--pulse-app-version='));
const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--pulse-${k}=`)); return a ? a.split('=')[1] : ''; };
const clickHandlers = new Map();
ipcRenderer.on('pulse-notify-click', (e, id) => { const f = clickHandlers.get(id); if (f) { clickHandlers.delete(id); try { f(); } catch (err) { /* the page's handler */ } } });
let n = 0;
const loginHandlers = [];
ipcRenderer.on('pulse-login-done', (e, site) => { for (const f of loginHandlers) { try { f(site); } catch (err) { /* the page's handler */ } } });
contextBridge.exposeInMainWorld('pulseApp', {
  // Opens Twitch's or YouTube's sign-in in an app window ('twitch' | 'youtube'); onLoginDone(f) runs f(site) when it closes
  login(site) { ipcRenderer.send('pulse-login', String(site)); },
  loginState() { return ipcRenderer.invoke('pulse-login-state'); }, // { twitch: name | null }
  onLoginDone(f) { if (typeof f === 'function') loginHandlers.push(f); },
  isApp: true,
  platform: argOf('platform'),          // 'win32' | 'darwin' | 'linux' (app 1.1)
  glass: argOf('glass') || 'none',      // 'liquid' | 'vibrancy' | 'none': the window behind the page is see-through glass
  appVersion: arg ? arg.split('=')[1] : '',
  files: argOf('files') || 'local',     // 'icloud' | 'local': where the app's files came from (app 1.2)
  dist: argOf('dist') === '1',          // app 1.6: a shared copy (installer), not this app on its owner's computers
  updates: argOf('updates') === '1',    // app 1.6: it can check GitHub for a newer release
  titleBarDoubleClick() { ipcRenderer.send('pulse-titlebar-dblclick'); }, // Mac (app 1.1.1): maximize / restore
  // app 1.3: what's running ({ busy, progress 0..1 or -1 }): keeps the computer awake, progress on the Dock / taskbar
  status(s) { ipcRenderer.send('pulse-status', { busy: !!(s && s.busy), progress: Number(s && s.progress) }); },
  // app 1.3: f(true / false) when the window enters / leaves full screen
  onFullScreen(f) { if (typeof f === 'function') ipcRenderer.on('pulse-fullscreen', (e, on) => { try { f(!!on); } catch (err) { /* the page's handler */ } }); },
  // app 1.5: saved work synced through iCloud Drive's Pulse Chat/Data folder (the page merges; see main.js)
  sync: {
    info: () => ipcRenderer.invoke('pulse-sync-info'),        // { on, kind, name, path, folderOk }
    options: () => ipcRenderer.invoke('pulse-sync-options'),  // app 1.6: { current, options: [{ kind, name, path, found }] }
    choose: (kind) => ipcRenderer.invoke('pulse-sync-choose', String(kind)), // app 1.6: { ok, info, error?, canceled? }
    list: () => ipcRenderer.invoke('pulse-sync-list'),
    read: (name) => ipcRenderer.invoke('pulse-sync-read', String(name)),
    write: (name, text) => ipcRenderer.invoke('pulse-sync-write', String(name), String(text)),
    onChanged(f) { if (typeof f === 'function') ipcRenderer.on('pulse-sync-changed', (e, names) => { try { f(Array.isArray(names) ? names.map(String) : []); } catch (err) { /* the page's handler */ } }); },
  },
  // app 1.4: commands from the menus, the Dock menu / jump list and files opened from Finder: f({ action, ... })
  onCommand(f) { if (typeof f === 'function') ipcRenderer.on('pulse-command', (e, c) => { try { f(c); } catch (err) { /* the page's handler */ } }); },
  // app 1.4: the recent VODs and the channel for "Go live", for the Dock menu (Mac) and the jump list (Windows)
  setRecent(r) { ipcRenderer.send('pulse-recent', r); },
  // app 1.6: { ok, newer, current, latest, pageUrl, assetUrl, notes } or { ok: false, error }
  checkUpdate() { return ipcRenderer.invoke('pulse-check-update'); },
  openExternal(url) { ipcRenderer.send('pulse-open-external', String(url)); }, // GitHub links only
  diagnostics() { return ipcRenderer.invoke('pulse-diag'); }, // app 1.6: versions, folders, ffmpeg, sync
  ffmpegInfo() { return ipcRenderer.invoke('pulse-ffmpeg-info'); }, // app 1.6: { found, canFetch }
  // app 1.3, Mac (1.6: and Windows): fetch ffmpeg into the Pulse Chat folder; resolves { ok, version } or { ok: false, error }
  getFfmpeg() { return ipcRenderer.invoke('pulse-get-ffmpeg'); },
  onFfmpegProgress(f) {
    if (typeof f !== 'function') return null;
    const h = (e, frac) => { try { f(Number(frac) || 0); } catch (err) { /* the page's handler */ } };
    ipcRenderer.on('pulse-ffmpeg-progress', h);
    return () => ipcRenderer.removeListener('pulse-ffmpeg-progress', h);
  },
  notify(title, body, onClick) {
    const id = `n${++n}`;
    if (typeof onClick === 'function') { clickHandlers.set(id, onClick); if (clickHandlers.size > 30) clickHandlers.delete(clickHandlers.keys().next().value); }
    ipcRenderer.send('pulse-notify', { id, title: String(title || ''), body: String(body || '') });
  },
});
