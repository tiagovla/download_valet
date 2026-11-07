/*
 * Download Valet — background script.
 *
 * Chrome (service worker): downloads.onDeterminingFilename lets us choose the
 * path before the file is written. Nothing is downloaded twice.
 *
 * Firefox (event page): there is no onDeterminingFilename. We start a second
 * download of the same URL into the target subfolder, wait until it has
 * completed with the expected MIME type and size, and only then cancel and
 * remove the original. If the site refuses the second request (one-time
 * links, form posts, expired tokens), the original download is left alone.
 */
'use strict';

if (typeof importScripts === 'function' && typeof window === 'undefined') {
  importScripts('shared/rules.js'); // Chrome service worker; Firefox loads it via manifest.
}

const api = globalThis.browser || globalThis.chrome;
const DR = globalThis.DownloadSorter;
const CHROME_MODE = !!(api.downloads && api.downloads.onDeterminingFilename);
const LOG_LIMIT = 30;

// ---------------------------------------------------------------------------
// Settings and activity log
// ---------------------------------------------------------------------------

async function loadSettings() {
  const { settings } = await api.storage.local.get('settings');
  return DR.normalizeSettings(settings);
}

let logChain = Promise.resolve();

/** Appends to the activity log. Writes are serialized so parallel downloads don't overwrite each other. */
function recordEvent(entry) {
  logChain = logChain
    .then(async () => {
      const data = await api.storage.local.get(['log', 'stats']);
      const log = Array.isArray(data.log) ? data.log : [];
      const stats = data.stats && typeof data.stats.sorted === 'number' ? data.stats : { sorted: 0, since: Date.now() };
      log.unshift(Object.assign({ time: Date.now() }, entry));
      if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
      if (entry.status === 'sorted') stats.sorted += 1;
      await api.storage.local.set({ log, stats });
    })
    .catch((err) => console.warn('Download Valet: could not write activity log', err));
  return logChain;
}

function skipEntry(name, decision) {
  if (decision.reason === 'no-match') {
    return {
      file: name,
      status: 'left',
      note: decision.ext ? 'No rule for .' + decision.ext : 'No file extension'
    };
  }
  return null;
}

async function refreshBadge() {
  try {
    const settings = await loadSettings();
    await api.action.setBadgeBackgroundColor({ color: '#5B6472' });
    await api.action.setBadgeText({ text: settings.enabled ? '' : 'off' });
    await api.action.setTitle({
      title: settings.enabled ? 'Download Valet: sorting downloads' : 'Download Valet: paused'
    });
  } catch (err) {
    console.warn('Download Valet: badge update failed', err);
  }
}

function isOtherExtension(item) {
  return !!item.byExtensionId && item.byExtensionId !== api.runtime.id;
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isInDownloadsRoot(path) {
  const parts = normalizePath(path).split('/').filter(Boolean);
  return parts.length >= 2 && parts[parts.length - 2].toLowerCase() === 'downloads';
}

// ---------------------------------------------------------------------------
// Chrome, Edge, Brave, Opera: choose the path before the file is written
// ---------------------------------------------------------------------------

async function decideForChrome(item) {
  if (!isInDownloadsRoot(item.filename)) return null;
  const settings = await loadSettings();
  if (!settings.enabled) return null;
  if (isOtherExtension(item) && !settings.includeExtensionDownloads) return null;

  const name = DR.baseName(item.filename);
  const decision = DR.decide(settings, { filename: name, mime: item.mime });
  if (decision.action !== 'route') {
    const entry = skipEntry(name, decision);
    if (entry) recordEvent(Object.assign(entry, { downloadId: item.id }));
    return null;
  }
  recordEvent({
    file: name,
    folder: decision.folder,
    rule: decision.ruleName,
    status: 'sorted',
    downloadId: item.id
  });
  return { filename: decision.path, conflictAction: settings.conflictAction };
}

if (CHROME_MODE) {
  // Must be registered synchronously at the top level of the service worker.
  api.downloads.onDeterminingFilename.addListener((item, suggest) => {
    let answered = false;
    const answer = (suggestion) => {
      if (answered) return;
      answered = true;
      try {
        if (suggestion) suggest(suggestion);
        else suggest();
      } catch (err) {
        console.warn('Download Valet: suggest failed', err);
      }
    };
    // Never leave a download waiting on us.
    const guard = setTimeout(() => answer(null), 5000);
    decideForChrome(item)
      .then(answer, (err) => {
        console.error('Download Valet: routing failed', err);
        answer(null);
      })
      .finally(() => clearTimeout(guard));
    return true; // we answer asynchronously
  });
}

// ---------------------------------------------------------------------------
// Firefox: re-request into the subfolder, then remove the original
// ---------------------------------------------------------------------------

const ROUTABLE_URL = /^https?:/i;
const PENDING_PREFIX = 'routing:';
let settleChain = Promise.resolve();

async function getDownload(id) {
  const [item] = await api.downloads.search({ id });
  return item || null;
}

async function quietly(fn) {
  try {
    return await fn();
  } catch (err) {
    return undefined;
  }
}

/** Cancels or deletes a download and removes it from the downloads list. */
async function discardDownload(id) {
  const item = await getDownload(id);
  if (!item) return;
  if (item.state === 'in_progress') {
    await api.downloads.cancel(id);
  } else if (item.state === 'complete' && item.exists !== false) {
    await api.downloads.removeFile(id);
  }
  await api.downloads.erase({ id });
}

function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** Guards against a site answering the second request with something else (an error page, a login form). */
function looksLikeSameFile(original, copy) {
  if (original.totalBytes > 0 && copy.totalBytes > 0 && original.totalBytes !== copy.totalBytes) return false;
  const a = baseMime(original.mime);
  const b = baseMime(copy.mime);
  const generic = (m) => !m || m === 'application/octet-stream' || m === 'binary/octet-stream';
  if (!generic(a) && !generic(b) && a !== b) return false;
  // Progress counters can lag behind completion in Firefox; compare final on-disk sizes instead.
  if (original.state === 'complete' && copy.state === 'complete' && original.fileSize >= 0 && copy.fileSize >= 0 && original.fileSize !== copy.fileSize) return false;
  return true;
}

async function startCopy(original, path, settings) {
  const base = {
    url: original.url,
    filename: path,
    conflictAction: settings.conflictAction,
    saveAs: false
  };
  const withReferrer = ROUTABLE_URL.test(original.referrer || '')
    ? Object.assign({}, base, { headers: [{ name: 'Referer', value: original.referrer }] })
    : null;
  return api.downloads.download(withReferrer || base);
}

/**
 * Waits for the copy to prove itself, then removes the original.
 * Pending routes survive event-page suspension in session storage.
 */
async function settle(copyId) {
  const key = PENDING_PREFIX + copyId;
  const stored = await api.storage.session.get(key);
  const pending = stored[key];
  if (!pending) return;
  const copy = await getDownload(copyId);
  if (copy && copy.state === 'in_progress' && !copy.error) return;
  const original = await getDownload(pending.original.id);
  let outcome = 'copy-missing';
  if (copy) {
    if (copy.state === 'interrupted' || copy.error) {
      outcome = 'copy-failed';
      await discardDownload(copyId);
    } else if (!looksLikeSameFile(original || pending.original, copy)) {
      outcome = 'copy-different';
      await discardDownload(copyId);
    } else {
      await discardDownload(pending.original.id);
      outcome = 'moved';
    }
  }
  await api.storage.session.remove(key);
  if (outcome === 'moved') {
    await recordEvent({ file: pending.name, folder: pending.decision.folder, rule: pending.decision.ruleName, status: 'sorted', downloadId: copyId });
  } else {
    await recordEvent({ file: pending.name, status: 'left', note: KEPT_NOTES[outcome], downloadId: pending.original.id });
  }
}

function scheduleSettle(id) {
  settleChain = settleChain.catch(err => console.warn('Download Valet: cleanup failed; original retained', err))
    .then(() => settle(id));
  return settleChain;
}

const KEPT_NOTES = {
  'copy-failed': 'The site refused a second request, so it stayed in Downloads',
  'copy-different': 'The site sent a different file the second time, so it stayed in Downloads',
  'copy-missing': 'Kept in Downloads'
};

async function routeInFirefox(item, silentOriginal = false) {
  if (item.byExtensionId === api.runtime.id && !silentOriginal) return; // our own copy
  if (!isInDownloadsRoot(item.filename)) return;
  // Keep private filenames out of local history and never replay a container in the default cookie context.
  if (item.incognito || (item.cookieStoreId && item.cookieStoreId !== 'firefox-default')) return;
  const settings = await loadSettings();
  if (!settings.enabled) return;
  if (isOtherExtension(item) && !settings.includeExtensionDownloads) return;
  if (item.state !== 'in_progress' && item.state !== 'complete') return;

  const name = DR.baseName(item.filename);
  const decision = DR.decide(settings, { filename: name, mime: item.mime });
  if (decision.action !== 'route') {
    const entry = skipEntry(name, decision);
    if (entry) recordEvent(Object.assign(entry, { downloadId: item.id }));
    return;
  }
  // Already where it belongs (for example, saved there through a Save As dialog).
  if (normalizePath(item.filename).endsWith('/' + decision.path)) return;

  if (!ROUTABLE_URL.test(item.url || '')) {
    recordEvent({
      file: name,
      status: 'left',
      note: 'Files created by the page itself can’t be moved in Firefox',
      downloadId: item.id
    });
    return;
  }

  let copyId;
  try {
    copyId = await startCopy(item, decision.path, settings);
  } catch (err) {
    console.warn('Download Valet: could not start copy', err);
    recordEvent({ file: name, status: 'left', note: KEPT_NOTES['copy-failed'], downloadId: item.id });
    return;
  }

  await api.storage.session.set({ [PENDING_PREFIX + copyId]: { original: item, name, decision } });
  await scheduleSettle(copyId);
}

/** Starts PDF downloads ourselves so Firefox cannot prompt for a folder or auto-open the original. */
async function downloadPdfSilently(details, filename) {
  if (details.method !== 'GET' || details.tabId === -1 || details.incognito ||
      (details.cookieStoreId && details.cookieStoreId !== 'firefox-default')) return;
  const settings = await loadSettings();
  if (!settings.enabled) return;
  const options = { url: details.url, saveAs: false, conflictAction: 'uniquify' };
  if (filename) options.filename = DR.sanitizeFileName(DR.baseName(filename));
  if (ROUTABLE_URL.test(details.originUrl || '')) {
    options.headers = [{ name: 'Referer', value: details.originUrl }];
  }
  let id;
  try {
    id = await api.downloads.download(options);
  } catch (err) {
    console.warn('Download Valet: could not start silent PDF download', err);
    return;
  }
  // These first downloads may be sorted; copies created by routing must still be ignored.
  let cancelOriginal = !details.responseHeaders;
  try {
    const item = details.responseHeaders ? await finishedDownload(id) : await getDownload(id);
    if (details.responseHeaders) {
      const header = name => {
        const found = details.responseHeaders.find(header => header.name.toLowerCase() === name);
        return found && found.value;
      };
      const expected = { state: 'complete', mime: header('content-type'),
        fileSize: header('content-encoding') ? -1 : Number(header('content-length') || -1) };
      // The response is already open: keep it available if a single-use link refuses our request.
      if (!item || item.state !== 'complete' || item.error || !looksLikeSameFile(expected, item)) {
        await quietly(() => discardDownload(id));
        return;
      }
      cancelOriginal = true;
    }
    if (item) await routeInFirefox(item, true);
  } catch (err) {
    console.error('Download Valet: silent PDF routing failed; original retained', err);
  }
  return cancelOriginal ? { cancel: true } : undefined;
}

async function finishedDownload(id) {
  let onChanged;
  const finished = new Promise(resolve => {
    onChanged = delta => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') resolve();
    };
  });
  api.downloads.onChanged.addListener(onChanged);
  try {
    const item = await getDownload(id);
    if (!item || item.state !== 'in_progress') return item;
    await finished;
    return getDownload(id);
  } finally {
    api.downloads.onChanged.removeListener(onChanged);
  }
}

function responseFilename(headers) {
  const header = headers.find(header => header.name.toLowerCase() === 'content-disposition');
  const value = header && header.value || '';
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]*)/i.exec(value);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].trim()); } catch (err) { /* Fall back to the plain filename. */ }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(value);
  return plain ? (plain[1] === undefined ? plain[2].trim() : plain[1].replace(/\\(.)/g, '$1')) : '';
}

if (!CHROME_MODE) {
  const pdfFilter = { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'other'] };
  api.webRequest.onBeforeRequest.addListener(details => {
    if (/\.pdf$/i.test(new URL(details.url).pathname)) return downloadPdfSilently(details);
  }, pdfFilter, ['blocking']);
  api.webRequest.onHeadersReceived.addListener(details => {
    const headers = details.responseHeaders || [];
    const mime = headers.find(header => header.name.toLowerCase() === 'content-type');
    const filename = responseFilename(headers);
    if (details.statusCode >= 200 && details.statusCode < 300 &&
        (baseMime(mime && mime.value) === 'application/pdf' || /\.pdf$/i.test(filename))) {
      return downloadPdfSilently(details, filename || 'download.pdf');
    }
  }, pdfFilter, ['blocking', 'responseHeaders']);
  api.downloads.onCreated.addListener((item) => {
    routeInFirefox(item).catch((err) => console.error('Download Valet: routing failed', err));
  });
  api.downloads.onChanged.addListener(delta => {
    if (delta.state) scheduleSettle(delta.id).catch(err => console.warn('Download Valet: original retained', err));
  });
  api.storage.session.get(null).then(pending => Promise.all(
    Object.keys(pending).filter(key => key.startsWith(PENDING_PREFIX))
      .map(key => scheduleSettle(Number(key.slice(PENDING_PREFIX.length))))
  )).catch(err => console.warn('Download Valet: could not restore pending routes', err));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

api.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await api.storage.local.get('settings');
  await api.storage.local.set({ settings: DR.normalizeSettings(settings) });
  await refreshBadge();
  if (details.reason === 'install') {
    await quietly(() => api.runtime.openOptionsPage());
  }
});

api.runtime.onStartup.addListener(refreshBadge);

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshBadge();
});
