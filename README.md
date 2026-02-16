# TubeStash

A Firefox extension that automatically polls your YouTube subscriptions and downloads new videos for local offline viewing. Includes a built-in dashboard with video player, SponsorBlock integration, and YouTube player swap.

## Features

- Automatic subscription polling for new videos
- Local video downloads via yt-dlp
- Built-in video player with SponsorBlock skip/mute
- YouTube-style dashboard with channel filtering, sorting, and search
- Swaps YouTube's player with local copies when available
- Auto-start download host at login

## Requirements

- **Firefox** (Manifest V2, tested on Firefox 115+)
- **Node.js** (v18+)
- **yt-dlp** (installed automatically by the setup script)
- **ffmpeg** (installed automatically by the setup script)

## Installation

### 1. Load the extension in Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on..."**
3. Navigate to the `extension/` folder and select `manifest.json`
4. The TubeStash icon will appear in your toolbar

> **Note:** Temporary add-ons are removed when Firefox closes. For persistent installation, you'll need to sign the extension via [AMO](https://addons.mozilla.org/developers/) or use Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set to `false` in `about:config`.

### 2. Set up the download host

The extension needs a local helper process to download videos.

1. Click the TubeStash toolbar icon — it will open the **Setup** page
2. Click **"Download Installer"** — this downloads a zip file
3. Extract the zip and run the installer:
   - **Windows:** Double-click `install.bat`
   - **Mac/Linux:** Run `bash install.sh` in a terminal
4. The installer will:
   - Install yt-dlp and ffmpeg if missing
   - Copy the host to the install directory
   - Register auto-start at login
   - Start the host immediately
5. Click **"Retry Connection"** on the setup page to verify

Install locations:
- **Windows:** `%LOCALAPPDATA%\tubestash`
- **Mac/Linux:** `~/.tubestash`

### 3. Sync your subscriptions

1. Open TubeStash **Settings** (gear icon on the dashboard, or right-click the toolbar icon → Options)
2. The extension will sync your YouTube subscriptions automatically (requires you to be logged into YouTube)
3. Configure poll interval, max video age, and download concurrency as needed

## Usage

- Click the toolbar icon to open the dashboard
- Videos are automatically polled and downloaded based on your settings
- Click any video card to watch it locally
- Use channel filter, sort order, and type filter to browse
- When visiting YouTube, locally available videos are automatically swapped in

## Uninstalling the host

The installer zip includes uninstall scripts:
- **Windows:** Run `uninstall.bat`
- **Mac/Linux:** Run `bash uninstall.sh`

This stops the host, removes auto-start, and deletes the install directory (including downloaded videos).

## Configuration

Access settings from the dashboard or via the extension's options page:

| Setting | Default | Description |
|---------|---------|-------------|
| Poll Interval | 30 min | How often to check for new videos |
| Max Video Age | 14 days | Videos older than this are cleaned up |
| Download Concurrency | 2 | Simultaneous downloads |
| SponsorBlock | Skip sponsors | Per-category skip/mute/highlight/off |
