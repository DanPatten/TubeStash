'use strict';

const DEFAULT_SETTINGS = {
  pollInterval: 30,
  maxAgeDays: 14,
  concurrency: 2,
  channels: [],
};

// ── State ────────────────────────────────────────────────────────────

const API = 'http://127.0.0.1:8771';
let connected = false;
const downloadQueue = [];          // { videoId, published_at } waiting to start
const activeDownloads = new Map();  // videoId → { status }
let concurrency = 2;
let pollTimer = null;

// ── HTTP API Helpers ─────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(API + path);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Connection Check ─────────────────────────────────────────────────

async function checkConnection() {
  try {
    const result = await apiGet('/api/ping');
    const wasConnected = connected;
    connected = !!(result && result.ok);
    if (connected && !wasConnected) {
      console.log('[tubestash] Host connected (pid:', result.pid, ')');
      broadcastToUI({ type: 'connection-restored' });
      // Auto-poll on first-ever connection
      browser.storage.local.get('lastPoll').then((data) => {
        if (!data.lastPoll) {
          console.log('[tubestash] First connection, triggering initial poll');
          pollFeeds();
        }
      });
    } else if (!connected && wasConnected) {
      console.warn('[tubestash] Host disconnected');
      broadcastToUI({ type: 'connection-lost' });
    }
  } catch {
    if (connected) {
      connected = false;
      broadcastToUI({ type: 'connection-lost' });
    }
  }
  // Adjust alarm interval based on connection state
  const interval = connected ? 1 : 0.5; // 60s connected, 30s disconnected
  browser.alarms.create('check-connection', { periodInMinutes: interval });
}

// ── Download Status Polling ──────────────────────────────────────────

async function pollDownloadStatus() {
  if (!connected) return;
  try {
    const downloads = await apiGet('/api/downloads');

    for (const [videoId, state] of Object.entries(downloads)) {
      if (state.status === 'downloading' || state.status === 'queued') {
        broadcastToUI({
          type: 'download-progress',
          videoId,
          percent: state.percent,
          speed: state.speed,
          eta: state.eta,
        });
      }

      if (state.status === 'done') {
        const local = activeDownloads.get(videoId);
        if (!local || local.status !== 'done') {
          activeDownloads.set(videoId, { status: 'done' });
          await onDownloadDone({
            videoId,
            filePath: state.filePath,
            thumbnailPath: state.thumbnailPath,
            fileSize: state.fileSize,
            duration: state.duration,
            description: state.description,
          });
          apiPost('/api/ack', { videoId }).catch(() => {});
        }
      }

      if (state.status === 'error') {
        const local = activeDownloads.get(videoId);
        if (!local || local.status !== 'error') {
          activeDownloads.set(videoId, { status: 'error' });
          await onDownloadError({ videoId, error: state.error });
          apiPost('/api/ack', { videoId }).catch(() => {});
        }
      }
    }

    // Clean up activeDownloads that are no longer in the host state
    for (const [videoId, local] of activeDownloads) {
      if (!downloads[videoId] && (local.status === 'done' || local.status === 'error')) {
        activeDownloads.delete(videoId);
      }
    }
  } catch (e) {
    console.error('[tubestash] Poll download status error:', e.message);
  }

  // Manage poll timer
  updatePollTimer();
}

function updatePollTimer() {
  const hasActive = activeDownloads.size > 0 || downloadQueue.length > 0;
  if (hasActive && !pollTimer) {
    pollTimer = setInterval(pollDownloadStatus, 1000);
  } else if (!hasActive && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Video Storage ────────────────────────────────────────────────────

async function getVideos() {
  const data = await browser.storage.local.get('videos');
  return data.videos || {};
}

async function saveVideos(videos) {
  await browser.storage.local.set({ videos });
}

async function getVideo(videoId) {
  const videos = await getVideos();
  return videos[videoId] || null;
}

async function upsertVideo(videoId, fields) {
  const videos = await getVideos();
  videos[videoId] = { ...videos[videoId], ...fields, id: videoId };
  await saveVideos(videos);
  return videos[videoId];
}

async function deleteVideoRecord(videoId) {
  const videos = await getVideos();
  delete videos[videoId];
  await saveVideos(videos);
}

// ── Cookie Export ────────────────────────────────────────────────────

async function getYouTubeCookies() {
  try {
    // Fetch cookies for both domain variants to ensure full coverage
    const [dotCookies, wwwCookies] = await Promise.all([
      browser.cookies.getAll({ domain: '.youtube.com' }),
      browser.cookies.getAll({ domain: 'www.youtube.com' }),
    ]);
    // Deduplicate by name+domain+path
    const seen = new Set();
    const cookies = [];
    for (const c of [...dotCookies, ...wwwCookies]) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        cookies.push(c);
      }
    }
    console.log(`[tubestash] Cookie export: found ${cookies.length} cookies (dot: ${dotCookies.length}, www: ${wwwCookies.length})`);
    if (!cookies.length) return null;

    // Netscape cookie file format (what yt-dlp expects)
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
      const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const flag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.round(c.expirationDate) : 0;
      lines.push(`${domain}\t${flag}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
    }
    return lines.join('\n') + '\n';
  } catch (e) {
    console.error('[tubestash] Failed to export cookies:', e.message);
    if (!browser.cookies) {
      console.error('[tubestash] browser.cookies API is undefined — reload the extension in about:debugging to activate the cookies permission');
    }
    return null;
  }
}

// ── Shorts Detection ─────────────────────────────────────────────────

/**
 * Check if a video is a Short by fetching the /shorts/ URL.
 * YouTube returns 200 (staying on /shorts/) for actual Shorts,
 * and redirects to /watch?v= for regular videos.
 */
async function checkIsShort(videoId) {
  try {
    const resp = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD',
      redirect: 'follow',
    });
    const isShort = resp.url.includes('/shorts/');
    console.log(`[tubestash] Shorts check ${videoId}: ${isShort} (final URL: ${resp.url})`);
    return isShort;
  } catch (e) {
    console.warn(`[tubestash] Shorts check failed for ${videoId}:`, e.message);
    return false;
  }
}

// ── Download Queue ───────────────────────────────────────────────────

async function enqueueDownload(videoInfo) {
  const existing = await getVideo(videoInfo.id);
  if (existing && (existing.status === 'done' || existing.status === 'downloading')) {
    return;
  }

  // Check if it's a Short before downloading
  const isShort = await checkIsShort(videoInfo.id);

  await upsertVideo(videoInfo.id, {
    title: videoInfo.title || videoInfo.id,
    channel_id: videoInfo.channel_id || '',
    channel_name: videoInfo.channel_name || '',
    published_at: videoInfo.published_at || null,
    is_short: isShort,
    status: 'queued',
  });

  if (!downloadQueue.some(q => q.videoId === videoInfo.id)) {
    downloadQueue.push({ videoId: videoInfo.id, published_at: videoInfo.published_at || '' });
    downloadQueue.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  }
  processQueue();
  broadcastToUI({ type: 'queue-updated' });
}

function processQueue() {
  while (activeDownloads.size < concurrency && downloadQueue.length > 0) {
    const { videoId } = downloadQueue.shift();
    activeDownloads.set(videoId, { status: 'downloading' });
    startDownload(videoId);
  }
}

async function startDownload(videoId) {
  await upsertVideo(videoId, { status: 'downloading', error_message: null });
  broadcastToUI({ type: 'download-started', videoId });

  if (!connected) {
    activeDownloads.delete(videoId);
    await upsertVideo(videoId, { status: 'error', error_message: 'Host not connected' });
    return;
  }

  const cookies = await getYouTubeCookies();
  console.log(`[tubestash] Starting download ${videoId}, cookies: ${cookies ? `${cookies.length} bytes` : 'none'}`);

  try {
    await apiPost('/api/download', { videoId, cookies });
  } catch (e) {
    activeDownloads.delete(videoId);
    await upsertVideo(videoId, { status: 'error', error_message: `API error: ${e.message}` });
    return;
  }

  // Start polling for download status
  updatePollTimer();
}

async function onDownloadDone(msg) {
  activeDownloads.delete(msg.videoId);
  await upsertVideo(msg.videoId, {
    status: 'done',
    file_path: msg.filePath,
    thumbnail_path: msg.thumbnailPath,
    file_size: msg.fileSize,
    duration: msg.duration,
    width: msg.width || null,
    height: msg.height || null,
    description: msg.description || '',
    downloaded_at: new Date().toISOString(),
    error_message: null,
  });
  console.log(`[tubestash] Download complete: ${msg.videoId}`);
  broadcastToUI({ type: 'download-complete', videoId: msg.videoId });
  processQueue();
  cleanupOldVideos();
}

async function onDownloadError(msg) {
  activeDownloads.delete(msg.videoId);
  await upsertVideo(msg.videoId, {
    status: 'error',
    error_message: msg.error,
  });
  console.error(`[tubestash] Download error ${msg.videoId}: ${msg.error}`);
  broadcastToUI({ type: 'download-error', videoId: msg.videoId, error: msg.error });
  processQueue();
}

// ── Cleanup ──────────────────────────────────────────────────────────

async function cleanupOldVideos() {
  const videos = await getVideos();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [id, v] of Object.entries(videos)) {
    if (v.watched && v.downloaded_at && new Date(v.downloaded_at).getTime() < cutoff) {
      if (v.file_path || v.thumbnail_path) {
        apiPost('/api/delete-files', { filePath: v.file_path, thumbnailPath: v.thumbnail_path }).catch(() => {});
      }
      delete videos[id];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    await saveVideos(videos);
    console.log(`[tubestash] Cleaned up ${cleaned} old watched videos`);
  }
}

// ── Subscription Discovery ───────────────────────────────────────────

async function fetchAllSubscriptions() {
  const resp = await fetch('https://www.youtube.com/feed/channels', { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  // Check if logged in
  if (html.includes('"LOGGED_IN":false') || html.includes('"loggedIn":false')) {
    throw new Error('Not logged in to YouTube');
  }

  // Extract ytInitialData
  const match = html.match(/var ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
  if (!match) throw new Error('Could not find ytInitialData');
  const data = JSON.parse(match[1]);

  // Extract INNERTUBE_API_KEY and context
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const apiKey = keyMatch ? keyMatch[1] : null;

  const ctxMatch = html.match(/"INNERTUBE_CONTEXT"\s*:\s*({.+?})\s*,\s*"/s);
  let innertubeContext = null;
  if (ctxMatch) {
    try { innertubeContext = JSON.parse(ctxMatch[1]); } catch {}
  }

  const channels = [];
  let continuationToken = null;

  // Parse channels from ytInitialData
  function extractChannels(items) {
    if (!items) return;
    for (const item of items) {
      if (item.channelRenderer) {
        const ch = item.channelRenderer;
        const id = ch.channelId;
        const name = ch.title?.simpleText || ch.title?.runs?.[0]?.text || id;
        if (id) channels.push({ id, name });
      }
      if (item.continuationItemRenderer) {
        continuationToken = item.continuationItemRenderer
          ?.continuationEndpoint?.continuationCommand?.token || null;
      }
      // Handle shelf wrapper
      if (item.shelfRenderer) {
        const shelfItems = item.shelfRenderer?.content?.expandedShelfContentsRenderer?.items;
        if (shelfItems) extractChannels(shelfItems);
      }
      if (item.itemSectionRenderer) {
        extractChannels(item.itemSectionRenderer.contents);
      }
    }
  }

  // Walk the initial data structure
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents;
    if (sections) extractChannels(sections);
  }

  // Follow continuation pages
  let iterations = 0;
  while (continuationToken && apiKey && innertubeContext && iterations < 20) {
    iterations++;
    try {
      const contResp = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: innertubeContext, continuation: continuationToken }),
        }
      );
      if (!contResp.ok) break;
      const contData = await contResp.json();

      continuationToken = null;
      const actions = contData?.onResponseReceivedActions || [];
      for (const action of actions) {
        const items = action?.appendContinuationItemsAction?.continuationItems;
        if (items) extractChannels(items);
      }
    } catch {
      break;
    }
  }

  return channels;
}

async function updateChannelsFromYouTube() {
  const syncStatus = { syncing: true, time: null, count: 0, error: null };
  await browser.storage.local.set({ syncStatus });
  broadcastToUI({ type: 'sync-status', status: syncStatus });

  try {
    const channels = await fetchAllSubscriptions();
    const settings = await getSettings();
    settings.channels = channels;
    await browser.storage.local.set({ settings });

    const result = { syncing: false, time: new Date().toISOString(), count: channels.length, error: null };
    await browser.storage.local.set({ syncStatus: result });
    broadcastToUI({ type: 'sync-status', status: result });
    console.log(`[tubestash] Synced ${channels.length} subscriptions`);
    return result;
  } catch (e) {
    console.error('[tubestash] Subscription sync error:', e);
    const result = { syncing: false, time: new Date().toISOString(), count: 0, error: e.message };
    await browser.storage.local.set({ syncStatus: result });
    broadcastToUI({ type: 'sync-status', status: result });
    return result;
  }
}

// ── RSS Polling ──────────────────────────────────────────────────────

async function getSettings() {
  const data = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

async function pollFeeds() {
  const settings = await getSettings();
  concurrency = settings.concurrency || 2;

  if (!settings.channels.length) {
    const result = { time: new Date().toISOString(), found: 0, error: 'No channels configured' };
    await browser.storage.local.set({ lastPoll: result });
    return result;
  }

  if (!connected) {
    const result = { time: new Date().toISOString(), found: 0, error: 'Host not connected' };
    await browser.storage.local.set({ lastPoll: result });
    return result;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - settings.maxAgeDays);

  let totalFound = 0;

  for (const ch of settings.channels) {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const text = await resp.text();
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const entries = doc.querySelectorAll('entry');

      for (const entry of entries) {
        const videoId = entry.querySelector('videoId')?.textContent;
        const title = entry.querySelector('title')?.textContent;
        const published = entry.querySelector('published')?.textContent;
        const channelName = entry.querySelector('author > name')?.textContent || ch.name;

        if (!videoId || !published) continue;
        if (new Date(published) < cutoff) continue;

        await enqueueDownload({
          id: videoId,
          title: title || videoId,
          channel_id: ch.id,
          channel_name: channelName,
          published_at: published,
        });
        totalFound++;
      }
    } catch (e) {
      console.error(`[tubestash] Poll error for ${ch.id}:`, e);
    }
  }

  const result = { time: new Date().toISOString(), found: totalFound, error: null };
  await browser.storage.local.set({ lastPoll: result });
  return result;
}

// ── UI Communication ─────────────────────────────────────────────────

function broadcastToUI(msg) {
  browser.runtime.sendMessage(msg).catch(() => {
    // No listeners — popup/dashboard not open
  });
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'poll-now':
      pollFeeds().then(sendResponse);
      return true;

    case 'get-settings':
      getSettings().then(sendResponse);
      return true;

    case 'get-status': {
      (async () => {
        const videos = await getVideos();
        const counts = { done: 0, pending: 0, queued: 0, downloading: 0, error: 0 };
        for (const v of Object.values(videos)) {
          if (counts[v.status] !== undefined) counts[v.status]++;
        }
        sendResponse({
          connected,
          queue_length: downloadQueue.length,
          active_downloads: activeDownloads.size,
          counts,
        });
      })();
      return true;
    }

    case 'get-connection-status':
      sendResponse({ connected });
      return true;

    case 'retry-connection':
      checkConnection().then(() => {
        sendResponse({ connected });
      });
      return true;

    case 'sync-subscriptions':
      updateChannelsFromYouTube().then(sendResponse);
      return true;

    case 'get-sync-status': {
      browser.storage.local.get('syncStatus').then((data) => {
        sendResponse(data.syncStatus || { syncing: false, time: null, count: 0, error: null });
      });
      return true;
    }

    case 'get-video':
      getVideo(msg.videoId).then(sendResponse);
      return true;

    case 'get-videos': {
      getVideos().then((videos) => sendResponse(Object.values(videos)));
      return true;
    }

    case 'enqueue-download':
      enqueueDownload(msg.video).then(() => sendResponse({ ok: true }));
      return true;

    case 'mark-watched': {
      upsertVideo(msg.videoId, { watched: msg.watched !== undefined ? msg.watched : true })
        .then(() => {
          broadcastToUI({ type: 'video-updated', videoId: msg.videoId });
          sendResponse({ ok: true });
        });
      return true;
    }

    case 'delete-video': {
      (async () => {
        const video = await getVideo(msg.videoId);
        if (video && (video.file_path || video.thumbnail_path)) {
          apiPost('/api/delete-files', { filePath: video.file_path, thumbnailPath: video.thumbnail_path }).catch(() => {});
        }
        await deleteVideoRecord(msg.videoId);
        broadcastToUI({ type: 'video-deleted', videoId: msg.videoId });
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'get-disk-usage': {
      apiGet('/api/disk-usage').then(sendResponse).catch(() => sendResponse({ totalBytes: 0 }));
      return true;
    }

    case 'clear-and-redownload': {
      (async () => {
        // Cancel all active downloads via API
        for (const [videoId] of activeDownloads) {
          apiPost('/api/cancel', { videoId }).catch(() => {});
        }
        activeDownloads.clear();
        downloadQueue.length = 0;

        // Delete all video files via API
        const videos = await getVideos();
        for (const v of Object.values(videos)) {
          if (v.file_path || v.thumbnail_path) {
            apiPost('/api/delete-files', { filePath: v.file_path, thumbnailPath: v.thumbnail_path }).catch(() => {});
          }
        }

        // Clear all video records
        await saveVideos({});
        broadcastToUI({ type: 'queue-updated' });

        // Re-poll to re-discover and re-download
        await pollFeeds();
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'cancel-download': {
      if (activeDownloads.has(msg.videoId)) {
        apiPost('/api/cancel', { videoId: msg.videoId }).catch(() => {});
        activeDownloads.delete(msg.videoId);
      }
      const idx = downloadQueue.findIndex(q => q.videoId === msg.videoId);
      if (idx !== -1) downloadQueue.splice(idx, 1);
      upsertVideo(msg.videoId, { status: 'error', error_message: 'Cancelled' })
        .then(() => sendResponse({ ok: true }));
      return true;
    }
  }
});

// ── Alarms ───────────────────────────────────────────────────────────

browser.alarms.create('poll-feeds', { periodInMinutes: 30 });
browser.alarms.create('sync-subscriptions', { delayInMinutes: 1, periodInMinutes: 24 * 60 });
browser.alarms.create('check-connection', { periodInMinutes: 0.5 });

browser.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  concurrency = settings.concurrency || 2;
  browser.alarms.create('poll-feeds', { periodInMinutes: settings.pollInterval });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll-feeds') {
    pollFeeds();
  }
  if (alarm.name === 'sync-subscriptions') {
    updateChannelsFromYouTube();
  }
  if (alarm.name === 'check-connection') {
    checkConnection();
  }
});

// ── Browser Action Click ─────────────────────────────────────────────

browser.browserAction.onClicked.addListener(() => {
  const url = browser.runtime.getURL(connected ? 'dashboard.html' : 'setup.html');
  browser.tabs.create({ url });
});

// ── Startup ──────────────────────────────────────────────────────────

(async () => {
  const settings = await getSettings();
  concurrency = settings.concurrency || 2;
  checkConnection();
  cleanupOldVideos();
  updateChannelsFromYouTube();
})();
