#!/usr/bin/env node
'use strict';

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// On Windows, refresh PATH from registry so we pick up tools installed after
// the browser launched (e.g. ffmpeg via winget). The browser's environment has
// a stale PATH that doesn't include post-install changes.
if (process.platform === 'win32') {
  try {
    // Use PowerShell to get the fully-expanded current user+machine PATH
    const freshPath = execSync(
      'powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\') + \';\' + [Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (freshPath) {
      const combined = [ROOT, ...freshPath.split(';'), ...(process.env.PATH || '').split(';')]
        .filter((p, i, a) => p && a.indexOf(p) === i);
      process.env.PATH = combined.join(';');
    }
  } catch (_) { /* best-effort */ }
}
const VIDEOS_DIR = path.join(ROOT, 'videos');
const COOKIES_PATH = path.join(ROOT, 'cookies.txt');
const LOG_PATH = path.join(ROOT, 'host.log');
const PID_PATH = path.join(ROOT, 'tubestash.pid');
const HOST = '127.0.0.1';
const PORT = 8771;

// ── Logging ─────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(...args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logStream.write(`[${ts}] ${msg}\n`);
}

log('Host starting', { ROOT, pid: process.pid });

// Ensure directories exist
for (const dir of [VIDEOS_DIR, path.join(VIDEOS_DIR, 'channels'), path.join(VIDEOS_DIR, 'thumbnails')]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── PID File ─────────────────────────────────────────────────────────

fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');

function cleanupPid() {
  try { fs.unlinkSync(PID_PATH); } catch {}
}
process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });

// ── Download State ───────────────────────────────────────────────────

const downloadState = new Map(); // videoId → { status, percent, speed, eta, filePath, thumbnailPath, fileSize, duration, description, error }

// ── Download ─────────────────────────────────────────────────────────

const activeProcs = new Map(); // videoId → ChildProcess
const MAX_CONCURRENT = 2;
const downloadQueue = []; // { videoId, cookies }

function startDownload(videoId, cookies) {
  if (activeProcs.has(videoId)) return;

  // Queue if too many active downloads
  if (activeProcs.size >= MAX_CONCURRENT) {
    downloadQueue.push({ videoId, cookies });
    downloadState.set(videoId, { status: 'queued', percent: 0, speed: null, eta: null, filePath: null, thumbnailPath: null, fileSize: null, duration: null, description: null, error: null });
    log('Download queued:', videoId, `(${downloadQueue.length} waiting)`);
    return;
  }

  launchDownload(videoId, cookies);
}

function drainQueue() {
  while (activeProcs.size < MAX_CONCURRENT && downloadQueue.length > 0) {
    const next = downloadQueue.shift();
    if (!activeProcs.has(next.videoId)) {
      launchDownload(next.videoId, next.cookies);
    }
  }
}

function launchDownload(videoId, cookies) {
  log('Download start:', videoId);

  downloadState.set(videoId, { status: 'downloading', percent: 0, speed: null, eta: null, filePath: null, thumbnailPath: null, fileSize: null, duration: null, description: null, error: null });

  const outputTemplate = path.join(VIDEOS_DIR, 'channels', '%(channel)s', '%(id)s.%(ext)s');

  const args = [
    '--no-playlist',
    '-S', 'res:1080',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--merge-output-format', 'mp4',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--newline',
    '--print-json',
    '--windows-filenames',
    '-o', outputTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  // Cookie priority: manual cookies.txt > extension-exported cookies
  let tempCookiePath = null;
  if (fs.existsSync(COOKIES_PATH)) {
    log(`[download ${videoId}] Using manual cookies.txt`);
    args.unshift('--cookies', COOKIES_PATH);
  } else if (cookies) {
    tempCookiePath = path.join(ROOT, `cookies-${videoId}.txt`);
    fs.writeFileSync(tempCookiePath, cookies, 'utf8');
    log(`[download ${videoId}] Using extension cookies (${cookies.length} bytes)`);
    args.unshift('--cookies', tempCookiePath);
  } else {
    log(`[download ${videoId}] No cookies available`);
  }

  // Resolve yt-dlp: prefer local install, then system PATH
  const localYtdlp = path.join(ROOT, 'yt-dlp.exe');
  const ytdlpBin = (process.platform === 'win32' && fs.existsSync(localYtdlp)) ? localYtdlp : 'yt-dlp';

  log(`[download ${videoId}] Running: ${ytdlpBin} ${args.join(' ')}`);
  const proc = spawn(ytdlpBin, args, { cwd: ROOT });
  activeProcs.set(videoId, proc);

  function cleanupTempCookies() {
    if (tempCookiePath) {
      try { fs.unlinkSync(tempCookiePath); } catch {}
    }
  }

  let stdout = '';
  let stderrBuf = '';
  let lastProgressTime = 0;

  proc.stdout.on('data', (chunk) => { stdout += chunk; });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    const line = text.trim();
    if (!line) return;

    // Log all stderr for diagnostics
    log(`[download ${videoId}] ${line}`);

    // Throttle progress to 1/sec
    const now = Date.now();
    if (now - lastProgressTime < 1000) return;
    lastProgressTime = now;

    // Parse yt-dlp progress: [download]  45.2% of 100.00MiB at 5.00MiB/s ETA 00:10
    const match = line.match(/(\d+\.?\d*)%\s+of\s+\S+\s+at\s+(\S+)\s+ETA\s+(\S+)/);
    if (match) {
      const state = downloadState.get(videoId);
      if (state) {
        state.percent = parseFloat(match[1]);
        state.speed = match[2];
        state.eta = match[3];
      }
    }
  });

  proc.on('close', (code) => {
    activeProcs.delete(videoId);
    cleanupTempCookies();
    drainQueue();
    log('yt-dlp exited:', videoId, 'code', code);

    if (code !== 0) {
      const errorLine = stderrBuf.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('ERROR:'))
        .pop() || `yt-dlp exited with code ${code}`;
      log('Download failed:', videoId, errorLine);
      const state = downloadState.get(videoId);
      if (state) {
        state.status = 'error';
        state.error = errorLine;
      } else {
        downloadState.set(videoId, { status: 'error', percent: 0, speed: null, eta: null, filePath: null, thumbnailPath: null, fileSize: null, duration: null, description: null, error: errorLine });
      }
      return;
    }

    try {
      const jsonStart = stdout.lastIndexOf('\n{');
      const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
      const meta = JSON.parse(jsonStr.trim());

      const filePath = meta.filename || meta._filename;
      const duration = meta.duration ? Math.round(meta.duration) : null;
      const description = meta.description || '';
      let fileSize = null;
      try { fileSize = fs.statSync(filePath).size; } catch {}

      // Move thumbnail to videos/thumbnails/{id}.jpg
      const thumbDest = path.join(VIDEOS_DIR, 'thumbnails', `${videoId}.jpg`);
      const possibleThumbs = [
        filePath.replace(/\.[^.]+$/, '.jpg'),
        filePath.replace(/\.[^.]+$/, '.webp'),
      ];
      for (const src of possibleThumbs) {
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, thumbDest);
          try { fs.unlinkSync(src); } catch {}
          break;
        }
      }

      const relFile = path.relative(ROOT, filePath).replace(/\\/g, '/');
      const relThumb = fs.existsSync(thumbDest)
        ? `videos/thumbnails/${videoId}.jpg`
        : null;

      log('Download complete:', videoId, relFile, `${fileSize} bytes`, `${duration}s`);
      const state = downloadState.get(videoId);
      if (state) {
        state.status = 'done';
        state.percent = 100;
        state.filePath = relFile;
        state.thumbnailPath = relThumb;
        state.fileSize = fileSize;
        state.duration = duration;
        state.description = description;
      }
    } catch (e) {
      log('Metadata parse error:', videoId, e.message);
      const state = downloadState.get(videoId);
      if (state) {
        state.status = 'error';
        state.error = `Metadata parse error: ${e.message}`;
      }
    }
  });

  proc.on('error', (err) => {
    activeProcs.delete(videoId);
    cleanupTempCookies();
    drainQueue();
    const state = downloadState.get(videoId);
    if (state) {
      state.status = 'error';
      state.error = `Spawn error: ${err.message}`;
    }
  });
}

function cancelDownload(videoId) {
  const proc = activeProcs.get(videoId);
  if (proc) {
    try { proc.kill(); } catch {}
    activeProcs.delete(videoId);
  }
  // Also remove from queue
  const idx = downloadQueue.findIndex(q => q.videoId === videoId);
  if (idx !== -1) downloadQueue.splice(idx, 1);
  downloadState.delete(videoId);
}

// ── File Operations ──────────────────────────────────────────────────

function deleteFiles(filePath, thumbnailPath) {
  if (filePath) {
    const abs = path.join(ROOT, filePath);
    try { fs.unlinkSync(abs); } catch {}
  }
  if (thumbnailPath) {
    const abs = path.join(ROOT, thumbnailPath);
    try { fs.unlinkSync(abs); } catch {}
  }
}

function getDiskUsage() {
  let totalBytes = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try { totalBytes += fs.statSync(full).size; } catch {}
      }
    }
  }
  walk(VIDEOS_DIR);
  return totalBytes;
}

// ── JSON Body Parser ─────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ── HTTP Server ──────────────────────────────────────────────────────

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sendJson(res, data, status = 200) {
  const json = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API Routes ──────────────────────────────────────────────────
  const urlPath = req.url.split('?')[0];

  if (urlPath.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && urlPath === '/api/ping') {
        sendJson(res, { ok: true, pid: process.pid });
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/downloads') {
        const obj = {};
        for (const [k, v] of downloadState) obj[k] = v;
        sendJson(res, obj);
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/disk-usage') {
        sendJson(res, { totalBytes: getDiskUsage() });
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/download') {
        const body = await readJsonBody(req);
        startDownload(body.videoId, body.cookies || null);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/cancel') {
        const body = await readJsonBody(req);
        cancelDownload(body.videoId);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/delete-files') {
        const body = await readJsonBody(req);
        deleteFiles(body.filePath, body.thumbnailPath);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/ack') {
        const body = await readJsonBody(req);
        const state = downloadState.get(body.videoId);
        if (state && (state.status === 'done' || state.status === 'error')) {
          downloadState.delete(body.videoId);
        }
        sendJson(res, { ok: true });
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (e) {
      log('API error:', e.message);
      sendJson(res, { error: e.message }, 400);
    }
    return;
  }

  // ── Static File Serving (videos/thumbnails) ─────────────────────

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  // Decode and sanitize path
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  // Remove leading slash
  const relPath = decodedPath.replace(/^\/+/, '');
  const filePath = path.join(VIDEOS_DIR, relPath);

  // Prevent directory traversal
  if (!filePath.startsWith(VIDEOS_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const size = stat.size;

  // Handle Range requests for video seeking
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : size - 1;

      if (start >= size || end >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });

      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
  });

  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
});

// ── Single-instance guard ────────────────────────────────────────────

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} already in use — another instance is running. Exiting.`);
    cleanupPid();
    process.exit(0);
  }
  log('HTTP server error:', err.message);
});

httpServer.listen(PORT, HOST, () => {
  log(`HTTP server listening on ${HOST}:${PORT}`);
});
