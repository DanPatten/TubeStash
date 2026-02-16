'use strict';

const MEDIA_BASE = 'http://127.0.0.1:8771/';
let currentSwapId = null;
let watchTimer = null;

function getVideoIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('v') || null;
}

function mediaUrl(filePath) {
  const stripped = filePath.replace(/^videos\//, '');
  return MEDIA_BASE + encodeURI(stripped);
}

async function trySwap() {
  const videoId = getVideoIdFromUrl();
  if (!videoId) return;
  if (videoId === currentSwapId) return;

  let video;
  try {
    video = await browser.runtime.sendMessage({ type: 'get-video', videoId });
  } catch {
    return;
  }

  if (!video || video.status !== 'done' || !video.file_path) {
    // Not available locally — let YouTube play normally
    currentSwapId = null;
    removeBadge();
    return;
  }

  currentSwapId = videoId;
  swapPlayer(video);
}

function swapPlayer(video) {
  // Wait for YouTube's video element to appear
  const ytVideo = document.querySelector('video.html5-main-video');
  if (ytVideo) {
    doSwap(ytVideo, video);
    return;
  }

  // Poll for it (YouTube SPA may not have rendered yet)
  let attempts = 0;
  const interval = setInterval(() => {
    const el = document.querySelector('video.html5-main-video');
    if (el) {
      clearInterval(interval);
      doSwap(el, video);
    } else if (++attempts > 50) {
      clearInterval(interval);
    }
  }, 200);
}

function doSwap(ytVideo, video) {
  // Pause YouTube's video
  ytVideo.pause();
  ytVideo.removeAttribute('src');
  ytVideo.load();

  // Set our local source
  ytVideo.src = mediaUrl(video.file_path);
  ytVideo.load();
  ytVideo.play().catch(() => {});

  // Add badge
  addBadge();

  // Watch timer
  clearTimeout(watchTimer);
  if (!video.watched) {
    watchTimer = setTimeout(() => {
      browser.runtime.sendMessage({ type: 'mark-watched', videoId: video.id }).catch(() => {});
    }, 10000);
  }
}

function addBadge() {
  removeBadge();
  const container = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  if (!container) return;

  const badge = document.createElement('div');
  badge.id = 'tubestash-local-badge';
  badge.textContent = 'Playing locally';
  container.appendChild(badge);
}

function removeBadge() {
  const existing = document.getElementById('tubestash-local-badge');
  if (existing) existing.remove();
}

// Reset state when navigating away from a swapped video
function resetIfNeeded() {
  const videoId = getVideoIdFromUrl();
  if (videoId !== currentSwapId) {
    currentSwapId = null;
    clearTimeout(watchTimer);
    removeBadge();
  }
}

// ── SPA Navigation Handling ───────────────────────────────────────────

// YouTube fires this custom event on client-side navigation
document.addEventListener('yt-navigate-finish', () => {
  resetIfNeeded();
  trySwap();
});

// Fallback for popstate
window.addEventListener('popstate', () => {
  resetIfNeeded();
  setTimeout(trySwap, 500);
});

// Initial load
trySwap();
