<div align="center">
  <img src="apps/web/public/icon.svg" width="96" height="96" alt="T·Grid Logo" />
  <h1>T·Grid — TextGrid Editor</h1>
  <p>面向语言学与语音学研究的现代 <strong>Praat TextGrid / Collection</strong> 可视化标注编辑器与出版级插图导出工具</p>

  <p>
    <a href="https://kasumikitsune.github.io/tgrid/" title="直接通过浏览器在线打开 T·Grid（本地运行不上传音频）"><img src="docs/pictures/btn-web-online.svg" alt="在线使用（网页版）" height="42" /></a>
    &nbsp;&nbsp;
    <a href="https://kasumikitsune.github.io/tgrid/tgrid-standalone.html" title="下载内联 WASM 的单文件离线 HTML，双击即可离线使用"><img src="docs/pictures/btn-web-singlefile.svg" alt="离线单文件 HTML" height="42" /></a>
  </p>
  <p>
    <a href="https://github.com/KasumiKitsune/tgrid/releases/latest" title="前往 Releases 下载 Windows 64位安装包"><img src="docs/pictures/btn-download-win.svg" alt="Windows 安装包" height="42" /></a>
    &nbsp;&nbsp;
    <a href="https://github.com/KasumiKitsune/tgrid/releases/latest" title="前往 Releases 下载 macOS Apple Silicon (M1-M4) DMG"><img src="docs/pictures/btn-download-mac-arm.svg" alt="macOS (Apple 芯片)" height="42" /></a>
    &nbsp;&nbsp;
    <a href="https://github.com/KasumiKitsune/tgrid/releases/latest" title="前往 Releases 下载 macOS Intel (x86_64) DMG"><img src="docs/pictures/btn-download-mac-intel.svg" alt="macOS (Intel 旧款)" height="42" /></a>
  </p>
</div>

> [!NOTE]
> **纯本地运行 · 零数据上传**
>
> 无论是桌面端、GitHub Pages 在线版还是单文件离线 HTML，所有音频与标注文件均通过 Rust（原生或 WebAssembly）在您的设备本地完成解析与渲染，不会上传至任何服务器。

---

## 开放规范与开发者复用（Open Specifications）

如果你正在开发自己的语音标注工具、语料库检索平台、音系学教学网站或 Praat 生态软件，**非常欢迎直接复用本项目的可视化方案与文件解析规范**。本仓库附带两份完全**平台无关**的独立技术规范文档（不绑定任何前端框架或界面实现）：

<div align="center">
  <p>
    <a href="docs/TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md" title="阅读 TextGrid 可视化与交互编辑规范"><img src="docs/pictures/btn-spec-viz.svg" alt="可视化与交互编辑规范" height="42" /></a>
    &nbsp;&nbsp;
    <a href="docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md" title="阅读 Praat TextGrid 与 Collection 文件格式规范"><img src="docs/pictures/btn-spec-format.svg" alt="Praat 文件格式规范" height="42" /></a>
  </p>
</div>

| 规范文档 | 适用场景与核心内容 |
| :--- | :--- |
| **[TextGrid 可视化与交互编辑规范](docs/TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md)** | 完整阐述「上轨 1:1 物理时间 → 梯形投影映射颈 → 下轨按字宽自适应展开」双轨可视化架构、多行折行与跨行续接、长静默折叠、语义色系分离、异常结构诊断（空隙/重叠/零时长/越界）及交互模型；**不限定实现技术栈（Web / Qt / Python / Rust / Electron 皆可自由实现）**。 |
| **[Praat `.TextGrid` 与 `.Collection` 文件格式规范](docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md)** | 逐字节对照 Praat C++ 源码核验的完整编解码规范，覆盖标准长文本（`ooTextFile`）、短文本、按时间排序文本、二进制（`ooBinaryFile` 含 UTF-16BE + UTF-32 码点数、布尔字节、大端 IEEE-754）、独立单层与嵌套 `Collection`，适合独立实现 100% 兼容 Praat 的读写器。 |

此外，本仓库的 Rust 核心库（`crates/tg-core`、`crates/tg-dsp`）与微动效图标库（`packages/tgrid-icons`）均采用宽松的 **MIT 协议**开源，欢迎直接引用、移植或作为参考实现。

---

## 核心特性

- **完整兼容 Praat 文件格式**
  - 原生 Rust 编解码器完整读写标准长文本、短文本、按时间排序文本、二进制 `ooBinaryFile`、独立单层（`IntervalTier` / `TextTier`）及嵌套 `Collection` 集合。
  - 自动检测并可视化空隙、同层重叠、零时长区间、越界时间域与 `< 5 ms` 极短音段，支持一键规范整理。
- **双轨自适应排版与声学分析**
  - 支持「自适应宽度（短音素按字宽展开、长静默自动折叠）」与「1:1 线性对齐」自由切换，多行自动折行且保留跨行续接引导。
  - 内置 Rust 声学引擎：WAV 解码、宽带语谱图、基频（$F_0$）与共振峰（$F_1\text{–}F_3$）轨迹显示、拖拽边界 `±40 ms` 声学微距放大镜、跨层磁吸对齐（`Alt` 临时跳过、`Z` 吸附过零点）以及语谱图悬停时间/频率读数。
- **高效标注与国际音标输入**
  - 顶栏 Chrome 风格多标签页与多会话音频缓存；Office 风格右侧可拖宽/可折叠任务窗格（属性 / 层级 / 设置），支持在「侧边栏」与「画布浮动条」间切换，只读模式严格防误改。
  - 内置双方案 IPA 输入法（**云龙国际音标 647 词条 + 五度声调**、**Praat `Longchar_database` 408 项三字符编码**）与可停靠/悬浮的 5 标签虚拟音标键盘，支持整文档 Unicode IPA ↔ Praat `\xx` 批量互转。
- **出版级插图导出工作台**
  - 独立离屏渲染管线，支持滚轮缩放预览、层与时段筛选、论文单栏/通栏/单行版幅、暖灰原色与严格零彩色的纯黑白印刷配色。
  - 提供 **4 种 SVG 语谱图策略**（纯矢量等值轮廓、图文分离 `.zip` 包、仅留声学曲线、单文件 `<defs>` 内嵌）与 `2× / 3× / 6×` 真实重绘高清 PNG，内置按需裁剪的中英双语学术图例栏。

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
│   ├── TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md
│   └── pictures/             # README 下载与文档入口矢量按钮
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

# 运行 Rust 单元测试
npm run test:rust

# 启动网页开发服务器
npm run dev:web

# 构建网页版 + 单文件离线 HTML（产物位于 apps/web/dist 与 apps/web/dist-singlefile）
npm run build:all-web

# 编译 Windows 独立 Release 可执行文件
npm run build:desktop-exe
```

---

## English Summary

**T·Grid** is an open-source, local-first Praat `.TextGrid` and `.Collection` annotation editor and publication-grade figure exporter built with **Rust** (`tg-core`, `tg-dsp`, `tg-wasm`, Tauri v2) and **React + TypeScript**.

- **Open Specifications for Developers**: Feel free to adopt our platform-agnostic [TextGrid Visualization & Editor Spec](docs/TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md) and byte-accurate [Praat TextGrid & Collection Format Spec](docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md) in your own linguistics/speech tools.
- **Try Online**: [kasumikitsune.github.io/tgrid](https://kasumikitsune.github.io/tgrid/) · [Offline Single-File HTML](https://kasumikitsune.github.io/tgrid/tgrid-standalone.html)
- **Desktop Installers (Windows x64 & macOS Apple Silicon / Intel)**: [GitHub Releases](https://github.com/KasumiKitsune/tgrid/releases/latest)

## License

[MIT](./LICENSE)
