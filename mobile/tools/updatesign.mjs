#!/usr/bin/env node
// Signs the Android app's update manifest, as shell/tools/updatesign does for the desktop's update.json and with
// the same key (a file holding the base64 Ed25519 seed; never part of the repository).
//
//   node mobile/tools/updatesign.mjs -key PATH -apk GRMod-Android-X.Y.Z.apk -tag vA.B.C \
//        -notes-zh "…" -notes-en "…" -out DIR
//
// writes DIR/update-android.json and DIR/update-android.json.sig. Version and versionCode are read from the APK's
// name and from mobile/package.json / android/app/build.gradle; the APK's address is the GitHub release of -tag.
// Both files and the APK go into that release (the app reads them from the latest release).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';

const here = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];
for (const k of ['key', 'apk', 'tag', 'out']) if (!args[k]) { console.error(`updatesign: -${k} is required`); process.exit(2); }

const PUBLIC = 'SmDyXQIIsZYfZ06bPIdeuzDMvpT4FbELxGu9BuCVx+I='; // shell/updates.go
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const gradle = readFileSync(join(here, '..', 'android', 'app', 'build.gradle'), 'utf8');
const versionCode = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1]);
const version = pkg.version;
const name = basename(args.apk);
if (name !== `GRMod-Android-${version}.apk`) { console.error(`updatesign: the APK should be named GRMod-Android-${version}.apk`); process.exit(2); }

const apk = readFileSync(args.apk);
const manifest = {
  app: 'GRMod-Android',
  version,
  versionCode,
  date: new Date().toISOString().slice(0, 10),
  notes: { zh: args['notes-zh'] || '', en: args['notes-en'] || '' },
  page: `https://github.com/Maxwooow/Ricoh-GRMod/releases/tag/${args.tag}`,
  file: {
    name,
    url: `https://github.com/Maxwooow/Ricoh-GRMod/releases/download/${args.tag}/${name}`,
    size: statSync(args.apk).size,
    sha256: createHash('sha256').update(apk).digest('hex'),
  },
};
const data = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
const seed = Buffer.from(readFileSync(args.key, 'utf8').trim(), 'base64');
if (seed.length !== 32) { console.error('updatesign: the key file must hold a base64 Ed25519 seed'); process.exit(2); }
const sig = await ed.signAsync(data, seed);
const pub = await ed.getPublicKeyAsync(seed);
if (Buffer.from(pub).toString('base64') !== PUBLIC) { console.error('updatesign: this is not the key the app checks with'); process.exit(1); }
if (!(await ed.verifyAsync(sig, data, pub))) { console.error('updatesign: the signature does not verify'); process.exit(1); }
mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, 'update-android.json'), data);
writeFileSync(join(args.out, 'update-android.json.sig'), Buffer.from(sig).toString('base64') + '\n');
console.log(`update-android.json  ${version} (${versionCode})  ${manifest.file.size} bytes  sha256 ${manifest.file.sha256}`);
