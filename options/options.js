'use strict';

const api = globalThis.browser || globalThis.chrome;
const DR = globalThis.DownloadSorter;

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'),
  enabledLabel: $('enabled-label'),
  firefoxNote: $('firefox-note'),
  tryName: $('try-name'),
  tryResult: $('try-result'),
  ruleList: $('rule-list'),
  addRule: $('add-rule'),
  restore: $('restore-defaults'),
  fallbackEnabled: $('fallback-enabled'),
  fallbackFolder: $('fallback-folder'),
  fallbackField: $('fallback-field'),
  fallbackMessage: $('fallback-message'),
  includeExt: $('include-extension-downloads'),
  status: $('status'),
  statusText: $('status-text'),
  statusAction: $('status-action'),
  template: $('rule-template')
};

let settings = DR.defaultSettings();
const rawExtensionText = new Map(); // rule id → what the user typed, until it's valid
let lastSavedJson = '';
let saveTimer = null;

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

async function save() {
  clearTimeout(saveTimer);
  const clean = DR.normalizeSettings(settings);
  lastSavedJson = JSON.stringify(clean);
  try {
    await api.storage.local.set({ settings: clean });
    showStatus('Saved');
  } catch (err) {
    showStatus('Couldn’t save: ' + (err && err.message ? err.message : 'unknown error'));
  }
}

let statusTimer = null;
function showStatus(text, action) {
  clearTimeout(statusTimer);
  els.statusText.textContent = text;
  if (action) {
    els.statusAction.textContent = action.label;
    els.statusAction.onclick = () => {
      action.run();
      els.status.classList.remove('visible');
    };
    els.statusAction.hidden = false;
  } else {
    els.statusAction.hidden = true;
    els.statusAction.onclick = null;
  }
  els.status.classList.add('visible');
  statusTimer = setTimeout(() => els.status.classList.remove('visible'), action ? 7000 : 1600);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderGlobal() {
  els.enabled.checked = settings.enabled;
  els.enabledLabel.textContent = settings.enabled ? 'Sorting is on' : 'Sorting is paused';
  els.fallbackEnabled.checked = settings.fallback.enabled;
  els.fallbackFolder.value = settings.fallback.folder;
  els.fallbackField.classList.toggle('off', !settings.fallback.enabled);
  document.querySelectorAll('input[name="conflict"]').forEach((r) => {
    r.checked = r.value === settings.conflictAction;
  });
  els.includeExt.checked = settings.includeExtensionDownloads;
  renderFallbackMessage();
}

function renderFallbackMessage() {
  const msg = els.fallbackMessage;
  if (!settings.fallback.enabled) {
    msg.hidden = true;
    return;
  }
  const cleaned = DR.sanitizeFolder(settings.fallback.folder);
  msg.hidden = false;
  if (!cleaned) {
    msg.className = 'field-message error';
    msg.textContent = 'Choose a folder name, or files no rule covers will stay in Downloads.';
  } else {
    const problems = DR.validateRule({ extensions: ['x'], folder: settings.fallback.folder });
    const warning = problems.find((p) => p.field === 'folder');
    if (warning) {
      msg.className = 'field-message ' + warning.level;
      msg.textContent = warning.text;
    } else {
      msg.hidden = true;
    }
  }
}

function renderRules(focus) {
  els.ruleList.textContent = '';
  settings.rules.forEach((rule, index) => {
    const li = els.template.content.firstElementChild.cloneNode(true);
    li.dataset.id = rule.id;
    li.classList.toggle('disabled', !rule.enabled);

    const enabled = li.querySelector('.rule-enabled');
    const name = li.querySelector('.rule-name');
    const exts = li.querySelector('.rule-extensions');
    const folder = li.querySelector('.rule-folder');
    const up = li.querySelector('.move-up');
    const down = li.querySelector('.move-down');
    const del = li.querySelector('.delete');

    enabled.checked = rule.enabled;
    enabled.setAttribute('aria-label', 'Use rule ' + (rule.name || index + 1));
    name.value = rule.name;
    exts.value = rawExtensionText.has(rule.id) ? rawExtensionText.get(rule.id) : rule.extensions.join(', ');
    folder.value = rule.folder;
    up.disabled = index === 0;
    down.disabled = index === settings.rules.length - 1;

    enabled.addEventListener('change', () => {
      rule.enabled = enabled.checked;
      li.classList.toggle('disabled', !rule.enabled);
      refreshMessages();
      scheduleSave();
    });
    name.addEventListener('input', () => {
      rule.name = name.value;
      refreshMessages();
      scheduleSave();
    });
    exts.addEventListener('input', () => {
      fitHeight(exts);
      rawExtensionText.set(rule.id, exts.value);
      rule.extensions = DR.parseExtensionList(exts.value).extensions;
      refreshMessages();
      scheduleSave();
    });
    exts.addEventListener('blur', () => {
      const parsed = DR.parseExtensionList(exts.value);
      if (!parsed.invalid.length) {
        rawExtensionText.delete(rule.id);
        exts.value = rule.extensions.join(', ');
        fitHeight(exts);
      }
    });
    folder.addEventListener('input', () => {
      rule.folder = folder.value;
      refreshMessages();
      scheduleSave();
    });
    up.addEventListener('click', () => moveRule(rule.id, -1));
    down.addEventListener('click', () => moveRule(rule.id, 1));
    del.addEventListener('click', () => deleteRule(rule.id));

    els.ruleList.appendChild(li);
    fitHeight(exts);
  });
  refreshMessages();

  if (focus) {
    const li = els.ruleList.querySelector(`[data-id="${CSS.escape(focus.id)}"]`);
    if (li) {
      const target = li.querySelector(focus.selector);
      if (target && !target.disabled) target.focus();
      else li.querySelector('.rule-name').focus();
      if (focus.flash) {
        li.classList.add('flash');
        li.addEventListener('animationend', () => li.classList.remove('flash'), { once: true });
      }
      if (focus.select) li.querySelector('.rule-name').select();
    }
  }
}

/** Grows the extensions box to fit its text so every extension stays visible. */
function fitHeight(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
}

function refreshMessages() {
  const shadowed = DR.findShadowedExtensions(settings.rules);
  els.ruleList.querySelectorAll('.rule').forEach((li) => {
    const rule = settings.rules.find((r) => r.id === li.dataset.id);
    if (!rule) return;
    const list = li.querySelector('.rule-messages');
    list.textContent = '';
    const raw = rawExtensionText.has(rule.id) ? rawExtensionText.get(rule.id) : undefined;
    const problems = rule.enabled ? DR.validateRule(rule, raw) : [];
    const fieldErrors = { extensions: false, folder: false };
    problems.forEach((p) => {
      if (p.level === 'error') fieldErrors[p.field] = true;
      const item = document.createElement('li');
      item.className = p.level;
      item.textContent = p.text;
      list.appendChild(item);
    });
    const dupes = shadowed.get(rule.id);
    if (dupes && dupes.length) {
      const byOwner = new Map();
      dupes.forEach((d) => {
        const exts = byOwner.get(d.ownerName) || [];
        exts.push('.' + d.ext);
        byOwner.set(d.ownerName, exts);
      });
      byOwner.forEach((exts, owner) => {
        const item = document.createElement('li');
        item.className = 'info';
        item.textContent = exts.join(', ') + ' also listed in “' + owner + '” above, so those files go there.';
        list.appendChild(item);
      });
    }
    li.querySelector('.rule-extensions').classList.toggle('invalid', fieldErrors.extensions);
    li.querySelector('.rule-folder').classList.toggle('invalid', fieldErrors.folder);
  });
  renderTester();
}

function renderTester() {
  const out = els.tryResult;
  out.textContent = '';
  const typed = els.tryName.value.trim();
  const name = DR.baseName(typed || els.tryName.placeholder);
  if (!name) return;

  const decision = DR.decide(settings, { filename: name });
  const line = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'route-arrow';
  arrow.textContent = '→';
  const root = document.createElement('span');
  root.className = 'route-root';
  root.textContent = 'Downloads/';
  line.append(arrow, root);

  const note = document.createElement('span');
  note.className = 'route-note';

  if (decision.action === 'route') {
    const folder = document.createElement('span');
    folder.className = 'route-folder';
    folder.textContent = decision.folder;
    line.append(folder, document.createTextNode('/' + DR.sanitizeFileName(name)));
    note.textContent = decision.ruleId
      ? 'Matched the “' + decision.ruleName + '” rule by .' + decision.ext
      : 'No rule lists .' + decision.ext + ', so it goes to your folder for other files';
  } else {
    line.append(document.createTextNode(name));
    if (decision.reason === 'disabled') note.textContent = 'Sorting is paused, so it stays in Downloads.';
    else if (decision.ext) note.textContent = 'No rule lists .' + decision.ext + ', so it stays in Downloads.';
    else note.textContent = 'This name has no extension. Real downloads usually get one from the file type, which is matched instead.';
  }
  if (!typed) note.textContent = 'Example. ' + note.textContent;
  out.append(line, note);
}

// ---------------------------------------------------------------------------
// Rule actions
// ---------------------------------------------------------------------------

function moveRule(id, delta) {
  const i = settings.rules.findIndex((r) => r.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= settings.rules.length) return;
  const [rule] = settings.rules.splice(i, 1);
  settings.rules.splice(j, 0, rule);
  renderRules({ id, selector: delta < 0 ? '.move-up' : '.move-down', flash: true });
  save();
}

function deleteRule(id) {
  const i = settings.rules.findIndex((r) => r.id === id);
  if (i < 0) return;
  const [removed] = settings.rules.splice(i, 1);
  const raw = rawExtensionText.get(id);
  rawExtensionText.delete(id);
  renderRules();
  save().then(() => {
    showStatus('Deleted “' + (removed.name || removed.folder || 'rule') + '”', {
      label: 'Undo',
      run: () => {
        settings.rules.splice(Math.min(i, settings.rules.length), 0, removed);
        if (raw !== undefined) rawExtensionText.set(id, raw);
        renderRules({ id, selector: '.rule-name', flash: true });
        save();
      }
    });
  });
}

els.addRule.addEventListener('click', () => {
  const rule = DR.normalizeRule({ name: 'New rule', folder: '', extensions: [], enabled: true });
  settings.rules.unshift(rule); // first, so it takes priority over the defaults
  renderRules({ id: rule.id, selector: '.rule-name', select: true, flash: true });
  save();
});

els.restore.addEventListener('click', () => {
  const previous = settings.rules;
  settings.rules = DR.defaultSettings().rules;
  rawExtensionText.clear();
  renderRules();
  save().then(() => {
    showStatus('Default rules restored', {
      label: 'Undo',
      run: () => {
        settings.rules = previous;
        renderRules();
        save();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

els.enabled.addEventListener('change', () => {
  settings.enabled = els.enabled.checked;
  renderGlobal();
  renderTester();
  save();
});

els.fallbackEnabled.addEventListener('change', () => {
  settings.fallback.enabled = els.fallbackEnabled.checked;
  renderGlobal();
  renderTester();
  save();
});

els.fallbackFolder.addEventListener('input', () => {
  settings.fallback.folder = els.fallbackFolder.value;
  renderFallbackMessage();
  renderTester();
  scheduleSave();
});

document.querySelectorAll('input[name="conflict"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      settings.conflictAction = radio.value;
      save();
    }
  });
});

els.includeExt.addEventListener('change', () => {
  settings.includeExtensionDownloads = els.includeExt.checked;
  save();
});

els.tryName.addEventListener('input', renderTester);

window.addEventListener('resize', () => {
  els.ruleList.querySelectorAll('.rule-extensions').forEach(fitHeight);
});

// Changes made elsewhere (the popup's on/off switch, another settings tab).
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const incoming = JSON.stringify(changes.settings.newValue);
  if (incoming === lastSavedJson) return;
  settings = DR.normalizeSettings(changes.settings.newValue);
  lastSavedJson = incoming;
  renderGlobal();
  renderRules();
});

// Flush a pending save if the tab is closed mid-edit.
window.addEventListener('pagehide', () => {
  if (saveTimer) save();
});

async function init() {
  const stored = await api.storage.local.get('settings');
  settings = DR.normalizeSettings(stored.settings);
  lastSavedJson = JSON.stringify(settings);
  if (!(api.downloads && api.downloads.onDeterminingFilename)) els.firefoxNote.hidden = false;
  renderGlobal();
  renderRules();
}

init();
