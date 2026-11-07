'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const DR = require('../shared/rules.js');

function event() {
  return { listeners: [], addListener(listener) { this.listeners.push(listener); },
    removeListener(listener) { this.listeners = this.listeners.filter(item => item !== listener); } };
}

function harness(options = {}) {
  const local = { settings: options.settings || DR.defaultSettings() };
  const session = options.session || {};
  const calls = [];
  const original = {
    id: 1, url: 'https://example.test/report.pdf', filename: '/Downloads/report.pdf',
    state: 'complete', exists: true, mime: 'application/pdf', totalBytes: 100, bytesReceived: 100, fileSize: 100,
    ...options.original
  };
  const items = new Map([[1, original]]);
  let nextId = 2;
  function storage(data) {
    return {
      async get(keys) {
        if (keys === null) return { ...data };
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]));
      },
      async set(values) { Object.assign(data, values); },
      async remove(key) { delete data[key]; }
    };
  }
  const api = {
    runtime: { id: 'sorter@test', onInstalled: event(), onStartup: event(), async openOptionsPage() {} },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText() {}, async setTitle() {} },
    storage: { local: storage(local), session: storage(session), onChanged: event() },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    downloads: {
      onCreated: event(), onChanged: event(),
      async search({ id }) { return items.has(id) ? [{ ...items.get(id) }] : []; },
      async download(config) {
        calls.push(['download', config]);
        if (options.startError) throw new Error('Server refused copy');
        const id = nextId++;
        items.set(id, { ...original, id, filename: config.filename ? '/Downloads/' + config.filename : original.filename,
          state: 'in_progress', bytesReceived: 0, byExtensionId: api.runtime.id, ...options.copy });
        return id;
      },
      async cancel(id) { calls.push(['cancel', id]); items.get(id).state = 'interrupted'; },
      async removeFile(id) {
        calls.push(['removeFile', id]);
        if (options.removeError) throw new Error('File is locked');
        items.get(id).exists = false;
      },
      async erase({ id }) { calls.push(['erase', id]); items.delete(id); }
    }
  };
  if (options.chrome) api.downloads.onDeterminingFilename = event();
  const context = vm.createContext({
    ...(options.chrome ? { chrome: api, importScripts(path) {
      calls.push(['importScripts', path]);
      vm.runInContext(fs.readFileSync(require.resolve('../' + path), 'utf8'), context);
    } } : { browser: api, DownloadSorter: DR }),
    console: { warn() {}, error() {} }, setTimeout, clearTimeout, URL
  });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  return { api, context, local, session, calls, original, items,
    async route() { await context.routeInFirefox({ ...original }); await vm.runInContext('logChain', context); },
    async suggest() {
      let keepAlive;
      const suggestion = await new Promise(resolve => {
        keepAlive = api.downloads.onDeterminingFilename.listeners[0]({ ...original }, resolve);
      });
      await vm.runInContext('logChain', context);
      return { suggestion, keepAlive };
    },
    async finish(copy) { Object.assign(items.get(2), copy); await context.scheduleSettle(2); }
  };
}

test('retains original until replacement completes, then records success once', async () => {
  const h = harness({ copy: { bytesReceived: 10 } });
  await h.route();
  assert.ok(h.items.has(1));
  assert.equal(h.local.stats, undefined);
  assert.equal(h.calls[0][1].filename, 'Documents/report.pdf');
  await h.finish({ state: 'complete', bytesReceived: 100 });
  assert.equal(h.items.has(1), false);
  assert.equal(h.local.stats.sorted, 1);
  assert.equal(h.local.log[0].downloadId, 2);
  assert.equal(Object.keys(h.session).length, 0);
  await h.context.scheduleSettle(2);
  assert.equal(h.local.stats.sorted, 1);
});

test('interrupted replacement keeps original and logs why', async () => {
  const h = harness();
  await h.route();
  await h.finish({ state: 'interrupted', error: 'NETWORK_FAILED', bytesReceived: 20 });
  assert.ok(h.items.has(1));
  assert.equal(h.items.has(2), false);
  assert.equal(h.local.log[0].status, 'left');
  assert.equal(h.local.stats.sorted, 0);
});

test('wrong MIME or content length never deletes original', async () => {
  for (const copy of [{ mime: 'text/html' }, { totalBytes: 20 }, { totalBytes: -1, fileSize: 30 }]) {
    const h = harness({ copy: { state: 'complete', bytesReceived: 100, ...copy } });
    await h.route();
    assert.ok(h.items.has(1));
    assert.equal(h.items.has(2), false);
    assert.match(h.local.log[0].note, /different file/);
  }
});

test('failed copy request leaves original untouched without fallback requests', async () => {
  const h = harness({ startError: true });
  await h.route();
  assert.equal(h.items.get(1).state, 'complete');
  assert.equal(h.calls.filter(call => call[0] === 'download').length, 1);
  assert.equal(h.local.log[0].status, 'left');
});

test('private, container, extension, and already-sorted files are not replayed', async () => {
  for (const original of [
    { incognito: true }, { cookieStoreId: 'firefox-container-1' },
    { byExtensionId: 'sorter@test' }, { byExtensionId: 'other@test' },
    { filename: '/Downloads/Documents/report.pdf' }
  ]) {
    const h = harness({ original });
    await h.route();
    assert.equal(h.calls.length, 0);
    if (original.incognito || original.cookieStoreId) assert.equal(h.local.log, undefined);
  }
});

test('blob downloads are preserved and disabled sorting does nothing', async () => {
  const h = harness({ original: { url: 'blob:https://example.test/123' } });
  await h.route();
  assert.equal(h.calls.length, 0);
  assert.match(h.local.log[0].note, /can’t be moved/);
  const paused = harness({ settings: { ...DR.defaultSettings(), enabled: false } });
  await paused.route();
  assert.equal(paused.calls.length, 0);
});

test('preserves referrer and safe conflict defaults', async () => {
  const h = harness({ original: { referrer: 'https://example.test/account' } });
  await h.route();
  assert.equal(h.calls[0][1].headers[0].value, 'https://example.test/account');
  assert.equal(h.calls[0][1].conflictAction, 'uniquify');
});

test('copies completing before creation resolves are settled immediately', async () => {
  const h = harness({ copy: { state: 'complete', bytesReceived: 100 } });
  await h.route();
  assert.equal(h.items.has(1), false);
  assert.equal(h.local.stats.sorted, 1);
});

test('stale progress counts do not reject a completed file with equal on-disk size', async () => {
  const h = harness({ copy: { state: 'complete', bytesReceived: 80, fileSize: 100 } });
  await h.route();
  assert.equal(h.items.has(1), false);
  assert.equal(h.local.stats.sorted, 1);
});

test('failed original removal keeps history and permits retry', async () => {
  const h = harness({ removeError: true });
  await h.route();
  await assert.rejects(h.finish({ state: 'complete', bytesReceived: 100 }), /locked/);
  assert.ok(h.items.has(1));
  assert.ok(h.items.has(2));
  assert.ok(h.session['routing:2']);
  assert.equal(h.local.stats, undefined);
});

test('session entries recover after background-page suspension', async () => {
  const session = {};
  const before = harness({ session });
  await before.route();
  const after = harness({ session });
  after.items.set(2, { ...after.original, id: 2, byExtensionId: 'sorter@test' });
  await new Promise(resolve => setImmediate(resolve));
  await after.context.scheduleSettle(2);
  assert.equal(after.items.has(1), false);
  assert.equal(after.local.stats.sorted, 1);
});

test('Chrome service worker imports shared rules and registers only native routing', () => {
  const h = harness({ chrome: true });
  assert.deepEqual(h.calls, [['importScripts', 'shared/rules.js']]);
  assert.equal(h.api.downloads.onDeterminingFilename.listeners.length, 1);
  assert.equal(h.api.downloads.onCreated.listeners.length, 0);
  assert.equal(h.api.downloads.onChanged.listeners.length, 0);
  assert.equal(h.api.webRequest.onBeforeRequest.listeners.length, 0);
  assert.equal(h.api.webRequest.onHeadersReceived.listeners.length, 0);
});

test('Firefox PDF links become silent downloads and retain normal sorting checks', async () => {
  const h = harness({ settings: { ...DR.defaultSettings(), conflictAction: 'overwrite' } });
  const result = await h.api.webRequest.onBeforeRequest.listeners[0]({
    url: 'https://example.test/report.PDF?token=abc', method: 'GET', cookieStoreId: 'firefox-default',
    originUrl: 'https://example.test/account'
  });
  assert.equal(result.cancel, true);
  const downloads = h.calls.filter(call => call[0] === 'download').map(call => call[1]);
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0].saveAs, false);
  assert.equal(downloads[0].conflictAction, 'uniquify');
  assert.equal(downloads[0].headers[0].value, 'https://example.test/account');
  assert.equal(downloads[1].filename, 'Documents/report.pdf');
  assert.equal(downloads[1].saveAs, false);
  assert.equal(downloads[1].conflictAction, 'overwrite');
  assert.ok(h.items.has(2));
  Object.assign(h.items.get(3), { state: 'complete', bytesReceived: 100 });
  await h.context.scheduleSettle(3);
  assert.equal(h.items.has(2), false);
  assert.equal(h.local.log[0].downloadId, 3);
});

test('Firefox detects PDFs from response MIME when the URL has no extension', async () => {
  const h = harness({ copy: { state: 'complete' } });
  const result = await h.api.webRequest.onHeadersReceived.listeners[0]({
    url: 'https://example.test/download?id=123', method: 'GET', statusCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/pdf; charset=binary' },
      { name: 'Content-Disposition', value: 'attachment; filename="server report.pdf"' }
    ]
  });
  assert.equal(result.cancel, true);
  assert.equal(h.calls[0][1].saveAs, false);
  assert.equal(h.calls[0][1].filename, 'server report.pdf');
  assert.equal(h.calls[1][1].filename, 'Documents/server report.pdf');
});

test('PDF response filenames support UTF-8, quoted separators, and malformed encoding fallback', () => {
  const h = harness();
  for (const [value, expected] of [
    ['attachment; filename="fallback.pdf"; filename*=UTF-8\'\'ara%C3%A7%C3%A3o.pdf', 'aração.pdf'],
    ['attachment; filename="report; final.pdf"', 'report; final.pdf'],
    ['attachment; filename="fallback.pdf"; filename*=UTF-8\'\'%ZZ.pdf', 'fallback.pdf'],
    ['attachment; filename=report.pdf', 'report.pdf']
  ]) {
    assert.equal(h.context.responseFilename([{ name: 'Content-Disposition', value }]), expected);
  }
});

test('Firefox also intercepts PDF attachments served with a generic MIME type', async () => {
  const h = harness({ copy: { state: 'complete' } });
  const result = await h.api.webRequest.onHeadersReceived.listeners[0]({
    url: 'https://example.test/export', method: 'GET', statusCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/octet-stream' },
      { name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }
    ]
  });
  assert.equal(result.cancel, true);
  assert.equal(h.calls[0][1].filename, 'report.pdf');
  assert.equal(h.calls[0][1].saveAs, false);
});

test('Firefox silent downloads preserve normal behavior outside public GET PDF links', async () => {
  for (const details of [
    { incognito: true }, { cookieStoreId: 'firefox-container-1' }, { method: 'POST' }, { tabId: -1 },
    { url: 'https://example.test/page?file=report.pdf' }
  ]) {
    const h = harness();
    const result = await h.api.webRequest.onBeforeRequest.listeners[0]({
      url: 'https://example.test/report.pdf', method: 'GET', ...details
    });
    assert.equal(result, undefined);
    assert.equal(h.calls.length, 0);
  }
  const paused = harness({ settings: { ...DR.defaultSettings(), enabled: false } });
  assert.equal(await paused.context.downloadPdfSilently({ url: 'https://example.test/report.pdf', method: 'GET' }), undefined);
  assert.equal(paused.calls.length, 0);
  const failed = harness({ startError: true });
  assert.equal(await failed.context.downloadPdfSilently({ url: 'https://example.test/report.pdf', method: 'GET' }), undefined);
});

test('Firefox keeps the silent original if its sorted copy fails', async () => {
  const h = harness();
  await h.context.downloadPdfSilently({ url: 'https://example.test/report.pdf', method: 'GET' });
  Object.assign(h.items.get(3), { state: 'interrupted', error: 'NETWORK_FAILED' });
  await h.context.scheduleSettle(3);
  assert.ok(h.items.has(2));
  assert.equal(h.items.has(3), false);
  assert.equal(h.local.log[0].downloadId, 2);
  assert.equal(h.local.log[0].status, 'left');
});

test('Firefox only cancels an already-open PDF response after its silent original is verified', async () => {
  const h = harness();
  let settled = false;
  const intercepted = h.api.webRequest.onHeadersReceived.listeners[0]({
    url: 'https://example.test/export', method: 'GET', statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }]
  }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(h.calls.length, 1);
  Object.assign(h.items.get(2), { state: 'complete' });
  for (const listener of [...h.api.downloads.onChanged.listeners]) {
    listener({ id: 2, state: { current: 'complete' } });
  }
  assert.equal((await intercepted).cancel, true);
  assert.equal(h.api.downloads.onChanged.listeners.length, 1);
});

test('Firefox preserves the original response when a one-time link refuses the silent request', async () => {
  for (const copy of [
    { state: 'interrupted', error: 'SERVER_FORBIDDEN' },
    { state: 'complete', mime: 'text/html' },
    { state: 'complete', fileSize: 50 }
  ]) {
    const h = harness({ copy });
    const result = await h.api.webRequest.onHeadersReceived.listeners[0]({
      url: 'https://example.test/export', method: 'GET', statusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }, { name: 'Content-Length', value: '100' }]
    });
    assert.equal(result, undefined);
    assert.equal(h.items.has(2), false);
    assert.equal(h.api.downloads.onChanged.listeners.length, 1);
  }
  const unreadable = harness();
  unreadable.api.downloads.search = async () => { throw new Error('Download unavailable'); };
  assert.equal(await unreadable.api.webRequest.onHeadersReceived.listeners[0]({
    url: 'https://example.test/export', method: 'GET', statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }]
  }), undefined);
  assert.equal(unreadable.api.downloads.onChanged.listeners.length, 1);
});

test('Chrome suggests the destination without downloading a second copy', async () => {
  const h = harness({ chrome: true });
  const { suggestion, keepAlive } = await h.suggest();
  assert.equal(keepAlive, true);
  assert.equal(suggestion.filename, 'Documents/report.pdf');
  assert.equal(suggestion.conflictAction, 'uniquify');
  assert.equal(h.calls.filter(call => call[0] === 'download').length, 0);
});

test('Chrome leaves paused, unmatched and other-extension downloads unchanged', async () => {
  for (const options of [
    { settings: { ...DR.defaultSettings(), enabled: false } },
    { original: { filename: 'unknown.extension' } },
    { original: { byExtensionId: 'other@test' } }
  ]) {
    const h = harness({ chrome: true, ...options });
    assert.equal((await h.suggest()).suggestion, undefined);
    assert.equal(h.calls.filter(call => call[0] === 'download').length, 0);
  }
});

test('Chrome releases the download if settings cannot be read', async () => {
  const h = harness({ chrome: true });
  h.api.storage.local.get = async () => { throw new Error('Storage unavailable'); };
  assert.equal((await h.suggest()).suggestion, undefined);
});
