'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DR = require('../shared/rules.js');

test('defaults route every extension in all 14 categories without sharing mutable rules', () => {
  const settings = DR.defaultSettings();
  assert.equal(settings.rules.length, 14);
  for (const rule of settings.rules) {
    for (const extension of rule.extensions) assert.equal(DR.decide(settings, { filename: `sample.${extension}` }).folder, rule.folder);
  }
  settings.rules[0].extensions.length = 0;
  assert.ok(DR.defaultSettings().rules[0].extensions.length > 0);
});

test('extension parsing handles case, dots, wildcards, compounds, and invalid paths', () => {
  assert.deepEqual(DR.parseExtensionList('*.JPG, .png jpg; tar.gz ../exe bad/ext'), {
    extensions: ['jpg', 'png', 'tar.gz'], invalid: ['../exe', 'bad/ext']
  });
  assert.deepEqual(DR.extensionCandidates('backup.TAR.GZ'), ['tar.gz', 'gz']);
  assert.deepEqual(DR.extensionCandidates('.bashrc'), []);
});

test('compound suffixes beat generic rules; order breaks ties', () => {
  const settings = DR.normalizeSettings({ rules: [
    { id: 'generic', folder: 'Generic', extensions: ['gz'] },
    { id: 'specific', folder: 'Specific', extensions: ['tar.gz'] },
    { id: 'duplicate', folder: 'Duplicate', extensions: ['tar.gz'] }
  ] });
  assert.equal(DR.decide(settings, { filename: 'file.tar.gz' }).folder, 'Specific');
  settings.rules[1].enabled = false;
  assert.equal(DR.decide(settings, { filename: 'file.tar.gz' }).folder, 'Duplicate');
  assert.equal(DR.decide(settings, { filename: 'file.gz' }).folder, 'Generic');
});

test('MIME fallback applies only to names without extensions', () => {
  const settings = DR.defaultSettings();
  assert.equal(DR.decide(settings, { filename: 'report', mime: 'application/pdf; charset=utf-8' }).folder, 'Documents');
  assert.equal(DR.decide(settings, { filename: 'report.unknown', mime: 'application/pdf' }).action, 'skip');
});

test('pause and unmatched fallback have explicit decisions', () => {
  const settings = DR.defaultSettings();
  assert.equal(DR.decide(settings, { filename: 'file.unknown' }).reason, 'no-match');
  settings.fallback.enabled = true;
  assert.equal(DR.decide(settings, { filename: 'file.unknown' }).path, 'Other/file.unknown');
  settings.enabled = false;
  assert.equal(DR.decide(settings, { filename: 'file.jpg' }).reason, 'disabled');
});

test('folder templates expand dates and sanitize unsafe components', () => {
  assert.equal(DR.sanitizeFolder('Images/{YYYY}-{MM}/{DD}', new Date(2026, 10, 6)), 'Images/2026-11/06');
  assert.equal(DR.sanitizeFolder('C:\\Users\\..\\CON\\bad:name'), 'Users/_CON/bad_name');
  assert.equal(DR.sanitizeFolder('../../'), '');
  assert.equal(DR.sanitizeFolder('/absolute//path'), 'absolute/path');
  assert.ok(DR.sanitizeFolder('a/'.repeat(20)).split('/').length <= 8);
});

test('filenames cannot introduce subfolders, dot components, or device names', () => {
  assert.equal(DR.sanitizeFileName('../report.pdf'), '_report.pdf');
  assert.equal(DR.sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(DR.sanitizeFileName('..'), 'download');
  assert.equal(DR.decide(DR.defaultSettings(), { filename: 'C:\\folder\\report.pdf' }).path, 'Documents/report.pdf');
});

test('partial settings normalize and duplicate IDs become unique', () => {
  const settings = DR.normalizeSettings({ conflictAction: 'invalid', rules: [null, { id: 'same' }, { id: 'same' }] });
  assert.equal(settings.conflictAction, 'uniquify');
  assert.equal(settings.rules.length, 2);
  assert.notEqual(settings.rules[0].id, settings.rules[1].id);
  assert.equal(DR.normalizeSettings(null).rules.length, 14);
  assert.equal(DR.normalizeSettings({ rules: [] }).rules.length, 0);
});

test('validation detects invalid input and shadowed enabled rules', () => {
  const rule = { id: 'a', name: 'First', enabled: true, folder: '', extensions: [] };
  assert.ok(DR.validateRule(rule, 'bad/ext').some(problem => problem.field === 'extensions'));
  assert.ok(DR.validateRule(rule).some(problem => problem.field === 'folder'));
  const rules = [{ ...rule, folder: 'First', extensions: ['pdf'] }, { ...rule, id: 'b', folder: 'Second', extensions: ['pdf'] }];
  assert.equal(DR.findShadowedExtensions(rules).get('b')[0].ownerName, 'First');
  rules[0].enabled = false;
  assert.equal(DR.findShadowedExtensions(rules).size, 0);
});

test('default categories and their extensions are alphabetized without duplicates', () => {
  const names = DR.DEFAULT_RULES.map(rule => rule.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en')));
  const seen = new Set();
  for (const rule of DR.DEFAULT_RULES) {
    assert.deepEqual(rule.extensions, [...rule.extensions].sort(), rule.name);
    for (const extension of rule.extensions) {
      assert.equal(seen.has(extension), false, `Duplicate extension: ${extension}`);
      seen.add(extension);
    }
  }
});

test('presentations and spreadsheets belong to Documents', () => {
  const settings = DR.defaultSettings();
  for (const extension of ['csv', 'key', 'numbers', 'odp', 'ods', 'ppt', 'pptx', 'tsv', 'xls', 'xlsm', 'xlsx']) {
    assert.equal(DR.decide(settings, { filename: `report.${extension}` }).folder, 'Documents');
  }
  assert.equal(DR.decide(settings, { filename: 'sheet', mime: 'application/vnd.ms-excel' }).folder, 'Documents');
  assert.equal(DR.decide(settings, { filename: 'slides', mime: 'application/vnd.ms-powerpoint' }).folder, 'Documents');
  assert.equal(settings.rules.some(rule => ['Presentations', 'Spreadsheets', 'Archives', 'Design & 3D', 'Code & data'].includes(rule.name)), false);
});

test('compressed, graphics, models, data, and disk images have dedicated destinations', () => {
  const settings = DR.defaultSettings();
  for (const [name, folder] of Object.entries({
    'backup.tar.gz': 'Compressed', 'files.zip': 'Compressed',
    'artwork.psd': 'Graphics', 'layout.ai': 'Graphics',
    'part.stl': '3D Models', 'scene.blend': '3D Models',
    'config.json': 'Data', 'config.toml': 'Data',
    'backup.img': 'Disk Images', 'installer.iso': 'Disk Images',
    'script.py': 'Code', 'setup.exe': 'Programs'
  })) assert.equal(DR.decide(settings, { filename: name }).folder, folder, name);
});

test('extension edits stay sorted while custom category priorities and folders survive', () => {
  assert.deepEqual(DR.parseExtensionList('txt, .PDF png pdf tar.gz').extensions, ['pdf', 'png', 'tar.gz', 'txt']);
  const original = { rules: [
    { id: 'z', name: 'Zebra', folder: 'Custom/Reports', extensions: ['TXT', '.pdf', 'png', 'pdf'] },
    { id: 'a', name: 'Apple', folder: 'Other', extensions: ['pdf'] }
  ] };
  const settings = DR.normalizeSettings(original);
  assert.deepEqual(settings.rules.map(rule => rule.id), ['z', 'a']);
  assert.deepEqual(settings.rules[0].extensions, ['pdf', 'png', 'txt']);
  assert.deepEqual(original.rules[0].extensions, ['TXT', '.pdf', 'png', 'pdf']);
  assert.equal(DR.decide(settings, { filename: 'report.pdf' }).folder, 'Custom/Reports');
});
