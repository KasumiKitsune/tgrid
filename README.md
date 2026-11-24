<div align="center">
  <img src="apps/web/public/icon.svg" width="96" height="96" alt="T·Grid Logo" />
  <h1>T·Grid — TextGrid Editor</h1>
  <p>面向语言学与语音学研究的现代 <strong>Praat TextGrid / Collection</strong> 可视化标注编辑器与出版级插图导出工具</p>

  <p>
    <a href="https://github.com/KasumiKitsune/tgrid/releases/latest" title="前往 Releases 下载 Windows 64位安装包"><img src="docs/pictures/btn-download-win.svg" alt="Windows 安装包" height="42" /></a>
    &nbsp;&nbsp;
    <a href="https://github.com/KasumiKitsune/tgrid/releases/latest" title="前往 Releases 下载 macOS Apple Silicon (M1-M4) DMG"><img src="docs/pictures/btn-download-mac-arm.svg" alt="macOS (Apple 芯片)" height="42" /></a>
    &nbsp;&nbsp;
    <a href="https://github.com/KasumiKitsune/tgrid/releases/latest" title="前往 Releases 下载 macOS Intel (x86_64) DMG"><img src="docs/pictures/btn-download-mac-intel.svg" alt="macOS (Intel 旧款)" height="42" /></a>
  </p>
  <p>
    <sub>也可直接通过浏览器试用 <a href="https://kasumikitsune.github.io/tgrid/">在线体验版</a>（所有音频与标注均在本地处理，不上传服务器）</sub>
  </p>
</div>

---

## 核心特性

- **完整兼容 Praat 标注文件**：直接读写标准长文本、短文本、二进制、按时间排序 `.TextGrid`、独立单层及 `.Collection` 文件；自动标出空隙、重叠、零时长、层域不一致与极短音段，支持一键整理边界。
- **短音段不挤字、语谱图不变形**：上方波形与宽带语谱图保持 1:1 真实物理时间，下方标注层按文字宽度自动舒展并自动折叠长静默，支持均衡多行折行与跨行续接，也可随时切回 1:1 线性对齐。
- **看谱听辨与精细切音**：载入 WAV 音频即可对照波形、语谱图、基频（F₀）与共振峰（F₁–F₃）参考曲线听辨；拖动边界时随行弹出 ±40 ms 放大镜，支持跨层磁吸对齐（`Alt` 临时跳过、`Z` 吸附过零点）与 ±1 ms / ±10 ms 键盘微调。
- **国际音标输入与批转换**：内置云龙国际音标（含五度声调）与 Praat 反斜杠音标（如 `\sh`、`\ng`、`\^h`）直接输入、对照显示与整文档互转，配有虚拟音标键盘；支持多标签页切换与只读防误改模式。
- **论文插图直接导出**：支持按层与时段筛选，内置论文单栏、通栏、幻灯片版幅与纯黑白印刷配色，导出矢量 SVG（可选纯矢量轮廓、图文分离包等）与高清 PNG，可按需附带中英双语图例与统一小数位刻度。

---

## 开放规范与开发者参考

如果你正在开发语音标注工具、语料库检索平台或语音学教学网站，欢迎直接参考并复用本仓库附带的两份独立技术规范（不绑定任何框架或界面实现）：

<div align="center">
  <p>
    <a href="docs/TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md" title="阅读 TextGrid 可视化与交互编辑规范"><img src="docs/pictures/btn-spec-viz.svg" alt="可视化与交互编辑规范" height="42" /></a>
    &nbsp;&nbsp;
    <a href="docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md" title="阅读 Praat TextGrid 与 Collection 文件格式规范"><img src="docs/pictures/btn-spec-format.svg" alt="Praat 文件格式规范" height="42" /></a>
  </p>
</div>

| 规范文档 | 核心内容 |
| :--- | :--- |
| **[TextGrid 可视化与交互编辑规范](docs/TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md)** | 说明「上方 1:1 真实时间声学视图 → 时间映射斜线区 → 下方按字宽舒展标注层」的双轨排版设计、长静默折叠、多行均衡折行与跨行续接、配色与符号语义、结构异常诊断及交互与导出规范，可按任意技术栈独立实现。 |
| **[Praat `.TextGrid` 与 `.Collection` 文件格式规范](docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md)** | 对照 Praat 源码核验的完整读写参考，涵盖标准长文本、短文本、二进制、按时间排序文本、独立单层及 `.Collection` 的解析规则、边界约束与测试用例，便于编写兼容 Praat 的读写库。 |

本项目全部代码（包括核心读写库、声学分析模块与图标库）均以 **MIT 协议**开源，欢迎直接复用或二次开发。

<details>
<summary>面向开发者：项目结构与本地构建</summary>

### 仓库结构

```text
tgrid/
├── crates/
│   ├── tg-core/              # Praat 编解码、切片诊断、IPA 双方案引擎、Marching Squares 等值轮廓、ZIP 打包
│   ├── tg-dsp/               # WAV 解码、FFT/STFT 语谱图、F0 基频、LPC 共振峰与多会话缓存
│   └── tg-wasm/              # WebAssembly 绑定
├── packages/
│   └── tgrid-icons/          # @tgrid/icons 独立微动效 SVG 图标库与硬件光标资源
├── apps/
│   ├── web/                  # React 19 + TypeScript + Vite 界面
│   └── desktop/              # Tauri v2 桌面端外壳（Windows NSIS / macOS DMG）
├── docs/
│   ├── PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md
│   ├── TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md
│   └── pictures/             # README 下载与文档入口矢量按钮
└── .github/workflows/
    ├── pages.yml             # 自动发布在线演示
    └── release.yml           # 推送 v* 标签自动打包 macOS (Apple Silicon / Intel) 与 Windows 安装包
```

### 本地开发与构建

需要环境：**Node.js 22+**、**Rust (stable)** 与 `wasm32-unknown-unknown` 目标：

```bash
rustup target add wasm32-unknown-unknown
npm install

# 运行 Rust 单元测试
npm run test:rust

# 启动界面开发服务器
npm run dev:web

# 编译 Windows 独立 Release 可执行文件
npm run build:desktop-exe
```

</details>

---

## English Summary

**T·Grid** is a free, local-first visual editor and publication-grade figure exporter for **Praat `.TextGrid` and `.Collection`** files, built for phonetics and linguistics teaching and research. It keeps waveforms and broadband spectrograms at true 1:1 physical time while automatically expanding dense segments so labels remain legible, provides F₀/F₁–F₃ reference contours, acoustic boundary magnification, IPA/trigraph input and batch conversion, and exports clean vector SVG and high-DPI PNG figures for papers and slides.

- **Desktop Installers (Windows x64 & macOS Apple Silicon / Intel)**: [GitHub Releases](https://github.com/KasumiKitsune/tgrid/releases/latest)
- **Try in Browser**: [kasumikitsune.github.io/tgrid](https://kasumikitsune.github.io/tgrid/) *(runs locally in your browser; files are never uploaded)*
- **Open Specifications**: Platform-agnostic [TextGrid Visualization & Editor Spec](docs/TEXTGRID_VISUALIZATION_AND_EDITOR_SPEC.md) and [Praat TextGrid & Collection Format Spec](docs/PRAAT_TEXTGRID_AND_COLLECTION_SPEC.md)

## License

[MIT](./LICENSE)
