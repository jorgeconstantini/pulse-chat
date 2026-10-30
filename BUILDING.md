# Sharing Pulse Chat: building the installers

The app you use on your own Mac and PC runs straight from this folder (and iCloud). Friends and colleagues get a
**shared copy** instead: a normal installer (`.dmg` for Mac, `Setup .exe` for Windows) that has everything inside it,
built for free by GitHub. A shared copy:

- runs only the code and page inside it (never from iCloud or this folder);
- starts with the first-run setup, an empty word list, and sync **off** (each person can pick iCloud Drive, Dropbox,
  OneDrive, Google Drive or any folder in the setup or in the settings);
- keeps ffmpeg (fetched with one click) and its settings in its own data folder;
- checks GitHub for a newer release every few hours and offers it (Download / Skip this version). Nothing installs by
  itself.

It isn't signed with an Apple or Microsoft certificate (those cost money every year), so the first time macOS and
Windows ask to confirm. The release page says how, and so does the text at the end of this file.

## One-time setup (about 10 minutes)

1. Make a free account on <https://github.com> if you don't have one.
2. Create a **public** repository, for example `pulse-chat` (public, so friends can download the installers and the
   app can see new releases; nothing secret is in the code).
3. Put the contents of this folder in it. The easiest way: on the repository's page press **uploading an existing
   file** and drag in:
   - `app-src` (the whole folder)
   - `chat-pulse.html`
   - `package.json`
   - `build` (the whole folder)
   - this `BUILDING.md`

   Then press **Commit changes**. (With GitHub Desktop or `git`, commit the same files.)
4. The build itself is `.github/workflows/release.yml` in the repository (`build/release.yml` here is a copy:
   hidden folders like `.github` don't copy well through iCloud).

## Making a release

The repository is https://github.com/jorgeconstantini/pulse-chat and Claude can push to it, so the usual way is to
ask Claude to "publish a new version". By hand it's:

1. Change the files in the repository (the new `chat-pulse.html`, `app-src`…) and raise `"version"` in
   `app-src/package.json` (like `1.6.0` → `1.6.1`, or `1.7.0` for bigger changes).
2. That's it: when the change reaches `main` with a version that has no release yet, the **Release** workflow (Actions
   tab) builds both installers (about 10 minutes) and publishes release `v1.6.1` with them attached. A change without a
   new version number builds nothing.
3. Friends download from `https://github.com/jorgeconstantini/pulse-chat/releases/latest`. People who already have
   it see **"Pulse Chat 1.6.1 is out"** within a few hours, or right away from the ? window → **Check for updates**
   (Mac: Pulse Chat menu → Check for Updates…).

Publishing a release by hand on GitHub (Releases → Draft a new release, tag `v1.6.1`) also works: the workflow then
attaches the installers to it.

## What's in here

| File | What it does |
| --- | --- |
| `package.json` | electron-builder settings: app name, icons, installer types, `pulseDist` (marks a shared copy) |
| `build/prepare.js` | copies `chat-pulse.html` into the app and, on a Mac, adds Apple's Liquid Glass add-on |
| `build/after-pack.js` | gives the Mac app the ad-hoc signature Apple Silicon needs to open it at all |
| `build/release.yml` → `.github/workflows/release.yml` | builds both installers on GitHub's computers and attaches them to the release |

Building on your own computer also works (needs Node.js 20): `npm install`, then `npm run dist:mac` on a Mac or
`npm run dist:win` on Windows. The installer lands in `dist`. A copy built this way doesn't know your repository, so
it doesn't check for updates.

## First install, for the people you send it to

**Mac:** open the `.dmg` and drag Pulse Chat to Applications. Open it: macOS says it can't check the app for
malicious software. Press **Done**, open **System Settings → Privacy & Security**, scroll down to "Pulse Chat was
blocked…" and press **Open Anyway** (then your password). Only the first time.

**Windows:** run `Pulse-Chat-Setup-….exe`. If a blue "Windows protected your PC" box appears, press **More info → Run
anyway**. It installs for that user (no administrator needed) with Start menu and desktop shortcuts.

**Updating:** quit Pulse Chat and install the new version over the old one. Clips, transcripts and settings stay.
