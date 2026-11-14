// The Android app's update manifest (ui/src/update-android.ts): signature, fields, versions.
import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { compareVersions, findUpdate, verifyManifest } from '../../ui/src/update-android';

const b64 = (u) => Buffer.from(u).toString('base64');
const seed = new Uint8Array(32).map((_, i) => i * 7 + 1);
const manifest = (over = {}) => JSON.stringify({
  app: 'GRMod-Android', version: '0.3.9', versionCode: 22, notes: { zh: '修复', en: 'Fixes' },
  file: { name: 'GRMod-Android-0.3.9.apk', url: 'https://github.com/Maxwooow/Ricoh-GRMod/releases/download/v0.8.14/GRMod-Android-0.3.9.apk', size: 1234, sha256: 'a'.repeat(64) },
  ...over,
}, null, 2);
const sign = async (text) => b64(await ed.signAsync(new TextEncoder().encode(text), seed));

describe('Android update manifest', async () => {
  const key = b64(await ed.getPublicKeyAsync(seed));
  it('takes a manifest signed with the key', async () => {
    const t = manifest();
    expect((await verifyManifest(t, await sign(t), key))?.version).toBe('0.3.9');
  });
  it('refuses a changed manifest, a foreign key and a bad signature', async () => {
    const t = manifest();
    const sig = await sign(t);
    expect(await verifyManifest(t.replace('1234', '1235'), sig, key)).toBeNull();
    expect(await verifyManifest(t, sig)).toBeNull(); // the project's key: not this test key
    expect(await verifyManifest(t, 'abc', key)).toBeNull();
    expect(await verifyManifest(t, '', key)).toBeNull();
  });
  it('refuses files that are not on the project\'s releases, or odd fields', async () => {
    for (const file of [
      { name: 'x.apk', url: 'https://evil.example/x.apk', size: 1, sha256: 'a'.repeat(64) },
      { name: 'x.apk', url: 'https://github.com/someone/else/releases/download/v1/x.apk', size: 1, sha256: 'a'.repeat(64) },
      { name: 'x.apk', url: 'https://github.com/Maxwooow/Ricoh-GRMod/releases/download/v1/x.apk', size: 0, sha256: 'a'.repeat(64) },
      { name: 'x.apk', url: 'https://github.com/Maxwooow/Ricoh-GRMod/releases/download/v1/x.apk', size: 1, sha256: 'zz' },
    ]) {
      const t = manifest({ file });
      expect(await verifyManifest(t, await sign(t), key)).toBeNull();
    }
    const t = manifest({ app: 'GRMod' });
    expect(await verifyManifest(t, await sign(t), key)).toBeNull();
  });
  it('compares versions as numbers', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('0.3.8', '0.3.8')).toBe(0);
    expect(compareVersions('0.3.8', '0.4')).toBe(-1);
    expect(compareVersions('1.0', '0.9.9')).toBe(1);
  });
  it('finds nothing when the latest release has no Android files', async () => {
    const fetcher = async () => { throw new Error('404'); };
    expect(await findUpdate('0.3.8', fetcher)).toBeNull();
  });
  it('passes network trouble on', async () => {
    const fetcher = async () => { throw new Error('timeout'); };
    await expect(findUpdate('0.3.8', fetcher)).rejects.toThrow('timeout');
  });
});
