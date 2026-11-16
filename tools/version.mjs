// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR Mod's version numbers, in one place.
 *
 *   node tools/version.mjs                    show them
 *   node tools/version.mjs desktop 0.8.16     the desktop program (and the UI's "what's new")
 *   node tools/version.mjs mobile 0.3.12      the Android and iOS app; Android's versionCode goes up by one
 *   node tools/version.mjs --check            fail when the places of one number disagree
 *
 * Desktop: package.json (shell/build.sh and the UI read it) and package-lock.json.
 * Mobile: mobile/package.json, mobile/package-lock.json, mobile/android/app/build.gradle (versionName,
 * versionCode) and mobile/ios/App/App.xcodeproj/project.pbxproj (MARKETING_VERSION, both configurations;
 * the iOS build number is the workflow's run number).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const write = (p, t) => writeFileSync(join(ROOT, p), t);

/** One place a number is written: how to read it and how to replace it. */
const place = (file, re, what) => ({
  file, what,
  get() { const m = re.exec(read(file)); if (!m) throw new Error(`${file}: ${what} not found`); return m[2]; },
  getAll() { return [...read(file).matchAll(new RegExp(re.source, 'g'))].map((m) => m[2]); },
  set(v) { write(file, read(file).replace(new RegExp(re.source, 'g'), (_, a, __, c) => a + v + c)); },
});
// package-lock.json: the root package's own two entries (the first "version" lines of the file).
const lock = (file) => ({
  file, what: 'version',
  getAll() { const t = read(file); const m = /^\{\s*"name": "[^"]+",\s*"version": "([^"]+)"[\s\S]*?"packages": \{\s*"": \{\s*"name": "[^"]+",\s*"version": "([^"]+)"/.exec(t); if (!m) throw new Error(`${file}: root version not found`); return [m[1], m[2]]; },
  get() { return this.getAll()[0]; },
  set(v) {
    let n = 0;
    write(file, read(file).replace(/("version": ")[^"]+(")/g, (s, a, c) => (n++ < 2 ? a + v + c : s)));
  },
});

const DESKTOP = [place('package.json', /("version"\s*:\s*")([^"]+)(")/, 'version'), lock('package-lock.json')];
const MOBILE = [
  place('mobile/package.json', /("version"\s*:\s*")([^"]+)(")/, 'version'), lock('mobile/package-lock.json'),
  place('mobile/android/app/build.gradle', /(versionName ")([^"]+)(")/, 'versionName'),
  place('mobile/ios/App/App.xcodeproj/project.pbxproj', /(MARKETING_VERSION = )([^;]+)(;)/, 'MARKETING_VERSION'),
];
const CODE = place('mobile/android/app/build.gradle', /(versionCode )(\d+)()/, 'versionCode');

function disagreements(places) {
  const seen = places.flatMap((p) => (p.getAll ? p.getAll() : [p.get()]).map((v) => `${v} (${p.file})`));
  return new Set(seen.map((s) => s.split(' ')[0])).size > 1 ? seen : [];
}

const [cmd, value] = process.argv.slice(2);
if (cmd === '--check') {
  const bad = [...disagreements(DESKTOP), ...disagreements(MOBILE)];
  if (bad.length) { console.error('version numbers disagree:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log(`versions agree: desktop ${DESKTOP[0].get()}, mobile ${MOBILE[0].get()} (Android versionCode ${CODE.get()})`);
} else if (cmd === 'desktop' || cmd === 'mobile') {
  if (!/^\d+\.\d+\.\d+$/.test(value ?? '')) { console.error(`usage: node tools/version.mjs ${cmd} X.Y.Z`); process.exit(2); }
  for (const p of cmd === 'desktop' ? DESKTOP : MOBILE) p.set(value);
  if (cmd === 'mobile') CODE.set(String(Number(CODE.get()) + 1));
  console.log(cmd === 'desktop' ? `desktop ${value}` : `mobile ${value} (Android versionCode ${CODE.get()})`);
} else if (!cmd) {
  console.log(`desktop ${DESKTOP[0].get()}\nmobile  ${MOBILE[0].get()} (Android versionCode ${CODE.get()})`);
} else {
  console.error('usage: node tools/version.mjs [desktop X.Y.Z | mobile X.Y.Z | --check]'); process.exit(2);
}
