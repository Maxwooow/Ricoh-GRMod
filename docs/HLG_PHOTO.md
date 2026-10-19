# BT.2100 HLG HDR Photo Mod for Ricoh GR IV

> **Feature Branch**: `feat/hlg-photo`  
> **Target Camera**: Ricoh GR IV / GR IV HDF (Firmware 1.11)  
> **Integrated Toolchain**: [Ricoh-GRMod](https://github.com/Maxwooow/Ricoh-GRMod)  
> **Target Slot**: Image Control Slot 22 (`toneId = 22 = 0x16`, "HDR Tone" / HDR色调)

---

## 1. Overview & Motivation

The Ricoh GR IV houses a high-performance 26-megapixel APS-C CMOS sensor delivering over 12 stops of linear dynamic range in RAW capture. However, out-of-camera (OOC) JPEGs in factory firmware are traditionally constrained to 8-bit SDR sRGB, discarding significant highlight information and compressing tonal gradations into a standard dynamic range curve.

The **BT.2100 HLG HDR Photo Mod** enables **in-camera direct BT.2100 HLG (Hybrid Log-Gamma) HDR photo capture**:
- Shoots direct JPEG photos with true wide color gamut (**ITU-R BT.2020**) and high dynamic range (**ARIB STD-B67 / HLG**).
- Zero shutter lag, fully processed in real-time by the camera's hardware Milbeaut ISP.
- Native HDR viewing on Apple displays (XDR / Liquid Retina on iPhone, iPad, Mac), Windows 11 HDR displays, Android HDR galleries, and Chromium-based browsers.
- Fully compatible with RAW+JPEG: RAW DNGs remain unmodified and uncompressed.

---

## 2. Architectural Design: Slot 22 vs. Cinema Slots

Previous experimental implementations hijacked `Cinema Green` (`toneId = 19`). In this integrated GRMod adaptation, the feature is mapped cleanly to **Slot 22 (`HDR Tone` / HDR色调)**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Image Control Slots                               │
├────┬────────────────────┬───────────┬───────────────────────────────────────┤
│ ID │ Name               │ Type      │ Status in HLG Mod                     │
├────┼────────────────────┼───────────┼───────────────────────────────────────┤
│ 11 │ Standard (STD)     │ Factory   │ Untouched (used as neutral reference) │
│ 18 │ Cinema Yellow (CY) │ Factory   │ Untouched (GRMod preset customizable) │
│ 19 │ Cinema Green (CG)  │ Factory   │ Untouched (GRMod preset customizable) │
│ 22 │ HDR Tone           │ Factory   │ Replaced -> BT.2100 HLG HDR Capture   │
│ 34+│ Added Looks        │ Extended  │ 100% Compatible (styles 34..39)       │
└────┴────────────────────┴───────────┴───────────────────────────────────────┘
```

### Why Slot 22?
1. **Preserves Creative Looks**: Slots 18 (`Cinema Yellow`) and 19 (`Cinema Green`) remain 100% available for factory film looks or custom imported `.xmp`/`.cube` LUT presets.
2. **Replaces Gimmick with True HDR**: The factory "HDR Tone" effect is an artificial, heavy local tone-mapping filter that is rarely used for serious photography. Transforming it into true physical BT.2100 HLG provides high practical utility.
3. **Zero ICONBIN Overhead**: Retains the factory HDR Tone icon in `06_ICONBIN.bin`, avoiding unnecessary growth or relocation in the icon section.
4. **Clean UI Naming**: The UI string (Text ID 306) across all 21 camera languages is updated to **"HDR"**.

---

## 3. Image Processing Pipeline & Mathematical Calibration

The mod modifies three stages of the in-camera Milbeaut ISP hardware pipeline plus the JPEG container serialization:

```
[14-bit Bayer Sensor Data]
           │
           ▼
[Milbeaut ISP Pipeline]
    ├─► 1. Pre-Curve Linear Color Correction Matrix (Q13):
    │      M_HLG = M_709_to_2020 @ M_STD (Row sums = 8192)
    │      Row 0: [ 5546,  2769,  -123 ] -> Sum = 8192
    │      Row 1: [  807,  7629,  -244 ] -> Sum = 8192
    │      Row 2: [   -9,  1131,  7070 ] -> Sum = 8192
    │
    ├─► 2. Camera Base Tone Curve S(lin) [0..16383]:
    │      Hardware applies S(lin) before slot tone curve
    │
    ├─► 3. Slot 1D Tone Curve (256 uint16, 14-bit in 0..16383):
    │      Pre-compensated: curve[i] = round(16383 * HLG( S^-1( i * 64 / 16383.0 ) ))
    │      Result: HLG( S^-1( S(lin) ) ) = HLG(lin) (Zero double-curve distortion)
    │
    └─► 4. Neutral Multi-Axis Table:
           T_MA[22] repointed to Standard's neutral maBlock (0x54049DE8)
           │
           ▼
[ExifJpegWriter In-Camera APP2 Injection Hook (0x5380BF50)]
    ├─► Checks active shot toneId == 22
    ├─► Adjusts Pentax APP7 screennail length in m_workArea to terminate cleanly
    ├─► Injects 32-byte aligned APP2 ICC_PROFILE segment (len = 576 = 0x240)
    │   with BT.2100 HLG CICP [9, 18, 0, 1] color profile
    └─► Advances workArea write pointer by 576 bytes
           │
           ▼
[Direct .JPG Output on SD Card]
    ├─► FFD8 (SOI) + FFE1 (Exif & Thumbnail)
    ├─► FFE7 (Pentax Screennail)
    ├─► FFE2 (APP2: BT.2100 HLG CICP [9, 18, 0, 1] ICC Profile)
    └─► DQT + SOF0 + SOS (Scan) + FFD9 (EOI)
```

### 3.1 Pre-Curve Linear Q13 Color Correction Matrix
The sensor primaries are calibrated in Rec.709 space. To convert directly into Rec.2020 wide color gamut in linear light, the hardware CCM is computed by multiplying the factory Standard look matrix ($M_{\text{STD}}$, at `0x54049850`) by the CIE D65 Rec.709-to-Rec.2020 matrix:

$$
M_{709\rightarrow 2020} = \begin{bmatrix}
0.6274039 & 0.3292830 & 0.0433131 \\
0.0690973 & 0.9195404 & 0.0113623 \\
0.0163914 & 0.0880133 & 0.8955953
\end{bmatrix}
$$

Quantized into signed int16 in **Q13 (`8192 = 1.0`)** format with exact unity row sums (to ensure neutral gray remains completely unshifted):
- **Row 0**: `[5546, 2769, -123]` (Sum: `8192`)
- **Row 1**: `[807, 7629, -244]` (Sum: `8192`)
- **Row 2**: `[-9, 1131, 7070]` (Sum: `8192`)

### 3.2 256-Point 14-Bit Tone Curve with $S^{-1}$ Inverse Pre-Compensation
The camera hardware applies an internal sensor base tone curve $S(\text{lin})$ *before* passing pixels into the slot curve:

$$\text{display} = \text{curve\_c}\big(S(\text{lin})\big)$$

If a naive ARIB STD-B67 curve were applied, the signal would suffer from severe midtone crush and highlight distortion due to the compound curves. To solve this, the 256-point table is pre-compensated by evaluating at $E_i = S^{-1}(b_i)$:

$$\text{curve\_c}[i] = \text{round}\Big(16383 \cdot \text{OETF}_{\text{ARIB\_STD\_B67}}\big(S^{-1}(b_i)\big)\Big)$$

Where the ARIB STD-B67 Optical-Electro Transfer Function is:

$$\text{OETF}(E) = \begin{cases}
\sqrt{3E}, & 0 \le E \le \frac{1}{12} \\
a \ln(12E - b) + c, & \frac{1}{12} < E \le 1
\end{cases}$$

$$\text{with } a = 0.17883277,\; b = 0.28466892,\; c = 0.55991073$$

- The table starts at `0` and reaches `16214` at index 255, preserving 14-bit highlight headroom.
- Gamma descriptor `desc[5]` is set to `0` to disable secondary contrast warping.

### 3.3 Neutral Multi-Axis Table
The factory Slot 22 multi-axis block introduces saturated tone shifts. In the mod, `T_MA[22]` is redirected to Standard's neutral multi-axis block (`0x54049DE8`), ensuring pure, uncolored chromatic response.

---

## 4. In-Camera APP2 Injection Hook

Even with Rec.2020 and HLG curve applied, standard JPEG decoders would display the photo washed out as sRGB unless the file is tagged with an accurate color profile.

The mod hooks `ExifJpegWriter::SetupAppNInfo` at virtual address `0x5380BF50`:
1. **Condition Check**: Reads the active shot `toneId` from `[r4, #0x08]` (standard write) or `[r4, #0x0c]` (rewrite/development). If `toneId != 22`, it branches directly to the official instruction without any interference.
2. **APP7 WorkArea Adjustment**: Fixes the length field of the preceding Pentax screennail segment so that the buffer pointer `[r4, #0x50]` is strictly 32-byte aligned.
3. **APP2 Segment Injection**: Writes a 576-byte (`0x240`) JPEG APP2 segment:
   - Marker: `0xFF 0xE2`
   - Length: `0x023E` (574 bytes)
   - Header: `ICC_PROFILE\0\x01\x01` (14 bytes)
   - Payload: 532-byte ICC Profile containing valid `acsp` header and **CICP tag** (`[9, 18, 0, 1]` for Rec.2020 / ARIB STD-B67 / RGB / Full range).
   - Padding: 2 bytes zero pad.
4. **Pointer Advancement**: Advances `[r4, #0x50]` by 576 bytes, allowing subsequent JPEG markers (`DQT`, `SOF0`, `SOS`) to serialize normally.

---

## 5. HDR Tone Level 0 Option & SDR Bypass Architecture

In the camera's image control adjustment menu for Slot 22 ("HDR Tone" / "HDR"), four fine-tuning parameters are provided: **Saturation**, **Hue**, **High/Low Key Contrast**, and **HDR Tone Level** (parameter 17, `HDR Intense`).

### 5.1 Motivation & Behavior
In factory firmware, `HDR Tone Level` only offered options `1`, `2`, and `3`. The mod introduces an additional **Level 0** option:
- **Level 1, 2, 3**: Enables full BT.2100 HLG HDR photo capture (Rec.2020 WCG matrix, ARIB STD-B67 curve, and APP2 CICP ICC profile injection).
- **Level 0**: Completely **bypasses** the HDR Tone effect, producing a clean, standard sRGB SDR JPEG directly from the HDR slot without needing to switch image control profiles.

### 5.2 Dual-Layer Bypass Execution Pipeline

```
[HDR Tone Level Adjustment]
         │
         ├──► Level 0: 
         │      ├─► ISP Dispatch Hook (0x53912D3C): sl = 0 (Standard SDR look)
         │      │     ├─► ToneRecord: Standard Rec.709 linear CCM (0x5501ADBC)
         │      │     ├─► GammaDescriptor: Standard SDR gamma curve
         │      │     └─► Neutral Multi-Axis table
         │      └─► APP2 Hook (0x5380BF50): [r1, #0x7b8] == 0 -> Skip APP2 injection
         │            └─► Output: 100% Standard sRGB SDR JPEG
         │
         └──► Level 1, 2, 3:
                ├─► ISP Dispatch Hook (0x53912D3C): sl = 22 (HLG look)
                │     ├─► ToneRecord: Rec.2020 WCG linear CCM
                │     ├─► GammaDescriptor: ARIB STD-B67 (HLG) curve
                │     └─► Neutral Multi-Axis table
                └─► APP2 Hook (0x5380BF50): [r1, #0x7b8] != 0 -> Inject APP2 CICP ICC
                      └─► Output: Native BT.2100 HLG HDR JPEG
```

### 5.3 Reverse-Engineered Implementation Details

1. **Internal Value Mapping Table (`0x53DBAD84`)**:
   - Factory ROM table: `[1, 2, 3, 0]` (`0x00030201`).
   - Patched to: `[0, 1, 2, 3]` (`0x03020100`).
   - UI option indices `0, 1, 2, 3` map 1:1 to internal parameter values `0, 1, 2, 3`.
2. **Value Count Function (`GetHdrCuisineHdrIntenseValueCount` @ `0x533BEBF8`)**:
   - `0x533BEC24`: `cmp r0, #3` (`0xE3500003`) -> patched to `cmp r0, #4` (`0xE3500004`).
   - `0x533BEC28`: `movls r0, #3` (`0x93A00003`) -> patched to `movls r0, #4` (`0x93A00004`).
   - Expands option step count from 3 to 4, unlocking step `0` on the shooting screen and adjustment menu.
3. **ASCII Text Formatter (`GetImageControlParameterHdrIntenseAscii` @ `0x5339B5F0`)**:
   - Factory logic checked `r2 == 1, 2, 3` and errored on other values.
   - `0x5339B610`: `beq #0x5339B64C` (`0x0A00000D`) -> patched to `bls #0x5339B64C` (`0x9A00000D`).
   - Allows unsigned values `0..3` to be passed to `snprintf(..., "%d")`, displaying `"0"`, `"1"`, `"2"`, `"3"`.
4. **ISP Tone Pipeline Hook (`0x53912D3C`)**:
   - In the hardware ISP dispatch function, register `sl` holds `toneId` and `r7` points to the shot struct (`[r7, #0x7b8]` contains HDR Tone Level).
   - Hook checks: if `sl == 22` and `[r7, #0x7b8] == 0`, it reassigns `sl = 0` (Standard) and updates `[fp, #-0x34] = 0`.
   - The ISP pipeline falls back to Standard SDR matrices and gamma curve.
5. **APP2 Metadata Hook (`0x5380BF50`)**:
   - Checks `[shotStruct, #0x7b8]`. If Level is 0, branches to exit without writing the APP2 marker and payload.

---

## 6. GRMod System Integration

### 5.1 Memory Layout & ROM Mapping
GRMod constructs patches against the ROM image loaded at `0x53000000`. Runtime tables (`T_REC_BASE = 0x55053780`, `T_GAM_BASE = 0x55053138`, `T_MA_BASE = 0x55053504`, `NATIVE_TEXT_ROOTS = 0x55002118`) reside in RAM (`0x55000000..0x55057480`), whose ROM load source is `RAM_SRC = 0x5437B640`.

All pointer updates use the conversion helper:
```ts
export function romVa(va: number): number {
  if (va >= 0x55000000 && va < 0x55057480) {
    return 0x5437b640 + (va - 0x55000000);
  }
  return va;
}
```

### 5.2 Dual-Write Text Catalog
To ensure the name **"HDR"** appears correctly regardless of whether the camera reads from initial RAM tables or GRMod's relocated text catalog:
- Updates `NATIVE_TEXT_ROOTS` rows for Text ID 306 across all 21 languages.
- Updates `TEXT_CATALOG` (`0x543D4AC0`) rows for Text ID 306 across all 21 languages.

### 5.3 Grown Layout & Feature Mask
HLG Photo is registered as a first-class feature in `core/src/fw/aspect/package.ts`:
- Feature Bit: `FEATURE_HLG_PHOTO = 16` (`0x10`).
- Build Revision: Revision 3 (`GRMODAR3`).
- Patcher: `Patch.grows` evaluates to `true` when `hlgPhoto` is enabled, allocating appended space at the end of RTOS and recording `FEATURE_HLG_PHOTO` in the trailer metadata record.
- Self-check: All modified words and appended ranges are tracked in `patch.words` and whitelist ranges, passing `selfCheckGrown` with zero integrity violations.

### 5.4 Feature Combinations
HLG HDR Photo can be enabled independently or in arbitrary combination with other GRMod extensions:
- **Custom Aspect Ratios** (e.g. 65:24, 1:1, 4:3, 16:9, etc.)
- **ADJ Lever Soft Focus** (Off / Weak / Medium / Strong)
- **Shooting Assist Date Imprint** (with on-screen camera menu)
- **Monochrome Looks Unlock** (6 GR IV Monochrome looks on color models)
- **Extra Image Control Slots** (Styles 34..39)
- **Cinema Yellow / Cinema Green Custom LUT Presets**

---

## 6. User Interface & Workflow

### In GRMod Desktop App
1. Connect SD card or open the official `fwdc248b.bin` firmware.
2. In the **Image Control** page, look at the feature switches card below the slots.
3. Toggle the **"HLG HDR 照片" / "HLG HDR Photo"** switch (marked with HDR icon).
4. Export firmware to the SD card or local folder.

### On the Ricoh GR IV Camera
1. Power on the camera, press the **Image Control** button (or access Image Control from the shooting menu).
2. Scroll to the **"HDR"** slot (Slot 22, formerly HDR Tone).
3. Frame and shoot.
4. Transfer the `.JPG` to an HDR-capable device to view the dynamic range.

---

## 7. Display & Viewing Guide

| Platform | Recommended Viewer | Expected HDR Rendering |
| :--- | :--- | :--- |
| **macOS (Apple Silicon)** | Apple Photos, Preview, Finder QuickLook, Safari | Highlights push up to 1000–1600 nits on XDR displays; standard SDR range remains natural. |
| **iOS / iPadOS** | Photos app (iPhone 12 Pro or newer, iPad Pro XDR/OLED) | Native EDR (Extended Dynamic Range) presentation with HDR badge. |
| **Windows 11** | Windows Photos app (HDR display enabled) | Automatic HDR gain map / peak luminance expansion. |
| **Android** | Google Photos (Android 14+ Ultra HDR / HLG support) | Full HDR luminance playback on supported OLED screens. |
| **Browsers** | Chrome, Edge, Safari (with HDR display) | Full BT.2020 WCG and HDR transfer curve interpretation. |

---

## 8. Verification & Test Suite

The mod includes automated unit and integration tests under `core/test/hlg.test.ts`:

```bash
# Run HLG test suite
npx vitest run test/hlg.test.ts

# Run all core tests
npm -w core test

# Compile UI for production
npm -w ui run build
```

### Verified Test Cases:
1. `HLG matrix is valid Q13 with unity row sums`: Verifies 3x3 dimensions and exact 8192 sum per row.
2. `HLG tone curve is 256-point 14-bit monotonic ARIB STD-B67 curve`: Verifies monotonicity, start value 0, and endpoint 16214.
3. `HLG ICC profile contains valid acsp signature and CICP tags`: Verifies valid ICC signature and CICP header.
4. `HLG hook code is valid ARM binary`: Verifies 176-byte machine code integrity.
5. `builds HLG photo standalone and passes self-check`: Verifies standalone generation, `ICONBIN` non-growth, `RTOS` expansion, and `selfCheckGrown` pass.
6. `builds HLG photo combined with custom ratios, soft focus, date stamp, and mono unlock`: Verifies all features combined without address or hook collisions.
