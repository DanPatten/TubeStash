'use strict';

const btnDownload = document.getElementById('btn-download');
const btnRetry = document.getElementById('btn-retry');
const statusEl = document.getElementById('status');
const runInstructions = document.getElementById('run-instructions');

const isWindows = navigator.platform.startsWith('Win');

if (isWindows) {
  runInstructions.textContent = 'Extract the zip, then double-click install.bat. A command prompt will confirm the setup.';
} else {
  runInstructions.innerHTML = 'Extract the zip, then run in a terminal: <code style="background:#333;padding:2px 6px;border-radius:3px">bash install.sh</code>';
}

// ── Minimal ZIP builder (STORE, no compression) ─────────────────────

function buildZip(files) {
  // files: [{ name: string, content: Uint8Array }]
  const encoder = new TextEncoder();
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.content;
    const crc = crc32(data);

    // Local file header (30 + name + data)
    const local = new ArrayBuffer(30 + nameBytes.length + data.length);
    const lv = new DataView(local);
    const lu = new Uint8Array(local);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // compression: STORE
    lv.setUint16(10, 0, true);            // mod time
    lv.setUint16(12, 0, true);            // mod date
    lv.setUint32(14, crc, true);          // crc32
    lv.setUint32(18, data.length, true);  // compressed size
    lv.setUint32(22, data.length, true);  // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // filename length
    lv.setUint16(28, 0, true);            // extra length
    lu.set(nameBytes, 30);
    lu.set(data, 30 + nameBytes.length);
    parts.push(lu);

    // Central directory entry
    const cen = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cen);
    const cu = new Uint8Array(cen);
    cv.setUint32(0, 0x02014b50, true);   // signature
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, 0, true);            // compression
    cv.setUint16(12, 0, true);            // mod time
    cv.setUint16(14, 0, true);            // mod date
    cv.setUint32(16, crc, true);          // crc32
    cv.setUint32(20, data.length, true);  // compressed size
    cv.setUint32(24, data.length, true);  // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);            // extra length
    cv.setUint16(32, 0, true);            // comment length
    cv.setUint16(34, 0, true);            // disk number
    cv.setUint16(36, 0, true);            // internal attrs
    cv.setUint32(38, 0, true);            // external attrs
    cv.setUint32(42, offset, true);       // local header offset
    cu.set(nameBytes, 46);
    centralDir.push(cu);

    offset += lu.length;
  }

  // End of central directory
  let cdSize = 0;
  for (const c of centralDir) cdSize += c.length;

  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const blob = new Blob([...parts, ...centralDir, new Uint8Array(eocd)], { type: 'application/zip' });
  return blob;
}

function crc32(data) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── File generators ─────────────────────────────────────────────────

function generateInstallBat() {
  return `@echo off
setlocal EnableDelayedExpansion

set "INSTALL_DIR=%LOCALAPPDATA%\\tubestash"
set "SCRIPT_DIR=%~dp0"

echo Installing TubeStash host...
echo.

:: Create install directory early (needed for tool downloads)
mkdir "%INSTALL_DIR%" 2>nul

:: Ensure INSTALL_DIR is on PATH for this session (for locally installed tools)
set "PATH=%INSTALL_DIR%;%PATH%"

:: Check prerequisites
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Download it from: https://nodejs.org/en/download
  echo Then run this installer again.
  pause
  exit /b 1
)

where yt-dlp >nul 2>&1
if errorlevel 1 (
  echo yt-dlp not found. Installing...
  pip install yt-dlp >nul 2>&1
  if errorlevel 1 (
    echo pip not available, downloading standalone yt-dlp.exe...
    curl -L -o "%INSTALL_DIR%\\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    if errorlevel 1 (
      echo ERROR: Could not download yt-dlp. Please install manually: https://github.com/yt-dlp/yt-dlp#installation
      pause
      exit /b 1
    )
    echo yt-dlp installed to %INSTALL_DIR%\\yt-dlp.exe
  ) else (
    echo yt-dlp installed via pip.
  )
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo ffmpeg not found. Installing...
  winget install Gyan.FFmpeg --accept-source-agreements --accept-package-agreements >nul 2>&1
  if errorlevel 1 (
    echo winget failed, trying manual download...
    curl -L -o "%INSTALL_DIR%\\ffmpeg.zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    if errorlevel 1 (
      echo ERROR: Could not download ffmpeg. Please install manually: https://ffmpeg.org/download.html
      pause
      exit /b 1
    )
    echo Extracting ffmpeg...
    powershell -Command "Expand-Archive -Path '%INSTALL_DIR%\\ffmpeg.zip' -DestinationPath '%INSTALL_DIR%\\ffmpeg-tmp' -Force"
    :: Move the binaries from the nested directory to INSTALL_DIR
    for /d %%D in ("%INSTALL_DIR%\\ffmpeg-tmp\\ffmpeg-*") do (
      copy /y "%%D\\bin\\ffmpeg.exe" "%INSTALL_DIR%\\ffmpeg.exe" >nul
      copy /y "%%D\\bin\\ffprobe.exe" "%INSTALL_DIR%\\ffprobe.exe" >nul
    )
    rmdir /s /q "%INSTALL_DIR%\\ffmpeg-tmp" 2>nul
    del "%INSTALL_DIR%\\ffmpeg.zip" 2>nul
    echo ffmpeg installed to %INSTALL_DIR%
  ) else (
    echo ffmpeg installed via winget.
  )
)

:: Create subdirectories
mkdir "%INSTALL_DIR%\\videos" 2>nul
mkdir "%INSTALL_DIR%\\videos\\channels" 2>nul
mkdir "%INSTALL_DIR%\\videos\\thumbnails" 2>nul

:: Copy host files
copy /y "%SCRIPT_DIR%host.js" "%INSTALL_DIR%\\host.js" >nul
copy /y "%SCRIPT_DIR%host.bat" "%INSTALL_DIR%\\host.bat" >nul

:: Generate launcher.vbs (runs host without console window)
(
echo Set WshShell = CreateObject("WScript.Shell"^)
echo WshShell.CurrentDirectory = "%INSTALL_DIR%"
echo WshShell.Run "node ""%INSTALL_DIR%\\host.js""", 0, False
) > "%INSTALL_DIR%\\launcher.vbs"

:: Register auto-start via registry Run key
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "tubestash" /t REG_SZ /d "wscript.exe \"%INSTALL_DIR%\\launcher.vbs\"" /f >nul 2>&1

:: Add INSTALL_DIR to user PATH permanently if not already present
echo "%PATH%" | findstr /i /c:"%INSTALL_DIR%" >nul 2>&1
if errorlevel 1 (
  for /f "tokens=2*" %%A in ('reg query "HKCU\\Environment" /v Path 2^>nul') do set "USERPATH=%%B"
  if defined USERPATH (
    setx PATH "%USERPATH%;%INSTALL_DIR%" >nul 2>&1
  ) else (
    setx PATH "%INSTALL_DIR%" >nul 2>&1
  )
  echo Added %INSTALL_DIR% to user PATH.
)

:: Start the host now
echo Starting host...
wscript.exe "%INSTALL_DIR%\\launcher.vbs"

echo.
echo Done! Host installed to: %INSTALL_DIR%
echo The host is now running and will auto-start at login.
echo.
echo You can close this window and click "Retry Connection" in the extension.
pause
`;
}

function generateHostBat() {
  return `@echo off\r\nnode "%~dp0host.js"\r\n`;
}

function generateInstallSh() {
  const isMac = navigator.platform === 'MacIntel' || navigator.platform.startsWith('Mac');

  return `#!/bin/bash
set -e

INSTALL_DIR="$HOME/.tubestash"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing TubeStash host..."

# Check prerequisites
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Download it from: https://nodejs.org/en/download"
  echo "Then run this installer again."
  exit 1
fi

if ! command -v yt-dlp &> /dev/null; then
  echo "yt-dlp not found. Installing..."
  if command -v brew &> /dev/null; then
    brew install yt-dlp
  elif command -v pip3 &> /dev/null; then
    pip3 install yt-dlp
  elif command -v pip &> /dev/null; then
    pip install yt-dlp
  else
    echo "ERROR: Could not install yt-dlp. Please install manually: https://github.com/yt-dlp/yt-dlp#installation"
    exit 1
  fi
fi

if ! command -v ffmpeg &> /dev/null; then
  echo "ffmpeg not found. Installing..."
  if command -v brew &> /dev/null; then
    brew install ffmpeg
  elif command -v apt &> /dev/null; then
    sudo apt update && sudo apt install -y ffmpeg
  elif command -v dnf &> /dev/null; then
    sudo dnf install -y ffmpeg
  elif command -v pacman &> /dev/null; then
    sudo pacman -S --noconfirm ffmpeg
  else
    echo "ERROR: Could not install ffmpeg. Please install manually: https://ffmpeg.org/download.html"
    exit 1
  fi
fi

# Create directories
mkdir -p "$INSTALL_DIR/videos/channels"
mkdir -p "$INSTALL_DIR/videos/thumbnails"

# Copy host files
cp "$SCRIPT_DIR/host.js" "$INSTALL_DIR/host.js"
chmod +x "$INSTALL_DIR/host.js"

${isMac ? `# Create launchd plist for auto-start (macOS)
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.tubestash.host.plist"
mkdir -p "$PLIST_DIR"

NODE_PATH="$(which node)"

cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tubestash.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$INSTALL_DIR/host.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/host.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/host.log</string>
</dict>
</plist>
PLISTEOF

# Stop existing service if running, then start
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "Registered launchd service for auto-start."` : `# Create systemd user service for auto-start (Linux)
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$SERVICE_DIR/tubestash.service"
mkdir -p "$SERVICE_DIR"

NODE_PATH="$(which node)"

cat > "$SERVICE_PATH" << SVCEOF
[Unit]
Description=TubeStash download host
After=network.target

[Service]
ExecStart=$NODE_PATH $INSTALL_DIR/host.js
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVCEOF

# Enable and start the service
systemctl --user daemon-reload
systemctl --user enable tubestash.service
systemctl --user start tubestash.service
echo "Registered systemd user service for auto-start."`}

echo ""
echo "Done! Host installed to: $INSTALL_DIR"
echo "The host is now running and will auto-start at login."
echo "You can now click 'Retry Connection' in the extension."
`;
}

function generateUninstallBat() {
  return `@echo off
setlocal

set "INSTALL_DIR=%LOCALAPPDATA%\\tubestash"

echo Uninstalling TubeStash host...
echo.

:: Kill running host process using PID file
set "PID_FILE=%INSTALL_DIR%\\tubestash.pid"
if not exist "%PID_FILE%" goto nopid
set /p PID=<"%PID_FILE%"
echo Stopping host (PID: %PID%)...
taskkill /pid %PID% /f >nul 2>&1
goto killdone
:nopid
echo No PID file found, trying fallback...
wmic process where "CommandLine like '%%tubestash%%host.js%%' and Name='node.exe'" call terminate >nul 2>&1
:killdone

:: Remove auto-start registry entry
reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "tubestash" /f >nul 2>&1
echo Removed auto-start registry entry.

:: Remove install directory
if exist "%INSTALL_DIR%" (
  rmdir /s /q "%INSTALL_DIR%"
  echo Removed %INSTALL_DIR%
) else (
  echo Install directory not found, skipping.
)

echo.
echo Done! TubeStash host has been uninstalled.
pause
`;
}

function generateUninstallSh() {
  const isMac = navigator.platform === 'MacIntel' || navigator.platform.startsWith('Mac');

  return `#!/bin/bash

INSTALL_DIR="$HOME/.tubestash"

echo "Uninstalling TubeStash host..."

${isMac ? `# Stop and remove launchd service (macOS)
PLIST_PATH="$HOME/Library/LaunchAgents/com.tubestash.host.plist"
if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm "$PLIST_PATH"
  echo "Removed launchd service."
fi` : `# Stop and remove systemd service (Linux)
if systemctl --user is-active tubestash.service &>/dev/null; then
  systemctl --user stop tubestash.service
fi
systemctl --user disable tubestash.service 2>/dev/null || true
SERVICE_PATH="$HOME/.config/systemd/user/tubestash.service"
if [ -f "$SERVICE_PATH" ]; then
  rm "$SERVICE_PATH"
  systemctl --user daemon-reload
  echo "Removed systemd service."
fi`}

# Kill any remaining host process
if [ -f "$INSTALL_DIR/tubestash.pid" ]; then
  PID=$(cat "$INSTALL_DIR/tubestash.pid")
  kill "$PID" 2>/dev/null || true
  echo "Stopped host (PID: $PID)."
else
  pkill -f "node.*tubestash.*host.js" 2>/dev/null || true
fi

# Remove install directory
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "Removed $INSTALL_DIR"
fi

echo ""
echo "Done! TubeStash host has been uninstalled."
`;
}

// ── Download handler ────────────────────────────────────────────────

const encoder = new TextEncoder();

btnDownload.addEventListener('click', async () => {
  btnDownload.disabled = true;
  btnDownload.textContent = 'Generating...';

  try {
    const hostResp = await fetch(browser.runtime.getURL('native-host/host.js'));
    const hostSource = await hostResp.text();

    const files = [
      { name: 'host.js', content: encoder.encode(hostSource) },
      { name: 'host.bat', content: encoder.encode(generateHostBat()) },
      { name: 'install.bat', content: encoder.encode(generateInstallBat()) },
      { name: 'install.sh', content: encoder.encode(generateInstallSh()) },
      { name: 'uninstall.bat', content: encoder.encode(generateUninstallBat()) },
      { name: 'uninstall.sh', content: encoder.encode(generateUninstallSh()) },
    ];

    const blob = buildZip(files);
    const blobUrl = URL.createObjectURL(blob);

    await browser.downloads.download({
      url: blobUrl,
      filename: 'tubestash-native-host.zip',
      saveAs: false,
    });

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (e) {
    console.error('[tubestash] Installer generation error:', e);
  }

  btnDownload.disabled = false;
  btnDownload.textContent = 'Download Installer';
});

// ── Retry connection ────────────────────────────────────────────────

const restartHelp = document.getElementById('restart-help');

async function showRestartHelpIfReturning() {
  try {
    const data = await browser.storage.local.get('lastPoll');
    if (data.lastPoll) {
      restartHelp.style.display = 'block';
    }
  } catch {}
}

function onConnected() {
  statusEl.textContent = 'Connected! Redirecting to dashboard...';
  statusEl.className = 'status connected';
  setTimeout(() => {
    window.location.href = 'dashboard.html';
  }, 1000);
}

btnRetry.addEventListener('click', async () => {
  btnRetry.disabled = true;
  statusEl.textContent = 'Checking connection...';
  statusEl.className = 'status checking';

  try {
    const result = await browser.runtime.sendMessage({ type: 'retry-connection' });
    if (result.connected) {
      onConnected();
    } else {
      statusEl.textContent = 'Still not connected. Make sure you extracted the zip and ran the installer.';
      statusEl.className = 'status disconnected';
    }
  } catch {
    statusEl.textContent = 'Could not check status';
    statusEl.className = 'status disconnected';
  }

  btnRetry.disabled = false;
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connection-lost') {
    statusEl.textContent = 'Host disconnected';
    statusEl.className = 'status disconnected';
  }
  if (msg.type === 'connection-restored') {
    onConnected();
  }
});

// Check initial status
(async () => {
  try {
    const result = await browser.runtime.sendMessage({ type: 'get-connection-status' });
    if (result.connected) {
      onConnected();
    } else {
      showRestartHelpIfReturning();
    }
  } catch {
    showRestartHelpIfReturning();
  }
})();
