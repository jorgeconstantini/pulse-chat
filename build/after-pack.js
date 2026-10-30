// The Mac app isn't signed with an Apple Developer ID (see BUILDING.md), but Apple Silicon Macs only run apps with
// some signature, so the finished universal app gets an ad-hoc one ("-"). The two single-architecture halves are left
// alone: they're merged into the universal app first, and must match file for file.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const { Arch } = require('builder-util');
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || Arch[context.arch] !== 'universal') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`Ad-hoc signed ${appPath}`);
};
