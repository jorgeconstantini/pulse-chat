// Before electron-builder (see BUILDING.md): puts the page inside the app, and on a Mac adds Apple's Liquid Glass
// add-on as the app's one dependency (a prebuilt add-on for Apple Silicon and Intel; Windows doesn't need it).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'app-src');
fs.copyFileSync(path.join(root, 'chat-pulse.html'), path.join(app, 'chat-pulse.html'));
const pkgFile = path.join(app, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (process.platform === 'darwin') pkg.dependencies = { 'electron-liquid-glass': '1.1.1' };
else delete pkg.dependencies;
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
if (pkg.dependencies) {
  const r = require('child_process').spawnSync('npm', ['install', '--omit=dev', '--no-package-lock', '--ignore-scripts'], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`Prepared app-src ${pkg.version}${pkg.dependencies ? ' with Liquid Glass' : ''}`);
