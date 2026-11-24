<p align="center">
  <img src="./apps/web/public/icon.svg" width="84" height="84" alt="T·Grid Logo" />
</p>

<h1 align="center">T·Grid — TextGrid Editor</h1>

<p align="center">
  面向语言学与语音学研究的现代 <strong>Praat TextGrid / Collection</strong> 可视化标注编辑器与出版级插图导出工具<br />
  <sub>Rust 核心 · React 界面 · 桌面端（Windows / macOS）· 在线网页版 · 离线单文件 HTML</sub>
</p>

<p align="center">
  <a href="https://kasumikitsune.github.io/tgrid/"><strong>在线使用（GitHub Pages）</strong></a> ·
  <a href="https://kasumikitsune.github.io/tgrid/tgrid-standalone.html">下载离线单文件 HTML</a> ·
  <a href="https://github.com/KasumiKitsune/tgrid/releases">桌面端安装包（Releases）</a> ·
  <a href="./docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md">Praat 格式规范</a>
</p>

---

## 核心特性

- **完整兼容 Praat 文件格式**
  - 原生 Rust 编解码器（`tg-core`）完整支持标准长文本（`ooTextFile`）、短文本、按时间排序文本、二进制（`ooBinaryFile`，含 UTF-16BE + UTF-32 码点数与大端 IEEE-754）、单层文件（`IntervalTier` / `TextTier`）及嵌套 `Collection` 集合。
  - 自动检测并可视化空隙、同层重叠、零时长区间、越界时间域与 `< 5 ms` 极短音段，支持一键规范整理。
- **双轨自适应排版与声学分析**
  - 支持「自适应宽度（按字宽展开短音素并折叠长静默）」与「1:1 线性对齐」自由切换，多行自动折行且保留跨行续接引导。
  - 内置 Rust 声学引擎（`tg-dsp`）：WAV 解码、宽带语谱图、基频（$F_0$）与共振峰（$F_1\text{–}F_3$）轨迹显示、拖拽边界 `±40 ms` 声学微距放大镜、跨层磁吸对齐（`Alt` 临时跳过、`Z` 吸附过零点）以及语谱图悬停时间/频率读数。
- **高效标注与国际音标输入**
  - 顶栏 Chrome 风格多标签页与多会话音频缓存；Office 风格右侧可拖宽/可折叠任务窗格（属性 / 层级 / 设置），支持在「侧边栏」与「画布浮动条」间切换，只读模式严格防误改。
  - 内置双方案 IPA 输入法（**云龙国际音标 647 词条 + 五度声调**、**Praat `Longchar_database` 408 项三字符编码**）与可停靠/悬浮的 5 标签虚拟音标键盘，支持整文档 Unicode IPA ↔ Praat `\xx` 批量互转。
- **出版级插图导出工作台**
  - 独立离屏渲染管线，支持滚轮缩放预览、层与时段筛选、论文单栏/通栏/单行版幅、暖灰原色与严格零彩色的纯黑白印刷配色。
  - 提供 **4 种 SVG 语谱图策略**（纯矢量等值轮廓、图文分离 `.zip` 包、仅留声学曲线、单文件 `<defs>` 内嵌）与 `2× / 3× / 6×` 真实重绘高清 PNG，内置按需裁剪的中英双语学术图例栏。
- **纯本地隐私与三形态分发**
  - 所有音频与标注均在本地完成解析与渲染，不向任何服务器上传数据。
  - 同一套代码同时构建 **Windows / macOS（Apple Silicon & Intel）原生桌面应用**、**GitHub Pages 在线版**，以及内联 Rust WASM 的 **单文件离线 HTML**（双击 `file://` 即可运行）。

---

## 仓库结构

```text
tgrid/
├── crates/
│   ├── tg-core/              # Praat 编解码、切片诊断、IPA 双方案引擎、Marching Squares 等值轮廓、ZIP 打包
│   ├── tg-dsp/               # WAV 解码、FFT/STFT 语谱图、F0 基频、LPC 共振峰与多会话缓存
│   └── tg-wasm/              # WebAssembly 绑定（供网页版与离线单文件 HTML 调用）
├── packages/
│   └── tgrid-icons/          # @tgrid/icons 独立微动效 SVG 图标库与硬件光标资源
├── apps/
│   ├── web/                  # React 19 + TypeScript + Vite 前端（构建在线版与单文件离线 HTML）
│   └── desktop/              # Tauri v2 桌面端外壳（Windows NSIS / macOS DMG）
├── docs/
│   ├── PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md
│   └── TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md
└── .github/workflows/
    ├── pages.yml             # 推送 main 自动发布 GitHub Pages 与单文件离线版
    └── release.yml           # 推送 v* 标签自动打包 macOS (Apple Silicon / Intel) 与 Windows 安装包
```

---

## 本地开发与构建

需要环境：**Node.js 22+**、**Rust (stable)** 与 `wasm32-unknown-unknown` 目标：

```bash
rustup target add wasm32-unknown-unknown
npm install

# 运行 Rust 单元测试（含极端 Praat 样例往返校验与声学 DSP 测试）
npm run test:rust

# 启动网页开发服务器
npm run dev:web

# 构建网页版 + 单文件离线 HTML（产物在 apps/web/dist 与 apps/web/dist-singlefile）
npm run build:all-web

# 编译 Windows 独立 Release 可执行文件
npm run build:desktop-exe
```

---

## English Summary

**T·Grid** is an open-source, local-first Praat `.TextGrid` and `.Collection` annotation editor and publication-grade figure exporter built with **Rust** (`tg-core`, `tg-dsp`, `tg-wasm`, Tauri v2) and **React + TypeScript**.

- Full Praat Long Text, Short Text, Chronological, Binary (`ooBinaryFile`), standalone Tier, and `Collection` read/write support.
- Adaptive & 1:1 linear multi-band layout, broadband spectrogram, $F_0$ pitch, $F_1\text{–}F_3$ formants, cross-tier magnetic snapping, zero-crossing snap, and a `±40 ms` acoustic micro-loupe.
- Dual-scheme IPA input (Yunlong + Praat `\xx` trigraphs) and interactive virtual IPA keyboard.
- Offscreen publication figure exporter: pure-vector contour SVG, external-raster `.zip` bundle, curves-only SVG, embedded-`<defs>` SVG, true `2×/3×/6×` PNG, 100% achromatic monochrome print mode, and bilingual ZH/EN academic legends.
- Try it online at [kasumikitsune.github.io/tgrid](https://kasumikitsune.github.io/tgrid/) or download native Windows / macOS installers from [Releases](https://github.com/KasumiKitsune/tgrid/releases).

## License

[MIT](./LICENSE)
