#!/usr/bin/env python3
"""
Package "GR Mod.app" as a compressed disk image (.dmg) on Linux, without a Mac.

    python3 mkdmg.py "dist/GR Mod.app" dist/GRMod-0.6.1-mac.dmg [--volname "GR Mod 0.6.1"]

The image holds the app and a link to /Applications, opens as a 560x360 icon
window with the app on the left and the link on the right (drag to install).

Needs on PATH (or in $MKFS_HFSPLUS / $HFSPLUS / $DMG):
  mkfs.hfsplus   (Debian/Ubuntu package hfsprogs)
  hfsplus, dmg   (built from https://github.com/mozilla/libdmg-hfsplus)
and the Python packages ds_store and mac_alias (for the window layout).
"""
import argparse, os, shutil, stat, subprocess, sys, tempfile

def tool(env, name):
    p = os.environ.get(env) or shutil.which(name)
    if not p:
        sys.exit(f'mkdmg: {name} not found (set ${env})')
    return p

def tree_size(path):
    total = 0
    for root, dirs, files in os.walk(path):
        for f in files:
            total += os.lstat(os.path.join(root, f)).st_size
    return total

def write_ds_store(path, app_name):
    from ds_store import DSStore
    with DSStore.open(path, 'w+') as d:
        d['.']['bwsp'] = {
            'ShowStatusBar': False, 'ShowToolbar': False, 'ShowTabView': False, 'ShowPathbar': False,
            'ShowSidebar': False, 'ContainerShowSidebar': False, 'SidebarWidth': 0,
            'WindowBounds': '{{200, 140}, {560, 360}}',
        }
        d['.']['icvp'] = {
            'viewOptionsVersion': 1, 'iconSize': 112.0, 'textSize': 13.0, 'gridSpacing': 100.0,
            'gridOffsetX': 0.0, 'gridOffsetY': 0.0, 'labelOnBottom': True, 'showItemInfo': False,
            'showIconPreview': True, 'arrangeBy': 'none', 'backgroundType': 0,
            'backgroundColorRed': 1.0, 'backgroundColorGreen': 1.0, 'backgroundColorBlue': 1.0,
        }
        d['.']['vSrn'] = ('long', 1)
        d[app_name]['Iloc'] = (150, 165)
        d['Applications']['Iloc'] = (410, 165)

def mark_clean(img):
    """Set kHFSVolumeUnmountedBit in both volume headers: hfsplus leaves the volume marked as
    mounted, and macOS would then check the image before attaching it."""
    size = os.path.getsize(img)
    with open(img, 'r+b') as f:
        for off in (1024, size - 1024):
            f.seek(off)
            hdr = f.read(8)
            if hdr[:2] not in (b'H+', b'HX'):
                sys.exit(f'mkdmg: no HFS+ volume header at {off}')
            attrs = int.from_bytes(hdr[4:8], 'big') | 0x100
            f.seek(off + 4)
            f.write(attrs.to_bytes(4, 'big'))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('app'); ap.add_argument('out'); ap.add_argument('--volname', default='GR Mod')
    a = ap.parse_args()
    mkfs, hfsplus, dmg = tool('MKFS_HFSPLUS', 'mkfs.hfsplus'), tool('HFSPLUS', 'hfsplus'), tool('DMG', 'dmg')
    app_name = os.path.basename(os.path.normpath(a.app))
    with tempfile.TemporaryDirectory() as tmp:
        stage = os.path.join(tmp, 'stage'); os.mkdir(stage)
        shutil.copytree(a.app, os.path.join(stage, app_name), symlinks=True)
        write_ds_store(os.path.join(stage, '.DS_Store'), app_name)
        img = os.path.join(tmp, 'image.hfs')
        size = tree_size(stage) + 8 * 1024 * 1024
        size = (size + 1024 * 1024 - 1) // (1024 * 1024) * 1024 * 1024
        with open(img, 'wb') as f:
            f.truncate(size)
        subprocess.run([mkfs, '-v', a.volname, img], check=True, stdout=subprocess.DEVNULL)
        subprocess.run([hfsplus, img, 'addall', stage], check=True, stdout=subprocess.DEVNULL)
        # addall does not carry the permission bits over: give executables their x bits back
        for root, dirs, files in os.walk(stage):
            for f in files:
                p = os.path.join(root, f)
                if os.stat(p).st_mode & stat.S_IXUSR:
                    rel = '/' + os.path.relpath(p, stage)
                    subprocess.run([hfsplus, img, 'chmod', '755', rel], check=True, stdout=subprocess.DEVNULL)
        subprocess.run([hfsplus, img, 'symlink', '/Applications', '/Applications'], check=True, stdout=subprocess.DEVNULL)
        mark_clean(img)
        if os.path.exists(a.out):
            os.remove(a.out)
        subprocess.run([dmg, 'build', img, a.out], check=True, stdout=subprocess.DEVNULL)
    print(a.out, os.path.getsize(a.out))

if __name__ == '__main__':
    main()
