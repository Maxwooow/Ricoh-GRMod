# 发布新版本 / Releasing

中文在前，English below.

## 步骤

1. **改版本号。** 从 0.9.0 起，电脑版和手机版（Android / iOS）使用同一个版本号：

   ```sh
   node tools/version.mjs all 0.9.1         # 安卓的 versionCode 自动加 1
   ```

   不要手工改 `package.json`、`build.gradle` 或 Xcode 工程，脚本会一起改好。
2. **检查。** `npm run check && npm run typecheck && npm test`，再跑 `shell` 的测试。改动涉及 `core/` 时，要放好
   官方固件文件再跑一遍（见 [development.md](development.md)），并在相机上实测。
3. **合并到 `main`**，等 GitHub 上的 Tests 通过。
4. **打包。** 在 GitHub 的 Actions › Packages 里点 Run workflow（或推送标签 `v0.9.1`）。完成后下载两个产物：
   - `packages-desktop`：`GRMod-0.9.1.exe`、`GRMod-0.9.1-mac.zip`、`GRMod-0.9.1-mac.dmg`
   - `packages-android`：`GRMod-Android-0.9.1.apk`（仓库没有配置签名密钥时是 `-unsigned.apk`，需要在本机签名）

   也可以在本机打包：`cd shell && ./build.sh windows && ./build.sh mac`，`cd mobile && npm run apk:release`。
5. **签名在线更新清单。** 私钥只在你自己的电脑上，不交给 GitHub：

   ```sh
   cd shell
   go run ./tools/updatesign -key 私钥文件 -version 0.9.1 -notes-zh "……" -notes-en "..." \
       -windows GRMod-0.9.1.exe -mac GRMod-0.9.1-mac.zip -out release
   node ../mobile/tools/updatesign.mjs -key 私钥文件 -apk GRMod-Android-0.9.1.apk -tag v0.9.1 \
       -notes-zh "……" -notes-en "..." -out release
   ```

   得到 `update.json`、`update.json.sig`、`update-android.json`、`update-android.json.sig`。
6. **发布。** 在 GitHub 新建 Release（标签 `v0.9.1`，设为 latest），上传第 4、5 步的全部文件和 dmg。说明文字
   先中文，再一行 `---`，再 `# English`（程序按这个格式取对应语言的更新内容）。
7. **iOS。** 把 `ios` 分支快进到 `main` 并推送，GitHub 会构建并上传到 TestFlight；然后在 App Store Connect 提交审核。

## 注意

- 已安装的程序只在 `releases/latest/download/` 找更新，所以新 Release 必须是 latest，而且清单和签名文件名不能改。
- 清单签的是文件的大小和 SHA-256：第 5 步之后不要再重新打包，否则要重新签名。
- 更新私钥丢失后，所有已安装的电脑版和安卓版都无法再在线更新。请离线备份。

---

# English

## Steps

1. **Set the version number.** Since 0.9.0 the desktop program and the phone app (Android / iOS) share one:

   ```sh
   node tools/version.mjs all 0.9.1         # Android's versionCode goes up by one
   ```

   Do not edit `package.json`, `build.gradle` or the Xcode project by hand: the script changes them together.
2. **Check.** `npm run check && npm run typecheck && npm test`, and the shell's tests. When `core/` changed, run
   them again with the official firmware files in place (see [development.md](development.md)) and test on a camera.
3. **Merge into `main`** and wait for the Tests workflow.
4. **Build the packages.** Actions › Packages › Run workflow (or push the tag `v0.9.1`). Download its artifacts:
   - `packages-desktop`: `GRMod-0.9.1.exe`, `GRMod-0.9.1-mac.zip`, `GRMod-0.9.1-mac.dmg`
   - `packages-android`: `GRMod-Android-0.9.1.apk` (`-unsigned.apk` when the repository has no signing key in
     its secrets: sign it locally)

   Or build locally: `cd shell && ./build.sh windows && ./build.sh mac`, `cd mobile && npm run apk:release`.
5. **Sign the update manifests.** The private key stays on your own computer and is never given to GitHub:

   ```sh
   cd shell
   go run ./tools/updatesign -key KEYFILE -version 0.9.1 -notes-zh "……" -notes-en "..." \
       -windows GRMod-0.9.1.exe -mac GRMod-0.9.1-mac.zip -out release
   node ../mobile/tools/updatesign.mjs -key KEYFILE -apk GRMod-Android-0.9.1.apk -tag v0.9.1 \
       -notes-zh "……" -notes-en "..." -out release
   ```

   This gives `update.json`, `update.json.sig`, `update-android.json` and `update-android.json.sig`.
6. **Publish.** Create the GitHub release (tag `v0.9.1`, marked latest) with every file of steps 4 and 5 and the
   dmg. Write the notes in Chinese first, then a line `---`, then `# English` (the programs take their
   language's part from this layout).
7. **iOS.** Fast-forward the branch `ios` to `main` and push: GitHub builds it and uploads it to TestFlight; then
   submit it for review in App Store Connect.

## Notes

- Installed copies look for updates under `releases/latest/download/` only, so the new release must be the
  latest one and the manifest and signature files must keep their names.
- The manifest signs each file's size and SHA-256: do not rebuild after step 5, or sign again.
- Without the update key no installed desktop or Android copy can ever update itself again. Keep an offline backup.
