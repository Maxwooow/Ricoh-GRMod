# GR Mod（个人 fork 中文说明）

这是 [Maxwooow/Ricoh-GRMod](https://github.com/Maxwooow/Ricoh-GRMod) 的个人 fork：
**[sjclijie/Ricoh-GRMod](https://github.com/sjclijie/Ricoh-GRMod)**。

GR Mod 是一个桌面工具，用于修改理光 GR IV / GR IV HDF（固件 1.11）的官方固件：
导入 `.xmp` / `.cube` 预设、增加画幅比例、自定义关机图片等。**它不是 Ricoh 官方产品**，
修改固件有风险，请自备官方 1.11 固件并自行承担使用风险。

本 README 以中文说明**本 fork 相对原版改了什么、优化了什么、修了哪些问题**。
原版的完整功能与实现细节（英文）见
[上游 README](https://github.com/Maxwooow/Ricoh-GRMod#readme)。

> **真机验证状态：本 fork 的全部功能均已在真机上安装并测试通过**——包括 Image Control
> 菜单顺序与隐藏、预设拟合精修、色相分区、日期水印与 Look 名称水印。新增 slot 上限保持原版的 6 个。
> 详见 [「真机验证」](#真机验证)。

---

## 一眼看懂：本 fork 相比原版的变化

| 方面 | 原版 | 本 fork |
| --- | --- | --- |
| Image Control 菜单 | 顺序固定，不能隐藏不用的 Look | 可拖拽/箭头调整顺序，可隐藏 Look（含新增 slot） |
| 预设拟合精度 | RGB 最小二乘（CIE76），灰阶/角点权重低 | 加入中性灰、角点、肤色采样，再做 CIEDE2000 感知精修 |
| 新增 slot 的色相 | 复制 Standard 的“中性”多轴区块 | 每个新增 slot 可带自己的 12 分区色相矩阵 |
| 日期水印 | 两种七段数字日期样式 | 新增两种「日期 + Look 名称」样式（Courier Prime Bold） |

前三个改动分别对应上游 PR **#6 / #7 / #8**（截至撰写时都还在 review，尚未合并；
本 fork 的 `main` 已包含它们）。此外本 fork 还扩展了日期水印样式。
上游其余功能全部保留，见下文
[「原版功能」](#原版功能本-fork-全部保留)。

---

## 1. Image Control 菜单顺序与隐藏 Look（PR #6）

### 原版的问题

Image Control 菜单的顺序是固件里写死的：20 个 Look（style 11..30，含黑白机型那些）
按固定顺序全部列出，用户既不能把自己常用的 Look 放到前面，也不能隐藏从来不用的 Look。
菜单很长，切换起来不方便。

### 解决方式：只改数据，不加代码

- **菜单顺序**是一张 20 字节的表，位于 `0x53DBE388`（每个 style 一个字节，对应 11..30）。
  改写这张表就改变了菜单顺序。
- **隐藏 Look** 是把该 Look 在可见性跳转表里的条目改指向固件自带的
  `mov r0, #0 ; bx lr` stub（彩色 Look 用 `0x533CC6F8` → `0x533CC748`，
  黑白 Look 25..30 用 `0x533CC648` → `0x533CC670`）。
- 菜单构建函数 `0x533CC78C` 会按顺序表遍历并跳过隐藏项，因此**列表容量和所有计数常量都保持不变**，
  也不需要往固件里添加任何代码。

### 现在能做什么

- 工厂 Look 和新增 slot（style 34..39）都可以排序、隐藏；
- UI 的 Image Control 页面新增卡片：**拖拽**或**箭头**调整顺序、**眼睛图标**开关显示/隐藏、
  **重置**恢复出厂顺序；
- **Standard（style 11）不能被隐藏**；
- 顺序和隐藏状态保存在 `project.json`（`lookOrder` / `lookHidden`），
  Engine 通过 `BuildOptions.lookLayout` 传入；
- `validateLookLayout` 会拒绝：顺序不完整、重复项、隐藏全部 Look、隐藏 Standard；
- 没有其他改动时原地构建（只改顺序表 + 可见性字）；有新增 slot 等扩容内容时走扩容布局，
  新增 slot 通过 `slots.ts` 已有的可见性 hook 隐藏。

### 验证情况

- 顺序表已在真机验证：顺序 `[12,11,...]` 显示 Vivid 再 Standard；
  `[17,18,11,...]` 显示 Positive Film、Cinema Yellow、Standard。
- 自动化测试覆盖官方 1.11 的顺序/可见性字、新增 slot 排序、隐藏新增 slot、Engine 路径。

> **注意**：如果相机当前的 Image Control（或 U1–U3 组）正指向一个被隐藏的 Look，
> 该设置可能显示空白或回退到别的 Look。安装前请先选一个可见的 Look。

---

## 2. 预设拟合优化：采样与 CIEDE2000 精修（PR #7）

### 原版的问题

导入 `.cube` LUT 或 `.xmp` Look 时，原版用最小二乘 RGB 拟合，把预设“翻译”成相机能存的
「前矩阵 + 3×17 曲线 + 后矩阵」。它有三个问题：

1. **目标函数是 CIE76**（Lab 欧氏距离），对饱和色和肤色不敏感，和“看起来像不像”不一致；
2. **拟合样本缺少纯黑/纯白角点**，中性灰也没有高权重，导致白点/黑点附近偏差明显
   （实测某个 LUT 的纯白应为 0.9995，模型只拟合到约 0.84）；
3. **拟合集就是评估集**，没有独立的 held-out 样本，p95 和最差颜色不可见。

### 解决方式

保留原有的相机模型（不改变固件格式），把拟合流程升级为三步：

1. **更密的初始拟合样本**（`core/src/color/convert.ts`）
   - 原有标定色 + 合成色之外，新增 64 级中性灰阶（重复 6 次以加权重）；
   - 9³ 网格（含 8 个纯色角点）；
   - 4 种肤色 × 5 档曝光（线性光转换后回到 sRGB）。
2. **新增 CIEDE2000**（`core/src/color/math.ts`）
   - `deltaE2000` / `deltaE2000Lab`，按 Sharma、Wu & Dalal (2005) 实现；
   - 论文第一组参考对（2.0425）写入单元测试。
3. **感知精修**（新增 `core/src/color/refine.ts`）
   - 以 RGB 拟合结果为初值，精修同样的 6 个 look 矩阵参数、6 个后矩阵参数
     和 3×17 曲线节点（共 63 个参数）；
   - 目标函数直接是加权 CIEDE2000，用数值差分 Jacobian + Levenberg–Marquardt（8 次迭代）；
   - 精修样本与拟合样本**相互独立**：48 级中性灰（权重 10）、24 色相 × 3 饱和度 × 5 明度
     （权重 8）、5 档曝光肤色（权重 10）、300 个固定种子随机色（权重 2）、7³ 网格（权重 2）；
   - 只有精修确实降低误差时才采用，`post: false` 时完全保留旧行为。

### 效果

12 个现成 LUT，拟合结果对 LUT 的整网格 ΔE00：

| 指标 | 原版 | 本 fork | 变化 |
| --- | --- | --- | --- |
| 平均 ΔE00 | 1.673 | **1.554** | **−7.1%** |
| 平均 p95 | 4.285 | **3.509** | **−18.1%** |

单次拟合（含精修）在 Node 中耗时约 0.2–1.1 秒。导入报告里的 `meanDE` / `p95DE`
仍是 CIE76、但改在更密的拟合集上计算，所以和旧版数值可直接比较。
用该流程导入预设并写入固件的版本已在本 fork 中通过真机验证。

---

## 3. 新增 slot 的色相分区（hue sectors，PR #8）

### 原版的问题

相机固件在“基础色调曲线”之前还有一级 **12 分区色相调整**（相机自己的 hue sector 阶段）。
原版给新增 Image Control slot 的，是直接从 Standard 复制来的“中性”多轴区块——
等于放弃了这个能力。预设拟合得再准，复杂/饱和颜色仍然差一截。

### 解决方式

- **色相模型**（新增 `core/src/color/hue.ts`）
  - 12 个分区、YCbCr 色相查找、D 参数矩阵、Q10 量化；
  - 2160 字节的多轴区块 = 5 份副本 × 12 分区 × 3×3 int32，每个矩阵行和为 1024。
- **相机模型**：`SlotParams` 新增可选的 `hue`（12 个 3×3 矩阵，按颜色色相选择），
  作用在基础色调曲线之前的线性信号上。
- **精修**：`refine.ts` 新增 `refineHue`，在 CIEDE2000 基础精修之后再拟合 12×3 个色相参数；
  只有平均 ΔE00 改善超过 0.5% 才采用。
- **固件**：`ExtraSlotSpec.hueQ10` 让新增 slot 使用自己的多轴区块
  （5 份副本、链接数组、MA 记录），不再是 Standard 的中性区块；
  写入前校验每个值都是 int16、每个矩阵行和为 1024。

### 效果

在 PR #7 的基础上，12 个现成 LUT：

| 指标 | 只有精修（PR #7） | 再加色相分区 | 变化 |
| --- | --- | --- | --- |
| 平均 ΔE00 | 1.554 | **1.304** | **−16%** |
| 平均 p95 | 3.509 | **2.835** | **−19%** |

12 个 LUT 中有 9 个采用了色相阶段。

> **验证**：该多轴区块的固件布局参考 GR4-LUTSmith 已验证过的方法，并已在本 fork 中
> 通过真机验证（安装、启动、拍摄、回放均正常）。

---

## 4. 日期水印样式与 Look 名称水印

### 原版的问题

- 日期水印只有两种七段数字样式（短日期 `'26 10 08` / 长日期 `2026.10.08 17:34`），
  不能把当前使用的 Look 名称一起印在照片上；
- Image Control 最多只能新增 6 个 slot，不同 Look 无法各自带一个水印名称。

### 解决方式

- **新增两种水印样式**：短日期 + Look 名称、短日期 `/` Look 名称；整行使用
  Courier Prime Bold，与原有样式保持同一基线和字距，原有两种七段数字样式保持不变；
- **Look 名称可自定义**：Image Control 的排序/隐藏列表里，每个工厂 Look 和新增 slot
  都有 Watermark 名称输入框（1..32 个可打印 ASCII 字符）。默认跟随英文工厂名 /
  Cinema 名 / slot 名，修改后成为独立标签，重置恢复跟随；标签按稳定的 Look key 保存，
  随排序/隐藏保留，不会重命名相机菜单。名称与字体字形在构建时嵌入固件；
- `frame-style.ts` 与 Halation 共用开发帧捕获，日期水印从帧记录读取样式。

### 验证

- 上述水印样式与自定义名称**已在真机上安装并测试通过**；新增 slot 上限仍为 6 个；
- 菜单、渲染、帧模拟器与固件构建自检均覆盖这些改动。

---

## 原版问题与解决一览

| 原版的问题 | 本 fork 的解决 |
| --- | --- |
| Image Control 菜单顺序写死、不能隐藏 | 改写 20 字节顺序表 + 可见性跳转表，UI 支持排序/隐藏/重置 |
| 拟合目标 CIE76，与观感不一致 | 增加 CIEDE2000 指标与感知精修阶段 |
| 拟合样本缺纯黑/纯白角点、灰阶权重低 | 加入中性灰阶、9³ 角点、肤色样本 |
| 拟合集=评估集，极值误差不可见 | 用独立加权样本集评估与精修 |
| 新增 slot 只有 Standard 的中性色相区块 | 每个 slot 可带自己的 12 分区色相矩阵（可选） |
| 日期水印只能印日期，无法印 Look 名称 | 新增两种「日期 + Look 名称」水印样式，名称可自定义 |

---

## 原版功能（本 fork 全部保留）

以下上游功能均保留（个别有本 fork 的扩展，已注明），细节见
[上游 README](https://github.com/Maxwooow/Ricoh-GRMod#readme)：

- 新增画幅比例（最多 8 个，含 65:24）；
- 柔焦（ADJ 拨杆，Off / Weak / Medium / Strong）；
- 日期水印（开机写入照片，含相机菜单；**本 fork 新增了「日期 + Look 名称」样式**）；
- 黑白 Look 解锁；
- 第二矩阵 / 后曲线；
- 新增 Image Control slot（最多 6 个，style 34..39，
  可带 ASCII 名称、图标、Halation）；
- 在相机里选择关机图片；
- 程序自更新；Windows / macOS / Linux 桌面外壳。

---

## 真机验证

本 fork 的全部功能**已在真机上安装并测试通过**：

- Image Control 菜单顺序与隐藏 Look（含新增 slot）；
- 预设导入与拟合（含 CIEDE2000 精修）；
- 新增 slot 的色相分区；
- 日期水印的新样式、Look 名称水印，以及最多 6 个新增 slot；
- 与上游其他功能（画幅比例、柔焦、黑白 Look、关机图片等）的组合使用。

> 扩展新增 slot 到 7..12 个曾尝试过：构建自检通过，但真机无法开机，已全部回退，上限恢复为 6 个。
> 真机验证不代表零风险：修改固件仍可能导致相机异常，安装前请备份，并了解如何恢复官方固件。

---

## 构建与使用

需要 Node.js 与 Go（外壳）：

```sh
npm install
npm -w ui run build
cd shell && ./build.sh mac      # Windows: ./build.sh windows；Linux: ./build.sh linux
```

产物：`shell/dist/GR Mod.app`（macOS）、`shell/dist/GRMod.exe`（Windows）、
`shell/dist/grmod`（Linux）。

macOS 首次启动会被 Gatekeeper 拦截：到“系统设置 › 隐私与安全性”点“仍要打开”，
或执行一次：

```sh
xattr -dr com.apple.quarantine "/Applications/GR Mod.app"
```

程序不包含 Ricoh 固件：需要你自备官方 1.11 固件，或让程序从 Ricoh 官网下载
（Ricoh 页面说明下载即表示接受其软件许可协议）。

## 测试

```sh
npm -w core test                 # 核心测试
cd shell && go test ./... && go test -tags desktop ./...
```

- 部分字节一致性测试需要私有官方固件 `core/testdata/private/official.bin`（仓库不附带），
  缺文件时相关测试会跳过/失败，属正常现象；
- 本 fork 新增的测试覆盖：菜单顺序/可见性字、拟合采样与精修、CIEDE2000 参考对、
  色相分区矩阵与 slot 构建、日期水印样式与名称、1..6 个 slot 的参数记录。

## 已知问题与限制

- 三个功能 PR（#6 / #7 / #8）仍在上游 review，尚未合并；本 fork 的 `main` 已包含。
- 日期水印样式与 Look 名称水印的改动目前只在本 fork，尚未提交上游 PR。
- 隐藏 Look 后，若当前设置指向被隐藏的 Look，可能显示空白或回退，安装前请先选可见 Look。
- 只针对固件 1.11（GR IV / GR IV HDF），其他固件版本不要混用。
- 修改固件有风险；建议先备份、按官方流程升级/回退。

## 许可证与致谢

本项目沿用上游的 **GNU General Public License v2.0 only（GPL-2.0-only）**，全文见 `LICENSE`。
分发给他人时，必须同时提供同样许可证下的完整源代码。

- 上游项目与作者：[Maxwooow/Ricoh-GRMod](https://github.com/Maxwooow/Ricoh-GRMod)；
- 画幅比例编译器移植自 [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool)
  （GPL-2.0-only）；
- 黑白 Look 参考 [lemonadesaltbagel/GR4-MonoUnlock](https://github.com/lemonadesaltbagel/GR4-MonoUnlock)
  的方法（未包含其代码）；
- 色相分区方法参考 GR4-LUTSmith（GPL-3.0，仅方法参考，本仓库为独立实现）；
- 拟合流程参考 DARKSLIDE GR / gr3-film-mods（MIT）的公开方法；
- 示例图片 `ui/src/assets/preview.jpg`（DPReview 工作室样片，经授权使用）不在代码许可证范围内；
  Ricoh 固件也不属于本仓库。