/*
 * Download Valet — shared rule engine.
 *
 * Pure functions only: no browser APIs, so the same file runs in the Chrome
 * service worker, the Firefox event page, the settings page, the popup and
 * Node unit tests.
 */
(function (root) {
  'use strict';

  const SCHEMA = 1;

  // Order matters only when two rules list the same extension (the higher one wins).
  const DEFAULT_RULES = [
    { name: '3D Models', folder: '3D Models', extensions: ['3mf', 'blend', 'fbx', 'glb', 'gltf', 'obj', 'stl'] },
    { name: 'Audio', folder: 'Audio', extensions: ['aac', 'aiff', 'flac', 'm4a', 'mid', 'midi', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wma'] },
    { name: 'Code', folder: 'Code', extensions: ['bat', 'c', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'ipynb', 'java', 'js', 'jsx', 'kt', 'mjs', 'php', 'ps1', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'ts', 'tsx'] },
    { name: 'Compressed', folder: 'Compressed', extensions: ['7z', 'bz2', 'gz', 'rar', 'tar', 'tar.bz2', 'tar.gz', 'tar.xz', 'tar.zst', 'tgz', 'xz', 'zip', 'zst'] },
    { name: 'Data', folder: 'Data', extensions: ['json', 'toml', 'xml', 'yaml', 'yml'] },
    { name: 'Disk Images', folder: 'Disk Images', extensions: ['img', 'iso'] },
    { name: 'Documents', folder: 'Documents', extensions: ['csv', 'doc', 'docx', 'key', 'md', 'numbers', 'odp', 'ods', 'odt', 'pages', 'pdf', 'ppt', 'pptx', 'rtf', 'tex', 'tsv', 'txt', 'xls', 'xlsm', 'xlsx'] },
    { name: 'eBooks', folder: 'eBooks', extensions: ['azw', 'azw3', 'cbr', 'cbz', 'djvu', 'epub', 'fb2', 'mobi'] },
    { name: 'Fonts', folder: 'Fonts', extensions: ['otf', 'ttf', 'woff', 'woff2'] },
    { name: 'Graphics', folder: 'Graphics', extensions: ['ai', 'eps', 'fig', 'indd', 'psd', 'sketch', 'xd'] },
    { name: 'Images', folder: 'Images', extensions: ['arw', 'avif', 'bmp', 'cr2', 'dng', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'nef', 'png', 'raw', 'svg', 'tif', 'tiff', 'webp'] },
    { name: 'Programs & installers', folder: 'Programs', extensions: ['apk', 'appimage', 'appx', 'deb', 'dmg', 'exe', 'msi', 'msix', 'pkg', 'rpm'] },
    { name: 'Torrents', folder: 'Torrents', extensions: ['torrent'] },
    { name: 'Videos', folder: 'Videos', extensions: ['3gp', 'avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv'] }
  ];

  const CONFLICT_ACTIONS = ['uniquify', 'overwrite', 'prompt'];

  // Used only when a file name has no extension at all.
  const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp',
    'image/tiff': 'tiff', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi', 'video/mpeg': 'mpeg',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav',
    'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
    'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/opus': 'opus',
    'application/pdf': 'pdf', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/rtf': 'rtf', 'text/plain': 'txt', 'text/markdown': 'md', 'application/epub+zip': 'epub',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-7z-compressed': '7z',
    'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar', 'application/gzip': 'gz',
    'application/x-gzip': 'gz', 'application/x-tar': 'tar', 'application/x-bzip2': 'bz2',
    'application/x-xz': 'xz',
    'application/x-msdownload': 'exe', 'application/x-msi': 'msi',
    'application/vnd.android.package-archive': 'apk', 'application/x-apple-diskimage': 'dmg',
    'application/x-debian-package': 'deb', 'application/x-rpm': 'rpm',
    'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml', 'text/html': 'html',
    'text/css': 'css', 'text/javascript': 'js', 'application/javascript': 'js',
    'font/ttf': 'ttf', 'font/otf': 'otf', 'font/woff': 'woff', 'font/woff2': 'woff2',
    'application/x-bittorrent': 'torrent'
  };

  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/g;
  const EXT_PATTERN = /^[a-z0-9][a-z0-9_+-]*(\.[a-z0-9][a-z0-9_+-]*)*$/;
  const MAX_SEGMENTS = 8;
  const MAX_SEGMENT_LENGTH = 80;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function makeId() {
    return 'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /** "*.JPG", ".jpg", " jpg " → "jpg". Returns null when the token can't be an extension. */
  function normalizeExt(token) {
    if (typeof token !== 'string') return null;
    let t = token.trim().toLowerCase();
    t = t.replace(/^\*/, '').replace(/^\.+/, '');
    if (!t || t.length > 24 || !EXT_PATTERN.test(t)) return null;
    return t;
  }

  /** Parses user text such as "jpg, .png  *.webp" into extensions plus the tokens that were rejected. */
  function parseExtensionList(text) {
    const extensions = [];
    const invalid = [];
    String(text || '')
      .split(/[\s,;]+/)
      .filter(Boolean)
      .forEach((token) => {
        const ext = normalizeExt(token);
        if (!ext) invalid.push(token);
        else if (!extensions.includes(ext)) extensions.push(ext);
      });
    return { extensions: extensions.sort(), invalid };
  }

  /** Last path component, whichever separator the platform uses. */
  function baseName(path) {
    const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /**
   * Candidate extensions, most specific first:
   * "backup.tar.gz" → ["tar.gz", "gz"]; "photo.JPG" → ["jpg"]; ".bashrc" → [].
   */
  function extensionCandidates(filename) {
    const name = baseName(filename).toLowerCase().replace(/^\.+/, '');
    const parts = name.split('.');
    if (parts.length < 2) return [];
    const out = [];
    const first = Math.max(1, parts.length - 3);
    for (let i = first; i < parts.length; i++) {
      const candidate = parts.slice(i).join('.');
      if (candidate && !candidate.endsWith('.') && EXT_PATTERN.test(candidate)) out.push(candidate);
    }
    return out;
  }

  function extensionFromMime(mime) {
    if (typeof mime !== 'string') return null;
    const base = mime.split(';')[0].trim().toLowerCase();
    return MIME_TO_EXT[base] || null;
  }

  function sanitizeSegment(segment) {
    let s = String(segment)
      .replace(ILLEGAL_CHARS, '_')
      .trim()
      .replace(/^\.+/, '')       // no hidden folders, no "." or ".."
      .replace(/[. ]+$/, '');    // Windows strips trailing dots/spaces
    if (s.length > MAX_SEGMENT_LENGTH) s = s.slice(0, MAX_SEGMENT_LENGTH).replace(/[. ]+$/, '');
    if (WINDOWS_RESERVED.test(s)) s = '_' + s;
    return s;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function expandTokens(template, date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    return String(template || '')
      .replace(/\{YYYY\}/g, String(d.getFullYear()))
      .replace(/\{MM\}/g, pad2(d.getMonth() + 1))
      .replace(/\{DD\}/g, pad2(d.getDate()));
  }

  /**
   * Turns a folder template into a safe path relative to the Downloads folder.
   * Drive letters, leading slashes, "..", illegal characters and empty parts are removed.
   * Returns "" when nothing usable remains.
   */
  function sanitizeFolder(template, date) {
    let text = expandTokens(template, date).trim();
    text = text.replace(/^[a-zA-Z]:/, '').replace(/^~/, '');
    const segments = text
      .split(/[\\/]+/)
      .map(sanitizeSegment)
      .filter(Boolean)
      .slice(0, MAX_SEGMENTS);
    return segments.join('/');
  }

  function sanitizeFileName(name) {
    let s = String(name || '').replace(ILLEGAL_CHARS, '_').replace(/[\\/]/g, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (!s || /^\.+$/.test(s)) s = 'download';
    if (WINDOWS_RESERVED.test(s)) s = '_' + s;
    return s;
  }

  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.extensions)
      ? raw.extensions
      : parseExtensionList(raw.extensions).extensions;
    const extensions = [];
    list.forEach((e) => {
      const ext = normalizeExt(e);
      if (ext && !extensions.includes(ext)) extensions.push(ext);
    });
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : '',
      folder: typeof raw.folder === 'string' ? raw.folder.slice(0, 200) : '',
      extensions: extensions.sort(),
      enabled: raw.enabled !== false
    };
  }

  function defaultSettings() {
    return {
      schema: SCHEMA,
      enabled: true,
      rules: DEFAULT_RULES.map((r) => normalizeRule(Object.assign({ enabled: true }, clone(r)))),
      fallback: { enabled: false, folder: 'Other' },
      conflictAction: 'uniquify',
      includeExtensionDownloads: false
    };
  }

  /** Accepts anything (missing, partial, corrupted) and returns complete, valid settings. */
  function normalizeSettings(raw) {
    const base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    const out = {
      schema: SCHEMA,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
      rules: Array.isArray(raw.rules) ? raw.rules.map(normalizeRule).filter(Boolean) : base.rules,
      fallback: {
        enabled: !!(raw.fallback && raw.fallback.enabled === true),
        folder: raw.fallback && typeof raw.fallback.folder === 'string' ? raw.fallback.folder.slice(0, 200) : base.fallback.folder
      },
      conflictAction: CONFLICT_ACTIONS.includes(raw.conflictAction) ? raw.conflictAction : base.conflictAction,
      includeExtensionDownloads: raw.includeExtensionDownloads === true
    };
    const seen = new Set();
    out.rules.forEach((r) => {
      if (seen.has(r.id)) r.id = makeId();
      seen.add(r.id);
    });
    return out;
  }

  /**
   * Finds the rule for a file. The most specific extension wins ("tar.gz" before "gz");
   * among rules listing the same extension, the one higher in the list wins.
   * A name without an extension falls back to the MIME type.
   */
  function matchRule(settings, filename, mime) {
    let candidates = extensionCandidates(filename);
    let via = 'extension';
    if (!candidates.length) {
      const fromMime = extensionFromMime(mime);
      if (fromMime) {
        candidates = [fromMime];
        via = 'mime';
      }
    }
    const rules = (settings.rules || []).filter((r) => r.enabled && sanitizeFolder(r.folder));
    for (const ext of candidates) {
      const rule = rules.find((r) => r.extensions.includes(ext));
      if (rule) return { rule, ext, via };
    }
    return { rule: null, ext: candidates[0] || null, via };
  }

  /**
   * The single decision function used by every browser.
   * info: { filename, mime }
   * Returns { action: 'route', path, folder, ruleId, ruleName, ext } or { action: 'skip', reason, ext }.
   */
  function decide(settings, info, date) {
    if (!settings || !settings.enabled) return { action: 'skip', reason: 'disabled' };
    const name = baseName(info && info.filename);
    if (!name) return { action: 'skip', reason: 'no-name' };
    const m = matchRule(settings, name, info && info.mime);
    let template;
    let ruleId = null;
    let ruleName;
    if (m.rule) {
      template = m.rule.folder;
      ruleId = m.rule.id;
      ruleName = m.rule.name || m.rule.folder;
    } else if (settings.fallback && settings.fallback.enabled) {
      template = settings.fallback.folder;
      ruleName = 'Other files';
    } else {
      return { action: 'skip', reason: 'no-match', ext: m.ext };
    }
    const folder = sanitizeFolder(template, date);
    if (!folder) return { action: 'skip', reason: 'empty-folder', ext: m.ext };
    return {
      action: 'route',
      folder,
      path: folder + '/' + sanitizeFileName(name),
      ruleId,
      ruleName,
      ext: m.ext
    };
  }

  /** Human-readable problems for one rule, for the settings page. */
  function validateRule(rule, rawExtensionText) {
    const problems = [];
    if (rawExtensionText !== undefined) {
      const parsed = parseExtensionList(rawExtensionText);
      if (parsed.invalid.length) {
        problems.push({ level: 'error', field: 'extensions', text: 'Not a file extension: ' + parsed.invalid.join(', ') });
      }
    }
    if (!rule.extensions.length) {
      problems.push({ level: 'error', field: 'extensions', text: 'Add at least one file extension, like pdf or jpg.' });
    }
    const folderText = String(rule.folder || '').trim();
    const cleaned = sanitizeFolder(rule.folder);
    if (!cleaned) {
      problems.push({ level: 'error', field: 'folder', text: 'Choose a folder name. Without one, this rule does nothing.' });
    } else if (/^([a-zA-Z]:|[\\/]|~)/.test(folderText)) {
      problems.push({ level: 'warning', field: 'folder', text: 'Browsers can only save inside your Downloads folder, so this becomes Downloads/' + cleaned + '.' });
    } else if (cleaned !== expandTokens(folderText).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '')) {
      problems.push({ level: 'warning', field: 'folder', text: 'Some characters aren’t allowed in folder names. Files will go to Downloads/' + cleaned + '.' });
    }
    return problems;
  }

  /** Extensions listed by more than one enabled rule; only the first listing takes effect. */
  function findShadowedExtensions(rules) {
    const owner = new Map();
    const shadowed = new Map(); // ruleId → [{ ext, ownerName }]
    (rules || []).forEach((r) => {
      if (!r.enabled) return;
      r.extensions.forEach((ext) => {
        if (!owner.has(ext)) {
          owner.set(ext, r);
        } else {
          const list = shadowed.get(r.id) || [];
          const first = owner.get(ext);
          list.push({ ext, ownerName: first.name || first.folder });
          shadowed.set(r.id, list);
        }
      });
    });
    return shadowed;
  }

  const api = {
    SCHEMA,
    CONFLICT_ACTIONS,
    DEFAULT_RULES,
    defaultSettings,
    normalizeSettings,
    normalizeRule,
    normalizeExt,
    parseExtensionList,
    extensionCandidates,
    extensionFromMime,
    sanitizeFolder,
    sanitizeFileName,
    baseName,
    matchRule,
    decide,
    validateRule,
    findShadowedExtensions,
    makeId
  };

  root.DownloadSorter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
