'use strict';

const MEDIA_BASE = 'http://127.0.0.1:8771/';

let videos = [];
const downloadProgress = new Map(); // videoId → percent

// ── SponsorBlock ──────────────────────────────────────────────────────

const SB_DEFAULTS = { sponsor: 'skip', selfpromo: 'skip', interaction: 'skip', intro: 'off', outro: 'off', preview: 'off', music_offtopic: 'off', filler: 'off' };
const SB_COLORS = {
  sponsor: '#00d400', selfpromo: '#ffff00', interaction: '#cc00ff', intro: '#00ffff',
  outro: '#0202ed', preview: '#008fd6', music_offtopic: '#ff9900', filler: '#7300FF',
};
const SB_LABELS = {
  sponsor: 'Sponsor', selfpromo: 'Self-Promotion', interaction: 'Interaction Reminder',
  intro: 'Intro', outro: 'Outro', preview: 'Preview/Recap',
  music_offtopic: 'Non-Music', filler: 'Filler',
};

const sbCache = new Map(); // videoId → segments[]
let sbSegments = [];       // current video's segments
let sbSkipped = new Set();  // segment indices already skipped
let sbMutedByUs = false;
let sbToastTimer = null;
let sbSettings = null;      // loaded on playVideo

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const channelFilter = document.getElementById('channel-filter');
const sortOrder = document.getElementById('sort-order');
const typeFilter = document.getElementById('type-filter');
const statsEl = document.getElementById('stats');

// Breadcrumb ref
const breadcrumb = document.getElementById('breadcrumb');

// Watch view refs
const watchView = document.getElementById('watch-view');
const player = document.getElementById('player');
const watchTitle = document.getElementById('watch-title');
const watchViews = document.getElementById('watch-views');
const watchDescription = document.getElementById('watch-description');
const watchDescMeta = document.getElementById('watch-desc-meta');
const watchDescBox = document.getElementById('watch-description-box');
const watchDescToggle = document.getElementById('watch-desc-toggle');
const watchChannelName = document.getElementById('watch-channel-name');
const watchChannelAvatar = document.querySelector('.channel-avatar');
const watchYtLink = document.getElementById('watch-yt-link');
const watchClose = document.getElementById('watch-close');
const sidebarList = document.getElementById('sidebar-list');

// ── URL ↔ Filter Sync ────────────────────────────────────────────────

function syncFiltersToUrl() {
  const params = new URLSearchParams();
  if (channelFilter.value) params.set('channel', channelFilter.value);
  if (sortOrder.value !== 'newest') params.set('sort', sortOrder.value);
  if (typeFilter.value !== 'videos') params.set('type', typeFilter.value);
  const qs = params.toString();
  const url = location.pathname + (qs ? '?' + qs : '');
  history.replaceState(null, '', url);
}

function readFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.has('channel')) channelFilter.value = params.get('channel');
  if (params.has('sort')) sortOrder.value = params.get('sort');
  if (params.has('type')) typeFilter.value = params.get('type');
}

// ── Data Loading ─────────────────────────────────────────────────────

async function loadVideos() {
  try {
    videos = await browser.runtime.sendMessage({ type: 'get-videos' });
  } catch {
    videos = [];
  }
  updateChannelFilter();
  // Re-apply URL filters after channel options are populated
  readFiltersFromUrl();
  render();

  // Auto-open video if ?watch= is in the URL
  const params = new URLSearchParams(location.search);
  const watchId = params.get('watch');
  if (watchId && videos.find((v) => v.id === watchId && v.status === 'done')) {
    playVideo(watchId);
  }
}

function updateChannelFilter() {
  const current = channelFilter.value;
  const channels = [...new Set(videos.map((v) => v.channel_name).filter(Boolean))].sort();
  channelFilter.innerHTML = '<option value="">All Channels</option>' +
    channels.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
  channelFilter.value = current;
}

// ── Rendering ────────────────────────────────────────────────────────

function render() {
  let filtered = [...videos];
  const ch = channelFilter.value;
  if (ch) filtered = filtered.filter((v) => v.channel_name === ch);
  const tf = typeFilter.value;
  const isShort = (v) => !!v.is_short;
  if (tf === 'videos') filtered = filtered.filter((v) => !isShort(v));
  else if (tf === 'shorts') filtered = filtered.filter((v) => isShort(v));
  // Sort
  filtered.sort((a, b) => {
    const da = a.published_at || '';
    const db = b.published_at || '';
    return sortOrder.value === 'oldest' ? da.localeCompare(db) : db.localeCompare(da);
  });

  statsEl.textContent = `${filtered.length} videos`;

  if (!filtered.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = filtered.map((v) => {
    const dur = formatDuration(v.duration);
    const date = v.published_at ? new Date(v.published_at).toLocaleDateString() : '';
    const thumbUrl = v.thumbnail_path ? mediaUrl(v.thumbnail_path) : '';
    const progress = downloadProgress.get(v.id);
    const isDownloading = v.status === 'downloading' || v.status === 'queued';

    let statusHtml = '';
    if (v.status === 'downloading' && progress !== undefined) {
      statusHtml = `<div class="card-status">Downloading ${Math.round(progress)}%</div>`;
    } else if (v.status === 'downloading') {
      statusHtml = '<div class="card-status">Downloading...</div>';
    } else if (v.status === 'queued') {
      statusHtml = '<div class="card-status">Queued</div>';
    } else if (v.status === 'error') {
      statusHtml = `<div class="card-status" style="color:#f44336">Error: ${escapeHTML(v.error_message || 'unknown')}</div>`;
    }

    let progressBar = '';
    if (v.status === 'downloading' && progress !== undefined) {
      progressBar = `<div class="progress-bar" style="width:${progress}%"></div>`;
    }

    return `<div class="card" data-id="${v.id}" data-status="${v.status}">` +
      '<div class="thumb-wrap">' +
        (thumbUrl ? `<img src="${thumbUrl}" alt="" loading="lazy">` : '') +
        (dur ? `<span class="duration-badge">${dur}</span>` : '') +
        progressBar +
      '</div>' +
      '<div class="card-info">' +
        `<div class="card-title">${escapeHTML(v.title)}</div>` +
        `<div class="card-channel">${escapeHTML(v.channel_name)}</div>` +
        `<div class="card-date">${date}</div>` +
        statusHtml +
      '</div></div>';
  }).join('');

  grid.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.dataset.status === 'done') {
        playVideo(card.dataset.id);
      }
    });
  });

  // Keep URL in sync with filters (skip when watching a video)
  if (watchView.style.display === 'none') syncFiltersToUrl();
}

// ── Player ───────────────────────────────────────────────────────────

function playVideo(id) {
  const v = videos.find((x) => x.id === id);
  if (!v) return;

  // Set player source and play
  player.src = mediaUrl(v.file_path);
  player.play().catch(() => {});

  // SponsorBlock
  sbInit(v.id);

  // Populate info
  watchTitle.textContent = v.title || '';
  const date = v.published_at ? new Date(v.published_at).toLocaleDateString() : '';
  watchViews.textContent = date;
  watchYtLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;

  // Channel row
  watchChannelName.textContent = v.channel_name || '';
  watchChannelName.onclick = () => filterToChannel(v.channel_name);
  watchChannelAvatar.textContent = (v.channel_name || '?').charAt(0).toUpperCase();

  // Description box
  watchDescMeta.textContent = [v.channel_name, date].filter(Boolean).join(' · ');
  watchDescription.innerHTML = linkifyDescription(v.description || '');
  watchDescBox.classList.remove('expanded');
  watchDescToggle.textContent = 'Show more';

  // Render sidebar
  renderSidebar(id);

  // Update breadcrumb
  breadcrumb.innerHTML =
    '<a class="breadcrumb-link" id="breadcrumb-back">TubeStash</a>' +
    '<span class="sep">›</span>' +
    `<a class="breadcrumb-link" id="breadcrumb-channel">${escapeHTML(v.channel_name || '')}</a>` +
    '<span class="sep">›</span>' +
    `<span class="current">${escapeHTML(v.title || '')}</span>`;
  document.getElementById('breadcrumb-back').addEventListener('click', closePlayer);
  document.getElementById('breadcrumb-channel').addEventListener('click', () => filterToChannel(v.channel_name));

  // Show watch view, hide grid + filters
  watchView.style.display = 'flex';
  grid.style.display = 'none';
  empty.style.display = 'none';
  document.querySelector('.controls').style.display = 'none';

  // Push history state so back button returns to dashboard
  const params = new URLSearchParams(location.search);
  params.set('watch', id);
  history.pushState({ video: id }, '', location.pathname + '?' + params.toString());
}

function renderSidebar(currentId) {
  let filtered = videos.filter((v) => v.status === 'done' && v.id !== currentId);
  const ch = channelFilter.value;
  if (ch) filtered = filtered.filter((v) => v.channel_name === ch);
  const tf = typeFilter.value;
  const isShort = (v) => !!v.is_short;
  if (tf === 'videos') filtered = filtered.filter((v) => !isShort(v));
  else if (tf === 'shorts') filtered = filtered.filter((v) => isShort(v));
  filtered.sort((a, b) => {
    const da = a.published_at || '';
    const db = b.published_at || '';
    return sortOrder.value === 'oldest' ? da.localeCompare(db) : db.localeCompare(da);
  });

  sidebarList.innerHTML = filtered.map((v) => {
    const thumbUrl = v.thumbnail_path ? mediaUrl(v.thumbnail_path) : '';
    const dur = formatDuration(v.duration);
    return `<div class="sidebar-card" data-id="${v.id}">` +
      (thumbUrl ? `<img src="${thumbUrl}" alt="" loading="lazy">` : '<div style="width:168px;height:94px;background:#272727;border-radius:4px;flex-shrink:0"></div>') +
      '<div class="sidebar-card-info">' +
        `<div class="sidebar-card-title">${escapeHTML(v.title)}</div>` +
        `<div class="sidebar-card-channel">${escapeHTML(v.channel_name)}</div>` +
        (dur ? `<div class="sidebar-card-duration">${dur}</div>` : '') +
      '</div></div>';
  }).join('');

  sidebarList.querySelectorAll('.sidebar-card').forEach((card) => {
    card.addEventListener('click', () => playVideo(card.dataset.id));
  });
}

// ── SponsorBlock helpers ──────────────────────────────────────────────

const playerWrap = document.getElementById('player-wrap');
const seekBar = document.getElementById('seek-bar');
const seekBuffered = document.getElementById('seek-buffered');
const seekProgress = document.getElementById('seek-progress');
const seekThumb = document.getElementById('seek-thumb');
const ctrlPlay = document.getElementById('ctrl-play');
const ctrlTime = document.getElementById('ctrl-time');
const ctrlVolBtn = document.getElementById('ctrl-vol-btn');
const ctrlVolSlider = document.getElementById('ctrl-vol-slider');
const ctrlFullscreen = document.getElementById('ctrl-fullscreen');

// ── Custom Controls ───────────────────────────────────────────────────

let controlsHideTimer = null;

function showControls() {
  playerWrap.classList.add('controls-visible');
  clearTimeout(controlsHideTimer);
  if (!player.paused) {
    controlsHideTimer = setTimeout(() => playerWrap.classList.remove('controls-visible'), 3000);
  }
}

playerWrap.addEventListener('mousemove', showControls);
playerWrap.addEventListener('mouseleave', () => {
  clearTimeout(controlsHideTimer);
  if (!player.paused) playerWrap.classList.remove('controls-visible');
});

// Play / Pause
function togglePlayPause() { player.paused ? player.play().catch(() => {}) : player.pause(); }
ctrlPlay.addEventListener('click', togglePlayPause);
player.addEventListener('click', togglePlayPause);
player.addEventListener('play', () => {
  ctrlPlay.querySelector('.icon-play').style.display = 'none';
  ctrlPlay.querySelector('.icon-pause').style.display = '';
  showControls();
});
player.addEventListener('pause', () => {
  ctrlPlay.querySelector('.icon-play').style.display = '';
  ctrlPlay.querySelector('.icon-pause').style.display = 'none';
  playerWrap.classList.add('controls-visible');
  clearTimeout(controlsHideTimer);
});

// Time display + seek progress
function updateTimeDisplay() {
  const cur = player.currentTime || 0;
  const dur = player.duration || 0;
  ctrlTime.textContent = formatDuration(Math.floor(cur)) + ' / ' + formatDuration(Math.floor(dur));
  if (dur) {
    const pct = (cur / dur) * 100;
    seekProgress.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
  }
}
player.addEventListener('timeupdate', updateTimeDisplay);

player.addEventListener('progress', () => {
  if (player.buffered.length && player.duration) {
    const end = player.buffered.end(player.buffered.length - 1);
    seekBuffered.style.width = (end / player.duration) * 100 + '%';
  }
});

// Seek bar interaction
let isSeeking = false;
function seekFromEvent(e) {
  const rect = seekBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (player.duration) player.currentTime = pct * player.duration;
  updateTimeDisplay();
}
seekBar.addEventListener('mousedown', (e) => {
  isSeeking = true;
  seekBar.classList.add('dragging');
  seekFromEvent(e);
  const onMove = (e2) => seekFromEvent(e2);
  const onUp = () => { isSeeking = false; seekBar.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// Volume
ctrlVolSlider.addEventListener('input', () => {
  player.volume = parseFloat(ctrlVolSlider.value);
  player.muted = false;
});
ctrlVolBtn.addEventListener('click', () => { player.muted = !player.muted; });
player.addEventListener('volumechange', () => {
  const muted = player.muted || player.volume === 0;
  ctrlVolBtn.querySelector('.icon-vol-high').style.display = muted ? 'none' : '';
  ctrlVolBtn.querySelector('.icon-vol-mute').style.display = muted ? '' : 'none';
  if (!player.muted) ctrlVolSlider.value = player.volume;
});

// Fullscreen
ctrlFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else playerWrap.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  ctrlFullscreen.querySelector('.icon-fs-enter').style.display = fs ? 'none' : '';
  ctrlFullscreen.querySelector('.icon-fs-exit').style.display = fs ? '' : 'none';
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (watchView.style.display === 'none') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
      showControls();
      break;
    case 'ArrowRight':
      e.preventDefault();
      player.currentTime = Math.min(player.duration || 0, player.currentTime + 5);
      showControls();
      break;
    case 'ArrowUp':
      e.preventDefault();
      player.volume = Math.min(1, player.volume + 0.05);
      ctrlVolSlider.value = player.volume;
      showControls();
      break;
    case 'ArrowDown':
      e.preventDefault();
      player.volume = Math.max(0, player.volume - 0.05);
      ctrlVolSlider.value = player.volume;
      showControls();
      break;
    case 'm':
      player.muted = !player.muted;
      showControls();
      break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else playerWrap.requestFullscreen().catch(() => {});
      break;
  }
});

async function loadSbSettings() {
  const data = await browser.storage.local.get('settings');
  sbSettings = (data.settings || {}).sponsorBlock || SB_DEFAULTS;
}

async function fetchSponsorSegments(videoId) {
  if (sbCache.has(videoId)) return sbCache.get(videoId);
  await loadSbSettings();

  const categories = Object.entries(sbSettings)
    .filter(([, action]) => action !== 'off')
    .map(([cat]) => cat);
  if (!categories.length) {
    console.log('[SB] all categories off');
    sbCache.set(videoId, []);
    return [];
  }

  const url = 'https://sponsor.ajay.app/api/skipSegments?videoID=' +
    encodeURIComponent(videoId) +
    '&categories=' + encodeURIComponent(JSON.stringify(categories));
  try {
    console.log('[SB] fetching', url);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log('[SB] API returned', resp.status, 'for', videoId);
      sbCache.set(videoId, []);
      return [];
    }
    const data = await resp.json();
    console.log('[SB] got', data.length, 'segments for', videoId);
    sbCache.set(videoId, data);
    return data;
  } catch (err) {
    console.error('[SB] fetch error:', err);
    sbCache.set(videoId, []);
    return [];
  }
}

function sbRenderBar() {
  seekBar.querySelectorAll('.sb-segment').forEach(el => el.remove());
  if (!sbSegments.length || !player.duration) return;
  for (const seg of sbSegments) {
    const [start, end] = seg.segment;
    const el = document.createElement('div');
    el.className = 'sb-segment';
    el.style.left = (start / player.duration) * 100 + '%';
    el.style.width = ((end - start) / player.duration) * 100 + '%';
    el.style.background = SB_COLORS[seg.category] || '#888';
    seekBar.appendChild(el);
  }
}

function sbShowToast(category, startTime) {
  sbDismissToast();
  const toast = document.createElement('div');
  toast.className = 'sb-toast';
  toast.textContent = 'Skipped: ' + (SB_LABELS[category] || category);
  const btn = document.createElement('button');
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => {
    player.currentTime = startTime;
    sbDismissToast();
  });
  toast.appendChild(btn);
  playerWrap.appendChild(toast);
  sbToastTimer = setTimeout(sbDismissToast, 3000);
}

function sbDismissToast() {
  clearTimeout(sbToastTimer);
  const t = playerWrap.querySelector('.sb-toast');
  if (t) t.remove();
}

function sbOnTimeUpdate() {
  if (!sbSegments.length || !sbSettings) return;
  const t = player.currentTime;

  for (let i = 0; i < sbSegments.length; i++) {
    const seg = sbSegments[i];
    const [start, end] = seg.segment;
    const action = sbSettings[seg.category] || 'off';
    if (t < start || t >= end) continue;

    if (action === 'skip' && !sbSkipped.has(i)) {
      sbSkipped.add(i);
      player.currentTime = end;
      sbShowToast(seg.category, start);
      return;
    }
    if (action === 'mute' && !player.muted) {
      player.muted = true;
      sbMutedByUs = true;
    }
  }

  // Unmute if we muted and we're no longer in any mute segment
  if (sbMutedByUs) {
    const inMute = sbSegments.some((seg) => {
      const [start, end] = seg.segment;
      return (sbSettings[seg.category] === 'mute') && t >= start && t < end;
    });
    if (!inMute) {
      player.muted = false;
      sbMutedByUs = false;
    }
  }
}

async function sbInit(videoId) {
  sbSegments = [];
  sbSkipped = new Set();
  sbDismissToast();
  if (sbMutedByUs) { player.muted = false; sbMutedByUs = false; }
  seekBar.querySelectorAll('.sb-segment').forEach(el => el.remove());

  player.removeEventListener('timeupdate', sbOnTimeUpdate);

  const segments = await fetchSponsorSegments(videoId);
  sbSegments = segments;
  if (segments.length) {
    player.addEventListener('timeupdate', sbOnTimeUpdate);
    if (player.duration) {
      sbRenderBar();
    } else {
      player.addEventListener('loadedmetadata', sbRenderBar, { once: true });
    }
  }
}

function sbCleanup() {
  player.removeEventListener('timeupdate', sbOnTimeUpdate);
  sbSegments = [];
  sbSkipped = new Set();
  sbDismissToast();
  if (sbMutedByUs) { player.muted = false; sbMutedByUs = false; }
  seekBar.querySelectorAll('.sb-segment').forEach(el => el.remove());
}

function closePlayer() {
  sbCleanup();
  player.pause();
  player.removeAttribute('src');
  player.load();
  playerWrap.classList.remove('controls-visible');
  clearTimeout(controlsHideTimer);
  seekProgress.style.width = '0%';
  seekThumb.style.left = '0%';
  seekBuffered.style.width = '0%';
  ctrlTime.textContent = '0:00 / 0:00';
  ctrlPlay.querySelector('.icon-play').style.display = '';
  ctrlPlay.querySelector('.icon-pause').style.display = 'none';
  watchView.style.display = 'none';
  grid.style.display = '';
  document.querySelector('.controls').style.display = '';
  breadcrumb.innerHTML = '<span class="breadcrumb-title">TubeStash</span>';
  render();
}

function filterToChannel(channelName) {
  closePlayer();
  channelFilter.value = channelName;
  render();
}

// Description expand/collapse
watchDescBox.addEventListener('click', () => {
  if (!watchDescBox.classList.contains('expanded')) {
    watchDescBox.classList.add('expanded');
    watchDescToggle.textContent = 'Show less';
  }
});
watchDescToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  watchDescBox.classList.remove('expanded');
  watchDescToggle.textContent = 'Show more';
});

watchClose.addEventListener('click', () => {
  closePlayer();
});

// Back button support
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  if (params.has('watch')) {
    playVideo(params.get('watch'));
  } else {
    if (watchView.style.display !== 'none') {
      closePlayer();
    }
    readFiltersFromUrl();
    render();
  }
});

channelFilter.addEventListener('change', render);
sortOrder.addEventListener('change', render);
typeFilter.addEventListener('change', render);

// ── Live Updates ─────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'download-progress':
      downloadProgress.set(msg.videoId, msg.percent);
      // Update progress bar in-place without full re-render
      const card = grid.querySelector(`.card[data-id="${msg.videoId}"]`);
      if (card) {
        let bar = card.querySelector('.progress-bar');
        if (!bar) {
          bar = document.createElement('div');
          bar.className = 'progress-bar';
          card.querySelector('.thumb-wrap').appendChild(bar);
        }
        bar.style.width = msg.percent + '%';
        const statusEl = card.querySelector('.card-status');
        if (statusEl) statusEl.textContent = `Downloading ${Math.round(msg.percent)}%`;
      }
      break;

    case 'download-complete':
    case 'download-error':
    case 'download-started':
    case 'queue-updated':
    case 'video-updated':
    case 'video-deleted':
      downloadProgress.delete(msg.videoId);
      loadVideos();
      break;

    case 'connection-lost':
      showBanner(true);
      break;

    case 'connection-restored':
      showBanner(false);
      break;
  }
});

// Also listen for storage changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.videos) {
    loadVideos();
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function mediaUrl(filePath) {
  // filePath is like "videos/channels/Name/id.mp4" or "videos/thumbnails/id.jpg"
  // The static server serves from the videos/ directory, so strip the "videos/" prefix
  const stripped = filePath.replace(/^videos\//, '');
  return MEDIA_BASE + encodeURI(stripped);
}

function formatDuration(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return m + ':' + String(sec).padStart(2, '0');
}

function escapeHTML(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

function linkifyDescription(text) {
  const escaped = escapeHTML(text);
  return escaped.replace(
    /(?:https?:\/\/|www\.)[^\s<]+/g,
    url => {
      const href = url.startsWith('www.') ? 'https://' + url : url;
      return `<a href="${href}" class="desc-link" target="_blank" rel="noopener noreferrer">${url}</a>`;
    }
  );
}

// ── Sync Now ─────────────────────────────────────────────────────────

const btnPoll = document.getElementById('btn-poll');
btnPoll.addEventListener('click', async () => {
  btnPoll.disabled = true;
  btnPoll.textContent = 'Syncing...';
  try {
    await browser.runtime.sendMessage({ type: 'poll-now' });
  } catch {}
  btnPoll.disabled = false;
  btnPoll.textContent = 'Sync Now';
  loadVideos();
});

// ── Connection Banner ────────────────────────────────────────────────

const disconnectBanner = document.getElementById('disconnect-banner');
const bannerRetry = document.getElementById('banner-retry');

function showBanner(show) {
  disconnectBanner.style.display = show ? 'flex' : 'none';
}

(async () => {
  try {
    const result = await browser.runtime.sendMessage({ type: 'get-connection-status' });
    showBanner(!result.connected);
  } catch {
    showBanner(true);
  }
})();

bannerRetry.addEventListener('click', async () => {
  bannerRetry.disabled = true;
  bannerRetry.textContent = 'Syncing...';
  try {
    const result = await browser.runtime.sendMessage({ type: 'retry-connection' });
    showBanner(!result.connected);
  } catch {
    showBanner(true);
  }
  bannerRetry.disabled = false;
  bannerRetry.textContent = 'Retry';
});

// ── Init ─────────────────────────────────────────────────────────────

loadVideos();

// Auto-poll on first ever dashboard visit
(async () => {
  try {
    const data = await browser.storage.local.get('lastPoll');
    if (!data.lastPoll) {
      btnPoll.disabled = true;
      btnPoll.textContent = 'Syncing...';
      await browser.runtime.sendMessage({ type: 'poll-now' });
      btnPoll.disabled = false;
      btnPoll.textContent = 'Sync Now';
      loadVideos();
    }
  } catch {}
})();
