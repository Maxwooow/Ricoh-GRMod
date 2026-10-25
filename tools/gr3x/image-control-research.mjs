// SPDX-License-Identifier: GPL-2.0-only
// Generates a guarded ARM experiment manifest only. No firmware/container output.
import { registerHooks } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (original) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        try { return next(specifier + suffix, context); } catch { /* try next */ }
      }
    }
    throw original;
  }
} });
const [input, directory, cubeFile, ...extra] = process.argv.slice(2);
if (!input || !directory || extra.length) {
  console.error('Usage: node tools/gr3x/image-control-research.mjs OFFICIAL.bin NEW-output-directory [sRGB-display.cube]');
  process.exit(2);
}
const { buildGr3xLookMenuResearch } = await import('../../core/src/fw/gr3x/image-control-research.ts');
const { importGr3xCube } = await import('../../core/src/color/gr3x-import.ts');
const names = ['Film Import 1', 'Film Import 2', 'M Standard', 'M Solid', 'M Soft', 'M High Contrast', 'M Grainy', 'M HDR'];
const manifest = await buildGr3xLookMenuResearch(new Uint8Array(await readFile(input)),
  names.map((name, i) => ({ name, source: i < 2 ? 'cube' : 'gr4m-research' })));
const imported = cubeFile ? await importGr3xCube(await readFile(cubeFile, 'utf8'), 'srgb-display') : null;
const target = resolve(directory);
await mkdir(target);
await writeFile(join(target, 'menu-research.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
if (imported) await writeFile(join(target, 'cube-source.json'), JSON.stringify(imported, null, 2) + '\n', { flag: 'wx' });
const report = {
  schema: 1, stage: 'offline-menu-experiment', firmwareGenerated: false,
  cameraUpdateCandidate: false, flashable: false, renderingImplemented: false,
  originalLookCount: 12, addedLookCount: manifest.addedLooks.length,
  originalLooksPreservedInMenu: true,
  namesAndOptionalLogos: 'catalog implementation; native probe required',
  cube: imported ? { sha256: imported.sourceSha256, size1D: imported.size1D, size3D: imported.size3D,
    firmwareEncoding: imported.firmwareEncoding } : null,
  blockers: manifest.blockers,
};
await writeFile(join(target, 'status.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, '说明.txt'),
  '这是 T5 开发中的离线菜单及导入验证资料，不是固件。\n' +
  '新增名字、图标和菜单项已编写；尚未接通 IIIx 色彩成像和保存流程。\n' +
  'M 开头的六项只是 GR IV Monochrome 移植工作的菜单占位，不能用于判断成像效果。\n' +
  'CUBE 如有导入，保留完整原文及校验值；软件预览不等于相机已支持此 LUT。\n' +
  '本工具不会生成 fwdc243b.bin，也不会写入 SD 卡或替换本地 GR Mod。\n', { flag: 'wx' });
console.log(JSON.stringify({ directory: target, ...report }));
