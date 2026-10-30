// Starts the app's code from app-src in the folder above the app's (C:\claudio, or the Mac's Pulse Chat folder) when
// it's there, so a change to the app only needs Pulse Chat restarted, not installed again; else the copy installed
// inside the app (app 1.0.1). That main.js then switches to the shared copy in iCloud Drive's "Pulse Chat" folder when
// there is one (app 1.2).
'use strict';
const path = require('path');
const fs = require('fs');
// The Pulse Chat folder: above "Pulse Chat App" on Windows, above "Pulse Chat.app" on a Mac (app 1.1)
const exeDir = path.dirname(process.execPath);
const home = process.platform === 'darwin' ? path.resolve(exeDir, '..', '..', '..') : path.dirname(exeDir);
const live = path.join(home, 'app-src', 'main.js');
// A shared copy (app 1.6, "pulseDist" in package.json) only ever runs the code inside it
let dist = false;
try { dist = !!require('./package.json').pulseDist; } catch (e) { /* no package.json */ }
require(!dist && fs.existsSync(live) && !process.env.PULSE_NO_LIVE_SRC ? live : path.join(__dirname, 'main.js'));
