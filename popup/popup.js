'use strict';

const api = globalThis.browser || globalThis.chrome;
const DR = globalThis.DownloadSorter;
const MAX_SHOWN = 6;

const els = {
  enabled: document.getElementById('enabled'),
  summary: document.getElementById('summary'),
  recent: document.getElementById('recent'),
  empty: document.getElementById('empty'),
  settings: document.getElementById('open-settings'),
  folder: document.getElementById('open-folder')
};

let settings = DR.defaultSettings();

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function renderSummary(stats) {
  const s = els.summary;
  s.textContent = '';
  s.classList.toggle('paused', !settings.enabled);
  if (!settings.enabled) {
    s.textContent = 'Paused. New downloads stay in your Downloads folder.';
    return;
  }
  const n = stats && stats.sorted ? stats.sorted : 0;
  const strong = document.createElement('strong');
  strong.textContent = n.toLocaleString();
  s.append(strong, document.createTextNode(n === 1 ? ' download sorted so far' : ' downloads sorted so far'));
}

function renderLog(log) {
  els.recent.textContent = '';
  const items = (Array.isArray(log) ? log : []).slice(0, MAX_SHOWN);
  els.empty.hidden = items.length > 0;
  items.forEach((entry) => {
    const li = document.createElement('li');
    const sorted = entry.status === 'sorted';
    const box = document.createElement(sorted ? 'button' : 'div');
    box.className = 'entry' + (sorted ? '' : ' left');
    if (sorted) {
      box.type = 'button';
      box.title = 'Show in folder';
      box.addEventListener('click', () => showFile(entry.downloadId));
    }

    const name = document.createElement('span');
    name.className = 'entry-name';
    name.textContent = entry.file || 'Download';

    const route = document.createElement('span');
    route.className = 'entry-route';
    const where = document.createElement('span');
    where.className = 'where';
    if (sorted) {
      const code = document.createElement('code');
      code.textContent = entry.folder;
      where.append(document.createTextNode('In '), code);
    } else {
      where.textContent = entry.note || 'Stayed in Downloads';
    }
    const time = document.createElement('time');
    time.dateTime = new Date(entry.time).toISOString();
    time.textContent = timeAgo(entry.time);
    route.append(where, time);

    box.append(name, route);
    li.append(box);
    els.recent.append(li);
  });
}

async function showFile(id) {
  try {
    const [item] = await api.downloads.search({ id });
    if (item && item.exists !== false && item.state === 'complete') {
      await api.downloads.show(id);
    } else {
      await api.downloads.showDefaultFolder();
    }
  } catch (err) {
    await api.downloads.showDefaultFolder();
  }
}

async function load() {
  const data = await api.storage.local.get(['settings', 'log', 'stats']);
  settings = DR.normalizeSettings(data.settings);
  els.enabled.checked = settings.enabled;
  renderSummary(data.stats);
  renderLog(data.log);
}

els.enabled.addEventListener('change', async () => {
  settings.enabled = els.enabled.checked;
  await api.storage.local.set({ settings });
  const { stats } = await api.storage.local.get('stats');
  renderSummary(stats);
});

els.settings.addEventListener('click', () => {
  api.runtime.openOptionsPage();
  window.close();
});

els.folder.addEventListener('click', () => {
  api.downloads.showDefaultFolder();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.log || changes.stats || changes.settings)) load();
});

load();
