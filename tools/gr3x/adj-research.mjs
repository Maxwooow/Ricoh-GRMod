// SPDX-License-Identifier: GPL-2.0-only
// An explicitly named offline package. It is never copied to a camera/card.
import { registerHooks } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
const [input, directory, ...extra] = process.argv.slice(2);
if (!input || !directory || extra.length) {
  console.error('Usage: node tools/gr3x/adj-research.mjs OFFICIAL.bin NEW-output-directory');
  process.exit(2);
}
const { buildGr3xResearchContainer } = await import('../../core/src/fw/gr3x/research-package.ts');
const result = await buildGr3xResearchContainer(new Uint8Array(await readFile(input)));
const target = resolve(directory);
await mkdir(target); // Do not reuse an existing directory or replace any prior artifact.
await writeFile(join(target, 'GR3x-1.60-ADJ9.NOT-FOR-CAMERA.bin'), result.bytes, { flag: 'wx' });
await writeFile(join(target, 'patch-manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, 'build-report.json'), JSON.stringify(result.report, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, '请先阅读.txt'),
  '这是 GR IIIx 1.60 的本地工程验证固件容器，不是可刷成品。\n' +
  '已接入 ADJ 九画幅、图像字段、取景、AF/AE、显影及回放的适配。\n' +
  '未验证实机启动、设置保存、AF/AE/ISP、JPEG/RAW 完整拍摄和回放。\n' +
  '如需生成固定九画幅的实机测试候选文件，使用 tools/gr3x/build-test.mjs 并完成全部离线检查。\n' +
  '不要改名为 fwdc243b.bin，不要复制到相机或存储卡。\n' +
  '完整性检查结果与未完成项目见 build-report.json；没有改动后滚轮。\n', { flag: 'wx' });
console.log(JSON.stringify({ directory: target, ...result.report, checks: Object.keys(result.report.checks).length, ranges: result.report.ranges.length }));
