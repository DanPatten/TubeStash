const pollIntervalInput = document.getElementById('poll-interval');
const maxAgeInput = document.getElementById('max-age');
const concurrencyInput = document.getElementById('concurrency');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');
const syncInfoEl = document.getElementById('sync-info');
const channelListEl = document.getElementById('channel-list');
const syncBtn = document.getElementById('sync-btn');

const SB_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic', 'filler'];
const SB_DEFAULTS = { sponsor: 'skip', selfpromo: 'skip', interaction: 'skip', intro: 'off', outro: 'off', preview: 'off', music_offtopic: 'off', filler: 'off' };

async function load() {
  const data = await browser.storage.local.get('settings');
  const s = data.settings || {};
  pollIntervalInput.value = s.pollInterval || 30;
  maxAgeInput.value = s.maxAgeDays || 7;
  concurrencyInput.value = s.concurrency || 2;
  loadChannels(s.channels || []);
  loadSyncStatus();

  const sb = s.sponsorBlock || SB_DEFAULTS;
  for (const cat of SB_CATEGORIES) {
    const el = document.getElementById('sb-' + cat);
    if (el) el.value = sb[cat] || SB_DEFAULTS[cat];
  }
}

function loadChannels(channels) {
  channelListEl.innerHTML = '';
  for (const ch of channels) {
    const div = document.createElement('div');
    div.className = 'channel-item';
    div.innerHTML = `<span class="ch-name">${escapeHtml(ch.name)}</span><span class="ch-id">${escapeHtml(ch.id)}</span>`;
    channelListEl.appendChild(div);
  }
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

async function loadSyncStatus() {
  const status = await browser.runtime.sendMessage({ type: 'get-sync-status' });
  if (status.syncing) {
    syncInfoEl.textContent = 'Syncing...';
    syncInfoEl.className = 'sync-info';
  } else if (status.error) {
    syncInfoEl.textContent = `Sync error: ${status.error}`;
    syncInfoEl.className = 'sync-info error';
  } else if (status.time) {
    const time = new Date(status.time).toLocaleString();
    syncInfoEl.textContent = `${status.count} channels — last synced ${time}`;
    syncInfoEl.className = 'sync-info';
  } else {
    syncInfoEl.textContent = 'Not synced yet';
    syncInfoEl.className = 'sync-info';
  }
}

saveBtn.addEventListener('click', async () => {
  const data = await browser.storage.local.get('settings');
  const existing = data.settings || {};
  const sponsorBlock = {};
  for (const cat of SB_CATEGORIES) {
    const el = document.getElementById('sb-' + cat);
    sponsorBlock[cat] = el ? el.value : SB_DEFAULTS[cat];
  }

  const settings = {
    ...existing,
    pollInterval: Math.max(5, parseInt(pollIntervalInput.value) || 30),
    maxAgeDays: Math.max(1, parseInt(maxAgeInput.value) || 7),
    concurrency: Math.min(4, Math.max(1, parseInt(concurrencyInput.value) || 2)),
    sponsorBlock,
  };

  await browser.storage.local.set({ settings });
  browser.alarms.create('poll-feeds', { periodInMinutes: settings.pollInterval });

  statusEl.textContent = 'Saved!';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing...';
  syncInfoEl.textContent = 'Syncing subscriptions from YouTube...';
  syncInfoEl.className = 'sync-info';

  try {
    const result = await browser.runtime.sendMessage({ type: 'sync-subscriptions' });
    if (result.error) {
      syncInfoEl.textContent = `Sync error: ${result.error}`;
      syncInfoEl.className = 'sync-info error';
    } else {
      syncInfoEl.textContent = `${result.count} channels — just synced`;
      syncInfoEl.className = 'sync-info';
      // Reload channels
      const data = await browser.storage.local.get('settings');
      loadChannels((data.settings || {}).channels || []);
    }
  } catch (e) {
    syncInfoEl.textContent = 'Sync failed';
    syncInfoEl.className = 'sync-info error';
  }

  syncBtn.disabled = false;
  syncBtn.textContent = 'Sync Now';
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'sync-status') {
    loadSyncStatus();
    if (!msg.status.syncing) {
      browser.storage.local.get('settings').then((data) => {
        loadChannels((data.settings || {}).channels || []);
      });
    }
  }
});

const btnClear = document.getElementById('btn-clear');
btnClear.addEventListener('click', async () => {
  if (!confirm('This will delete all downloaded videos and re-download everything. Continue?')) return;
  btnClear.disabled = true;
  btnClear.textContent = 'Clearing...';
  try {
    await browser.runtime.sendMessage({ type: 'clear-and-redownload' });
  } catch {}
  btnClear.disabled = false;
  btnClear.textContent = 'Clear & Re-download';
});

load();
