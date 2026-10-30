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
4. Turn on the build: on the repository's page press **Add file → Create new file**, type the name
   `.github/workflows/release.yml` (the slashes make the folders), open `build/release.yml` from this folder in
   TextEdit / Notepad, copy all of it into the big box, and press **Commit changes**. (It lives in `build` here
   because files in hidden folders like `.github` don't copy well through iCloud.)

## Making a release

1. Pick a version number higher than the last one, like `1.6.0`, then `1.6.1`, `1.7.0`.
2. On the repository's page: **Releases → Draft a new release → Choose a tag**, type `v1.6.0` (with the `v`), press
   **Create new tag**, then **Publish release** (title and text can stay empty).
3. Open the **Actions** tab: "Release" is building the Mac and Windows installers (10 to 15 minutes). When both are
   green, the release has `Pulse-Chat-1.6.0-mac.dmg` and `Pulse-Chat-Setup-1.6.0.exe` attached, with install notes
   added under your text. (Until then the release has no installers, so wait for green before sending the link.)
4. Send friends the release link: `https://github.com/<you>/pulse-chat/releases/latest`.

To update everyone: change the files in the repository (upload the new `chat-pulse.html` / `app-src`), then make a
new release with a higher number. Everyone's app shows **"Pulse Chat 1.6.1 is out"** within a few hours, or right
away from the ? window → **Check for updates** (Mac: Pulse Chat menu → Check for Updates…).

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
