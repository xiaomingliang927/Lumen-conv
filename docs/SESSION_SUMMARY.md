# 会话总结（Lumen-conv 视频格式转换器）

本文件记录这次开发会话的全过程：任务背景与目标、按阶段做了什么、最终交付了什么、验证到什么程度、
以及遗留问题与后续可做的事。

开发方式为**人机协作**：人类（项目所有者）负责给出需求与约束、做关键选型拍板、提供仓库凭据与放宽环境限制；
AI 负责环境探测、方案设计、全部代码编写、构建联调与文档产出。本节按阶段归纳，不逐条罗列操作流水。

---

## 1. 任务背景与目标

- **任务性质**：线上笔试题目，限时三天，要求"用 AI 写一个视频格式转换器"，考察的是 AI 工程能力而非算法题。
- **原始需求（7 条，作为最高优先级约束）**：
  1. 能够加载视频信息显示，并且获取到视频的缩略图显示出来；
  2. 视频转换可以用 ffmpeg 的命令行（不要求接入 ffmpeg api）；
  3. 自己按照自己的想法做一些优化；
  4. 会话完成后需要生成会话总结 md，开发者的决策选择跟反馈也需要记录到文档中；
  5. 项目提交 github；
  6. 审核会优先看界面选型，如果选型跟"客户端"关联为 0 不会考虑；
  7. 项目设计目标是给人用，需要注意这一点，不要做的东西自己都用不明白甚至都不测试。
- **目标产物**：一个能装、能跑、能用的 Windows 桌面视频格式转换器 + 一份可读的工程记录。
- **一个前置判断**：需求 6 与需求 7 决定了"能不能做出来"和"做出来给谁用"这两件事的优先级高于功能数量。
  因此本次会话把大量时间花在**环境可行性验证**、**错误路径处理**和**界面可用性**上，而不是堆格式支持数量。

---

## 2. 阶段划分与各阶段工作

### 阶段一：环境探测与技术选型

**做了什么**：在写第一行代码之前，先确认这台机器上"哪条技术路线今天就能跑起来"。

探测结果：

| 候选路线 | 本机环境状态 | 结论 |
| --- | --- | --- |
| Electron + Node | Node 可用、可联网，npm 可装包 | ✅ 唯一开箱即跑的路线 |
| Tauri（Rust） | Rust / cargo 缺失 | ❌ 需先装整条 Rust 工具链，三天工期风险高 |
| PySide6 / PyQt | Python 环境损坏（缺 `pyvenv.cfg`） | ❌ 解释器本身不可用，需先修环境 |
| WPF / WinForms（.NET） | .NET SDK 缺失 | ❌ 需先装 SDK |

**关键决策**：选 **Electron + Vue 3 + Vite + TypeScript**。理由不只是"环境能跑"，更重要的是需求 6 明确要求
界面选型必须与"客户端"强关联——Electron 产出的是真正的桌面应用（原生窗口、系统对话框、资源管理器集成、
系统通知、可打包成安装包），而不是套壳网页或命令行工具。完整论证见 `docs/DECISIONS.md` 的 D-001。

**产出**：技术选型清单、目录结构草案、`shared/types.ts` 的 IPC 契约草案。

### 阶段二：打通依赖安装与二进制获取（本项目最耗时的阶段）

这一阶段的产出主要不是业务代码，而是**把不可靠的环境变成可靠的脚本**。

遇到的障碍与处理（全部已在 `README.md` 的"环境踩坑备忘"中固化）：

1. 裸 `npm install` 因默认缓存目录在工作区外而 `EPERM` 失败 → 写 `scripts/install.mjs`，把缓存固定到项目内 `.npm-cache/`，
   并用 `npm run setup` 作为统一入口。
2. npm 11 不再接受 `.npmrc` 里的 `electron_mirror` / `ffmpeg_binaries_mirror` 自定义键（告警并失效）→
   改为在安装脚本里注入环境变量。
3. 受限环境里 `spawn(cmd, { stdio: 'pipe' })` 会 `EPERM`，MSYS 版 ssh 也报 `couldn't create signal pipe` →
   下载/解压脚本改为让子进程继承或忽略 stdio（不捕获输出）；git 改用 Windows 原生 OpenSSH
   （`git config core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"`）。
4. `curl.exe` 的 schannel 报 `SEC_E_NO_CREDENTIALS`，而 Node 的 `fetch` 正常 → 所有下载脚本统一用 Node `fetch`。
5. Electron 的 postinstall 二进制下载长时间卡住 → 提供 `npm run fetch:electron` 从镜像补装运行时。
6. PowerShell 的 `Set-Content` 默认编码把 `package.json` 里的中文写坏（"视频格式转换器"变乱码）→
   改用 UTF-8 写入工具编辑源文件。
7. 后来还发现一个容易误判的问题：esbuild 报 `Error: spawn EPERM` 看起来像沙箱权限问题，
   实际是平台子包（`@esbuild/win32-x64`）的二进制没被复制到 `node_modules/esbuild/bin/` →
   写 `scripts/fix-esbuild.mjs` 补齐二进制并生成 `node_modules/.bin` 垫片（幂等）。

**二进制来源方案（最终形态）**：本项目**完全不使用 `ffmpeg-static` / `ffprobe-static` 这两个 npm 包** ——
`package.json` 的 `dependencies` 是**空对象**，两个二进制包既不在依赖里也不在 `node_modules` 里，
`scripts/build-electron.mjs` 的 `external` 也从"排除二进制包"简化为**只有 `['electron']`**。

二进制改由 `scripts/fetch-binaries.mjs` 统一获取，落地到 `resources/bin/`：

| 二进制 | 首选来源 | 回退来源 |
| --- | --- | --- |
| `ffmpeg.exe` | yt-dlp/FFmpeg-Builds 的 master 构建，经 GitHub 代理镜像（`gh-proxy.com` → `ghfast.top` → `ghproxy.net`，直连排最后） | npm 包 `@ffmpeg-installer/win32-x64` |
| `ffprobe.exe` | npm 包 `@ffprobe-installer/win32-x64` | FFmpeg-Builds（同上） |

脚本支持 `--force` / `--source=npm` / `--electron`，落地后打印文件的 sha256；另有 `verify-binaries.mjs` 校验
（只报告不阻塞安装）。本次核对的实际结果是**首选来源成功**：两个二进制均为
`ffmpeg version N-126435-gf93cd72dde-20260906`，各约 139 MB，含 `libsvtav1`（详见 4.1）。

### 阶段三：主进程与 ffmpeg 能力层

**做了什么**：按"一个模块解决一类问题"的方式实现 ffmpeg 能力层，每个模块顶部都写了设计取舍注释。

| 模块 | 解决的问题 |
| --- | --- |
| `binaries.ts` | 二进制定位（用户自定义 > 随应用分发 > 系统 PATH），并把候选路径与存在性保留下来供排错 |
| `process.ts` | 子进程封装：`spawn` 参数数组（不经 shell）、`windowsHide`、超时兜底、行回调、**杀进程树** |
| `probe.ts` | ffprobe JSON → 结构化媒体信息（含 SAR 与旋转角校正、HDR 判定、章节、元数据过滤） |
| `thumbnail.ts` | 智能选帧（blackdetect + 多候选点 + `signalstats` 亮度评估）+ SHA1 磁盘缓存 |
| `commands.ts` | 结构化选项 → ffmpeg 参数数组；兼容性预检；GIF 调色板；HDR 色调映射；只缩不放 |
| `progress.ts` | 解析 `-progress pipe:1` 的 key=value 流 → 百分比 / 速度 / 剩余时间（含 `out_time_ms` 单位坑的处理） |
| `capabilities.ts` | 编码器能力探测：硬件编码器**真实试跑** 0.2 秒空转编码 + 内存/磁盘缓存（24 小时） |
| `errors.ts` | ffmpeg stderr → 人话结论 + 修复建议（11 条规则）+ 体积估算 |
| `convert.ts` | 任务引擎：队列 / 并发 / 取消 / 重试 / 磁盘空间预检 / 产物校验 / 历史裁剪 |
| `settings.ts` | 设置持久化（临时文件 + rename 原子写，损坏时退回默认值） |

**关键决策**：命令行装配返回**参数数组**而不是拼接好的字符串（避免路径含空格/中文被 shell 拆词），
另存一份转义后的 `commandText` 供界面展示与复制。见 `docs/DECISIONS.md` 的 D-005。

### 阶段四：渲染进程与界面

**做了什么**：三栏布局（自绘标题栏 / 侧边导航 / 主内容），转换页为"文件列表 + 详情面板"双栏。

- `App.vue`：骨架、全局快捷键（`Ctrl+O` / `Ctrl+1/2/3`）、全局 toast、ffmpeg 缺失时的顶部横幅。
- `FileList.vue`：整块区域拖拽投放 + 覆盖提示、骨架屏、封面与时长角标、失败条目标红。
- `DetailsPanel.vue`：视频信息卡（含 HDR 徽标与旋转角）、预设分组、编码器（按可用性置灰并给出原因）、
  质量与分辨率、实时预计体积、折叠的高级选项（音轨 / 字幕 / 裁剪 / 文件名模板）。
- `JobQueue.vue`：进度条（无总时长时退化为不确定进度）、速度 / 剩余时间 / 已用时、失败原因与建议、
  「查看 ffmpeg 命令」「运行日志」「复制诊断信息」「重试」「打开位置」。
- `SettingsView.vue`：运行环境诊断（ffmpeg/ffprobe 实际路径 + 版本 + 在文件夹中显示）、
  可用编码器分组可用性、转换偏好（并发 / 输出目录 / 通知 / 完成后打开目录）、外观（主题）、缓存清理。
  路径与目录输入框旁都有「浏览 / 选择目录」按钮（走主进程的 `dialog:pick-executable` 与 `dialog:pick-output-dir`
  handler），底部有「恢复默认设置」。
- `composables/useStore.ts`：自研状态中心（模块级单例 + `ref`/`computed`），不引 Pinia；
  任务状态以主进程为准，渲染层只做投影，不做乐观更新。

**关键决策**：不引 UI 组件库，界面全部手写（少一层依赖、样式完全可控）；
渲染层不得触碰 Node 能力，本地文件走自定义协议 `lumen-media://` 而不是关掉 `webSecurity`。见 D-002、D-009。

### 阶段五：联调、构建与目录整理

**做了什么**：

- 打通 `npm run dev`：`scripts/dev-electron.mjs` 先轮询 Vite dev server（端口 5273）就绪再拉起 Electron，
  避免白屏 `ERR_CONNECTION_REFUSED`；并监听 `electron/` 与 `shared/`，主进程改动自动重编译 + 重启。
- 打通构建链路：`vite build` → `dist/`；`esbuild` 打包主进程与 preload → `dist-electron/`。
- **目录改名**：渲染层源码目录从 `src/` 改名为 `renderer/`，同步更新 `vite.config.ts` 的 `root` 与别名、
  `tsconfig.json` 的 `include` 与 `paths`。目的是消除"`src/` 里装的是渲染层、而主进程在 `electron/`"这种
  不对称命名带来的混淆，让目录名直接说明它属于哪个进程。
- 拆分渲染层产物：把 `vue` 单独拆成 `vendor` chunk（`manualChunks`），主 chunk 更小、便于排查体积。
- **应用图标由脚本生成**：新增 `scripts/make-icon.mjs`，用 ffmpeg 的 `geq` 滤镜逐像素画出
  "深色圆角底 + 琥珀色播放三角"（4× 超采样抗锯齿），打包成 `build/icon.ico`（16/24/32/48/64/128/256 共 7 档）
  与 `build/icon.png`。脚本内置**像素自检**（`verifyPng()`）——前两版图标都是"脚本报成功但图是错的"，
  详见第 5.3 节与 `docs/DECISIONS.md` 的 D-015。
- **界面自检升级**：`main.ts` 的 `runSmokeCheck()` 不再只判断"截图成功"，而是等待 `document.documentElement`
  上的 `data-store-ready="1"`（由 `renderer/App.vue` 在 `initStore()` 完成后设置，避免把还没加载数据的空白页
  当成通过），并逐页断言真实内容；新增 `--smoke-file=<路径>` 参数，通过 `window.__lumenAddFiles`
  走与拖拽完全相同的 `addFiles` 路径加载真实视频后截图并断言信息面板、缩略图、时长角标、预设卡片与体积预估。

**未完成**：打包（`electron-builder`）没有实际跑通，见下节验证结果。

### 阶段六：文档与交付

**做了什么**：产出 `README.md`（项目主文档）、`docs/SESSION_SUMMARY.md`（本文件）、
`docs/DECISIONS.md`（决策日志）、`docs/FEEDBACK_LOG.md`（反馈记录），
并对全部源码做了一次交叉核对，把"文档描述"与"代码实际行为"不一致的地方显式记录在下面第 5 节。

---

## 3. 最终交付物

### 代码与工程配置

| 交付物 | 说明 |
| --- | --- |
| `electron/`（11 个文件） | 主进程 + preload + ffmpeg 能力层（9 个模块） |
| `renderer/`（13 个文件） | Vue 3 渲染层（6 个组件 + 状态中心 + 格式化工具 + 样式） |
| `shared/`（2 个文件） | `types.ts` IPC 契约、`presets.ts` 预设目录 |
| `scripts/`（8 个 `.mjs`） | 安装、二进制获取、二进制校验、主进程构建、开发启动、esbuild 修复、冒烟测试、图标生成 |
| `package.json` | **`dependencies` 为空**、16 个 npm 脚本、electron-builder 打包配置 |
| `vite.config.ts` / `tsconfig.json` / `tsconfig.electron.json` | 构建与类型检查配置 |
| `.npmrc` / `.gitignore` | 镜像配置与忽略规则（`resources/bin/` 与 `.downloads/` 均已排除） |
| `README.upstream.md` | 远端仓库原有 README（内容仅一行 `# Lumen-conv`），按约定重命名保留 |
| `build/icon.ico`、`build/icon.png` | 由 `scripts/make-icon.mjs` 生成的应用图标（入库） |
| `resources/bin/` | `ffmpeg.exe` + `ffprobe.exe`（**不入库**，由 `npm run setup` 获取） |

### 功能

- 需求 1：媒体信息探测 + 智能选帧缩略图（含磁盘缓存、后台预热）。
- 需求 2：7 种容器 / 9 个预设的 ffmpeg 命令行转换，命令行原文可在界面上查看。
- 需求 3：12 项自主优化（硬件编码器真实试跑探测、智能选帧、杀进程树、自动改名与磁盘预检、
  错误翻译、HDR 色调映射与旋转转正、只缩不放、GIF 调色板、直通预检、faststart、快速探测+后台完整探测、
  自定义协议）。逐条对照见 `README.md` 的"功能特性"一节。
- 需求 6：Electron 真桌面应用（自绘标题栏、原生对话框、资源管理器集成、系统通知、单实例、安装包目标）。
- 需求 7：拖拽即添加、空状态引导、失败任务不死路、深浅色主题、全中文文案（含错误翻译）、
  设置页诊断区、实时预计体积、快捷键。

### 文档

- `README.md`：项目主文档（简介、四张界面截图、需求逐条对照、技术栈、ASCII 架构图、快速开始、目录结构、
  二进制获取与替换、常用操作、已知限制与后续计划、环境踩坑备忘、License）。
- `docs/SESSION_SUMMARY.md`：本文件。
- `docs/DECISIONS.md`：15 条 ADR 风格决策记录（D-001 … D-015）
- `docs/FEEDBACK_LOG.md`：人类反馈与 AI 响应记录 + 待确认事项。
- `docs/CORE_IMPLEMENTATION.md`：核心实现说明（GIF 单进程调色板链、界面自检三级命令等）。
- `docs/TEST_CASES.md`：边界与异常用例记录（A 部分自动化覆盖 + B 部分需人工确认）。
- `docs/screenshots/README.md`：截图清单。四张界面截图由 `npm run smoke:ui` 自动生成到该目录（见第 4.1 节）。

---

## 4. 验证结果

验证手段是仓库里的几条自动化命令，都可重复执行、都有退出码：

```bash
npm run typecheck      # vue-tsc + tsc，均为 --noEmit
npm run smoke          # 端到端冒烟：合成素材 → 探测 → 缩略图 → 命令装配 → 真跑 ffmpeg → 校验产物
npm run smoke:ui       # 启动真实 Electron 窗口做界面自检并截图（14 项检查）
npm run smoke:ui:file  # 上一项 + 通过 __lumenAddFiles 加载真实视频后再截图（21 项检查）
npm run smoke:ui:full  # 再额外在应用内真跑一次转换（26 项检查）
```

### 4.1 已实机验证

#### 构建与类型检查

| 项目 | 证据 |
| --- | --- |
| 依赖安装成功 | `node_modules/` 存在；实际安装版本逐个核对：electron 38.8.6、vue 3.5.42、vite 7.3.6、typescript 5.9.3、esbuild 0.28.2、electron-builder 26.15.3、vue-tsc 3.3.11、concurrently 10.0.5。**`dependencies` 为空对象**，全部依赖都是 `devDependencies` |
| 运行环境 | Node v26.6.0 / npm 11.18.0 |
| **`npm run typecheck` 通过** | 退出码 **0，零错误**（`vue-tsc --noEmit -p tsconfig.json` 检查渲染层 + shared，`tsc --noEmit -p tsconfig.electron.json` 检查主进程 + shared） |
| 渲染层构建成功 | `vite build`：34 个模块，`dist/index.html` 0.80 kB、`index-*.css` 25.28 kB、`index-*.js` 55.98 kB、`vendor-*.js` 70.53 kB |
| 主进程构建成功 | `esbuild`：`dist-electron/main.js` 69.6 kB、`dist-electron/preload.js` 1.7 kB |
| **桌面应用已真正启动** | `npm run smoke:ui:file` 启动真实 Electron 窗口、加载真实视频、逐页截图并退出码 0，产出 4 张 PNG（见 4.2） |

#### 端到端冒烟测试：`npm run smoke` **48/48 全部通过**

冒烟测试不启动界面，而是用 esbuild 把 `electron/ffmpeg/` 下的产品模块打包成 ESM、
把 `electron` 指向测试桩（`scripts/test-stubs/electron.mjs`）后**直接调用与主进程相同的代码**，
素材用 `lavfi` 合成，因此验证的是真实链路。

| 覆盖范围 | 实测结果 |
| --- | --- |
| 二进制与环境 | ffmpeg **139.1 MB**、ffprobe **138.9 MB**，版本均为 `ffmpeg version N-126435-gf93cd72dde-20260906` |
| 素材合成 | H.264/MP4 6 秒 640×360 661 KB；H.265/MKV 4 秒 298 KB；带旋转元数据 MP4 754 KB；480p 低分辨率 MP4；纯音频 MP3 5 秒 |
| **需求 1 · 探测** | `MP4 / QuickTime · 640×360 · 6.00s`；编码识别 h264 / aac（1ch）；总码率 902 kbps |
| 损坏/异常输入 | 非视频文件 →「文件里没有找到任何音视频轨道」；0 字节文件被提前拦截并给出可读原因 |
| **需求 1 · 缩略图** | 智能选帧首次生成 17 KB JPEG；二次调用命中磁盘缓存（`cached=true`，4 ms）；非视频文件抽帧失败但不崩溃 |
| **需求 2 · 命令装配** | MP4/H.264 生成 39 个参数；质量档位切换 CRF（high → CRF 20）；分辨率生成 `scale=-2:360:flags=lanczos`；源低于目标时**正确跳过缩放**；H.265 带 `hvc1` 标签；WebM 用 `libvpx-vp9` + `libopus`；纯音频用 `-vn` + `libmp3lame`；GIF 用单次调用的内联调色板链且**无前导逗号**；硬件编码器 `h264_nvenc` 映射为 `-cq` 而非 CRF；未知预设抛出可读错误；裁剪生成 `-ss 1.000 -t 2.000` |
| **需求 2 · 真实转换（真跑 ffmpeg）** | MP4→MP4 重编码 706 KB；**MP4→MP4 无损直通 661 KB**（明显快于重编码）；MP4→WebM（VP9+Opus）641 KB；MP4→H.265 247 KB；MP4→MP3 142 KB；**MP4→GIF（调色板两遍法）694 KB**；**回归：低分辨率源直接用 GIF 默认预设 1609 KB**；裁剪 1-3 秒 → 产物回读时长 2.00 s；小体积档压缩比 661 KB → 250 KB（**38%**） |
| 容器兼容性预检 | theora 源直通 MP4 被拦并给出人话建议；VP9 源直通 MP4 被正确放行（不过度拦截）；H.264 直通 WebM 被拦 |
| 错误翻译 | 磁盘满 / 未知编码器（显卡不可用）/ 容器不兼容三类均翻译为中文结论 + 修复建议 |
| 取消语义 | 取消的任务标记为 `canceled` 而不是失败 |
| 进度解析 | `25% · 2.5× · ETA 30.0s`；`01:02:03.5 → 3723.5s`；未知总时长时 `percent=null`（界面走不确定进度条） |

> 逐条用例清单与判定条件见 `docs/TEST_CASES.md` 的 A 部分。

#### 界面自检：`npm run smoke:ui:file` **21/21 全部通过**

启动真实 Electron 窗口，等待 `data-store-ready`，通过 `window.__lumenAddFiles()`
（内部就是拖拽用的同一个 `addFiles`）加载 `test-assets/samples/sample-h264.mp4`，逐页断言并截图。

| 断言项 | 实测结果 |
| --- | --- |
| 界面骨架与样式 | 标题栏 / 侧边导航 / 文件区 / 详情面板均渲染；`--accent` 等 CSS 变量已加载；`data-theme` 已应用 |
| preload API | `window.converter.probe` 为函数 |
| 真实文件加载 | 信息面板出现 **9 行**；缩略图 `src` 为 `lumen-media://…`；时长角标显示；**9 张预设卡片**可选（默认选中「MP4 通用兼容」）；产物体积预估显示「预计 3.71 MB」；详情含「画面＝640×360」 |
| 页面内容（防空白页） | 设置页 **5 个** `.settings .card` 分组；队列页标题存在；导航高亮正确落在「设置」 |
| 截图产出 | `main.png`、`main-with-file.png`、`queue.png`、`settings.png` 四张 |

#### ffmpeg 构建能力已核对

`resources/bin/ffmpeg.exe -encoders` 实测确认下列编码器**全部存在**：
`libx264`、`libx265`、**`libsvtav1`**、`libaom-av1`、`libvpx-vp9`、`aac`、`libmp3lame`、`libopus`、
`libvorbis`、`ac3`、`flac`、`gif`、`h264_nvenc`、`hevc_nvenc`、`h264_qsv`、`h264_amf`。

**AV1 软编码可用**（`libsvtav1` 存在，`presets.ts` 的 `av1` → `libsvtav1` 映射成立）——
本项目早期文档里"缺 `libsvtav1`、AV1 不可用"的结论对应的是 2018 年的 `N-92722` 构建，**已随换构建而失效**。

#### 硬件编码器探测（真实试跑）

设置页实测结果：**Intel QSV 的 H.264 显示可用（绿点）**——即真实试跑了一次 0.2 秒空转编码并成功；
**NVIDIA NVENC 与 AMD AMF 显示「编码器初始化失败（通常是驱动问题）」**（本机没有对应显卡/驱动）。
这条印证了 `capabilities.ts` 的设计意图：`-encoders` 列表里这些编码器永远存在，只有真跑一次才能区分"构建里有"和"这台机器能用"。

### 4.2 尚未验证（诚实标注）

| 未验证项 | 现状与原因 |
| --- | --- |
| **安装包 / portable 从未产出** | 图标已就绪（`build/icon.ico` + `build/icon.png` 由 `scripts/make-icon.mjs` 生成），但 `release/` 目录不存在，`npm run dist` / `npm run dist:portable` 没有跑通过。"能打包成安装包"目前仍只是配置层面的准备 |
| 打包后 asar / extraResources 路径 | 未验证 `process.resourcesPath/bin/ffmpeg.exe` 在安装后的实际可执行性 |
| 旋转自动转正（transpose 滤镜） | 冒烟测试自建了带 `rotate=90` 元数据的样本，但**这份 ffmpeg 构建没有保留该元数据**（探测回来 `rotation=0`），用例自行跳过并如实打印"用例跳过"。所以"手机竖拍视频自动转正"这条**没有被真正验证** |
| HDR 色调映射 | 没有 HDR 样本，`zscale`/`tonemap` 滤镜链一次都没执行过 |
| 硬件编码器**实际转码** | 探测层已确认真实可用性（QSV H.264 可用），但**没有任何一条真实转码用例走硬件编码器**——冒烟测试不覆盖 `capabilities.ts`，也没有用 QSV 真转过一个文件。NVENC / AMF 的真卡参数更无从验证 |
| 缩略图的**避黑场**能力 | 智能选帧路径确实跑过（能出图、能命中缓存），但 `testsrc2` 彩条素材里没有黑场，所以 `blackdetect` + `signalstats` 的"避开黑帧"逻辑**只是执行了，没有被证明能正确跳过黑帧** |
| 字幕选择 / 多音轨映射 | 合成素材没有字幕轨与多音轨，相关分支未覆盖 |
| `--smoke-convert`（应用内真跑转换） | `smoke:ui:full` 这条命令**在本轮核对中未得到可信结果**：运行期间另有实例持锁，无法确认其 26 项检查的真实通过数。安装包路径同理。标注为"未验证"而非"通过" |
| GitHub 推送 | 见下节"交付状态" |

### 4.3 交付状态（GitHub）

截至撰写本文件时，通过 `git log` / `git ls-files` / `git status` 核对的实际状态是：

- `git log` 只有 **1 个提交**：`fa29cd3 Initial commit`——即远端仓库原有的那次提交（内容只有一行 `# Lumen-conv` 的 README）。
- `git ls-files` 只有 **1 个被跟踪文件**；`renderer/` 与 `src/` 都没有被跟踪（目录改名发生在提交之前，所以历史里从未出现过 `src/`）。
- **本项目的全部源码仍是未跟踪状态**（`git status` 里 `electron/`、`renderer/`、`shared/`、`scripts/`、
  `package.json`、配置文件等全部显示为 `??`，原 `README.md` 显示为已删除）。
- 结论：**代码尚未提交、也尚未推送到 `git@github.com:xiaomingliang927/Lumen-conv.git`**。

**二进制是否入库这个问题已经拍板**：`.gitignore` 现已排除 `resources/bin/`（ffmpeg 139.1 MB + ffprobe 138.9 MB）
与 `.downloads/`（归档缓存），即取向是"仓库只放源码，二进制按需获取"。
`.gitignore` 里写明了三条理由（GitHub 单文件 100 MB 硬限制、二进制不适合 git 差分存储、一行命令即可重新获取），
并给出替代方案：需要"开箱即用"的整包时用 `npm run dist` 的安装包，或把完整包作为 Release 附件上传。
克隆后执行 `npm run setup`（或 `node scripts/fetch-binaries.mjs`）即可补齐。单个文件最大 139.1 MB，
**已超过 GitHub 单文件 100 MB 的硬限制**，这从另一个角度印证了必须忽略。

---

## 5. 代码审查发现

本节分两部分：**5.1 已修复**（每条都给出修复方式与验证证据）、**5.2 仍然存在**。
本轮核对对全部源码做了交叉核对，并重跑了 `npm run typecheck`、`npm run smoke`、`npm run smoke:ui:file`
三条自动化命令；下列结论都以代码与实测输出为准。

> 修订说明：本节此前版本列的 12 条缺陷中，有 7 条已经修复（第 5.1 节），
> 其余仍然成立（第 5.2 节）。原"与任务描述不一致"一节里的 5 条已全部随本轮改动消解，见 5.1 末尾。

### 5.1 已修复（含修复方式与验证证据）

| # | 原问题 | 修复方式 | 验证证据 |
| --- | --- | --- | --- |
| 1 | **低分辨率源转 GIF 滤镜链以逗号开头，ffmpeg 直接失败** | `commands.ts` 的 `buildVideoArgs()` 中 `codecId === 'gif'` 分支不再用 `filterOnly()` 取前置滤镜后拼接，而是**把调色板链合并进已有的 `-vf`**：有 `-vf` 就把 `[已有值, paletteChain].filter((s) => s.length > 0).join(',')` 写回，没有就 `args.push('-vf', paletteChain)` 新建。空串被过滤掉，因此不会产生前导逗号 | ① 命令装配用例「GIF 预设使用单次调用的内联调色板两遍链」断言 `!vf.startsWith(',')` 且前置 `fps=15` 被保留在同一侧；② 回归用例「回归：GIF 前置滤镜为空时不能生成前导逗号」构造"源就是 480p + 不改帧率"的场景，断言以 `split` 开头；③ **真实转码**回归用例「回归：低分辨率源直接用 GIF 默认预设（无前置滤镜）」用 640×480 源 + 480p 档 + `fpsId: 'source'` 真跑 ffmpeg，产出 **1609 KB** 有效 GIF。三条用例在 `npm run smoke` 中全部通过 |
| 2 | GIF 调色板 PNG 被预生成却未被主命令消费，白跑一个 ffmpeg 进程 | **整套预生成机制已删除**：`BuiltCommand` 不再有 `prePasses` / `postPasses` 字段，`VideoPlan` 不再有 `twoPass` 字段，`buildPaletteArgs()` / `filterOnly()` / `engine.cleanupPalette()` 均已删除，`InternalJob` 不再有 `palettePath` / `currentStage` / `prePassesDone`。GIF 现在**只启动一个 ffmpeg 进程、不落地任何临时调色板文件** | 全仓库 grep 上述符号：0 命中。`convert.ts` 的 `run()` 里 `const mainArgs = built.args;` 直接跑单条命令 |
| 3 | `postPasses` / `twoPass` 是死代码 | 随第 2 条一并删除，类型与实现里都不再存在 | 全仓库 grep `postPasses` / `twoPass`：0 命中 |
| 4 | `AppSettings.hardwareAcceleration` 从未被读取，而 `errors.ts` 却让用户去设置里关它 | **字段直接删除**（连同同样没被读取的 `safeMode`），`DEFAULT_SETTINGS` 同步移除；`errors.ts` 里"当前环境不支持所选的编码器"的 `hint` 改为引导用户去**「高级选项 → 视频编码器」改回软编码（H.264 / H.265）**——指向一个真实存在的界面位置 | `shared/types.ts` 的 `AppSettings` 与 `DEFAULT_SETTINGS` 中已无这两个字段；`errors.ts` 的 `unsupported-codec` 规则 hint 文本为"请在「高级选项 → 视频编码器」里改回不带「显卡加速」的软编码" |
| 5 | `AppSettings.openFolderOnFinish` 只存不用 | `renderer/composables/useStore.ts` 的 `onJobUpdated` 里检测**任务首次变为 `done`**（`job.state === 'done' && prev?.state !== 'done'`），此时若 `settings.openFolderOnFinish` 为真则调用 `api.openOutput(job.id)`。用 `prev?.state !== 'done'` 判断是为了避免后续任何一次 `job:updated` 重复打开资源管理器 | `useStore.ts` 的 `justFinished` 分支；`main.ts` 的 `jobs:open-output` handler 用 `shell.showItemInFolder` 实现 |
| 6 | `settings:reset` 与 `jobs:cancel-all` 通道已注册但 preload 无入口，设置页也没有「恢复默认设置」按钮 | `preload.ts` 已暴露 `resetSettings()` 与 `cancelAllJobs()`，`shared/types.ts` 的 `ConverterApi` 同步补齐；`SettingsView.vue` 底部 `about` 区新增「恢复默认设置」按钮（`resetAll()`），调用 `resetSettings()` 后回写 `settings` 并重新应用主题 | `preload.ts` 的 `resetSettings` / `cancelAllJobs` 键；`main.ts` 的 `settings:reset` / `jobs:cancel-all` handler；`SettingsView.vue` 的 `resetAll()` |
| 7 | 设置页的路径与目录只能手输，没有「浏览」按钮 | 新增 `dialog:pick-executable` handler（`main.ts`）+ preload 的 `pickExecutable()`；`SettingsView.vue` 的 ffmpeg / ffprobe 路径输入框旁各有「浏览」按钮，默认输出目录有「选择目录 / 恢复默认」，缩略图缓存有「清理缓存」（走 `cache:clear-thumbnails` → `clearThumbnailCache()`） | 上述三处 handler 与按钮均在源码中；设置页实测渲染出 5 个 `.settings .card` 分组，自检要求 ≥ 3 即通过 |

另外三项原属"与任务描述不一致"的问题也已消解：

- **"不用 `ffmpeg-static`"现在是字面属实的**：`package.json` 的 `dependencies` 是**空对象** `{}`，
  两个二进制包既不在依赖里、也不在 `node_modules` 里；`binaries.ts` 的 `bundledCandidates()`
  只返回 `resources/bin/`（打包态 `process.resourcesPath/bin`，开发态 `<项目根>/resources/bin`），
  **不再有任何 node_modules 兜底**；`build-electron.mjs` 的 `external` 已简化为 `['electron']`。
  准确表述是：**完全不用该 npm 包，二进制由 `scripts/fetch-binaries.mjs` 获取**。
- **"ffmpeg 来自 FFmpeg-Builds master 构建"现在是属实的**：`resources/bin/ffmpeg.exe` 与 `ffprobe.exe`
  均为 `ffmpeg version N-126435-gf93cd72dde-20260906`，各约 139 MB（首选来源成功，未回退到 npm 包）。
- **"缺 libsvtav1 / AV1 不可用"已过时**：该构建**含 `libsvtav1`**，AV1 软编码可用。
  实测 `-encoders` 清单确认：`libx264`、`libx265`、`libsvtav1`、`libaom-av1`、`libvpx-vp9`、`aac`、
  `libmp3lame`、`libopus`、`libvorbis`、`ac3`、`flac`、`gif`、`h264_nvenc`、`hevc_nvenc`、`h264_qsv`、`h264_amf` 全部存在。

### 5.2 仍然存在（本轮核实后依然成立）

| # | 问题 | 现状与影响 |
| --- | --- | --- |
| 1 | **没有单元测试框架** | `devDependencies` 里没有 Vitest / Jest / Mocha，`node_modules` 里也没有对应目录。当前只有 `smoke-test.mjs`（端到端）与 `smoke:ui`（界面）两层，纯函数（`renderer/utils/format.ts`、`ffmpeg/progress.ts` 的解析、`sanitizeFileName()`、`clampThumbnailTime()`）**未做边界穷举** |
| 2 | **字幕只支持"能保留"** | 不支持烧录（hardsub）、不支持外挂字幕文件、不支持把 MKV 内封字幕抽取成 `.srt`。WebM 容器下会自动剔除图形/ASS 字幕并提示改用 MKV |
| 3 | **硬件编码器参数未在真卡上验证** | 本机探测到 **Intel QSV 的 H.264 可用**（设置页绿点，真实试跑通过），但 **NVIDIA NVENC 与 AMD AMF 均报「编码器初始化失败（通常是驱动问题）」**。因此 `-cq`（NVENC）与 `-b:v`（AMF）这些真卡参数**没有在任何硬件上跑过**，只有 QSV 的 `-global_quality` 路径可认为接近可用 |
| 4 | **没有断点续传** | 转换中断（取消 / 崩溃 / 关机）只能整段重来 |
| 5 | **GIF 只统计整段调色板** | `palettegen=stats_mode=diff` 针对整段视频统计颜色分布，超长视频做 GIF 会非常慢且体积巨大。UI 只在预设 `tip` 里提示"建议先裁剪 3-6 秒"，**没有硬性限制**（例如自动截断或警告确认） |
| 6 | **打包产物未做代码签名** | `package.json` 里没有任何 `signingHashAlgorithms` / 证书配置，Windows SmartScreen 会提示"未知发布者" |
| 7 | **未做多语言** | 无 i18n 框架，界面文案为硬编码中文（含 `format.ts` 里的中文单位与 `errors.ts` 的全部提示文案） |
| 8 | **未引用的预留代码** | `capabilities.ts` 的 `pickBestVideoCodec()`、`clearCapabilityCache()`；`thumbnail.ts` 的 `warmThumbnail()`、`extractFrameAt()`。在 `electron/`、`renderer/`、`shared/`、`scripts/` 全量搜索这四个符号，**各自只有定义处一处命中**（`warmThumbnail` / `extractFrameAt` 的注释也写明"当前 UI 未使用，保留给后续功能"）。注：`main.ts` 的 `media:probe` handler 里有一处 `void getThumbnail(...)` 做后台预热，但它直接调 `getThumbnail()` 而不是 `warmThumbnail()`，所以后者确实是死代码 |
| 9 | **`-movflags +faststart` 在 `-c copy` 分支不生效** | `buildVideoArgs()` 的 `if (codecId === 'copy')` 分支在函数开头就 `return`，走不到后面 `if (container === 'mp4') args.push('-movflags', '+faststart')` 那一段。所以「极速换壳」预设输出 MP4 时**不会**加 faststart |
| 10 | **`probe.ts` 的 `thumbnailAtSec` 与 `thumbnail.ts` 的候选点逻辑重叠** | `probe.ts` 用 `clampThumbnailTime()` 算出"时长的 10%、下限 1 秒、上限 30 秒"；`thumbnail.ts` 的 `getThumbnail()` 在 `smart` 模式下**自己按 10%/25%/50%/5% + 2 秒另算一份候选点**，并不读 `thumbnailAtSec`。全仓库唯一读取 `thumbnailAtSec` 的地方是 `scripts/smoke-test.mjs` 的一条断言（"抽帧时间点在合理区间"），**产品代码不消费它**。两处逻辑应当合并 |
| 11 | **`CONTAINERS.copy` 走不到** | `shared/presets.ts` 的 `CONTAINERS` 里有 `copy`（原样重封装）这一项，`commands.ts` 的 `containerToFormat('copy')` 也有对应分支，但 9 个预设中**没有任何一个的 `container` 是 `copy`**（`remux-copy` 预设用的是 `container: 'mp4'` + `videoCodecId: 'copy'`，走的是另一条路径）。所以 `container === 'copy'` 的判断与 `containerToFormat('copy')` 分支实际不可达 |
| 12 | **`webPreferences.sandbox: false`** | `electron/main.ts` 的 `BrowserWindow` 配置里明确写了 `sandbox: false`。安全边界仍由 `contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true` 与 preload 白名单共同保证，但比 Electron 的默认（沙箱开启）更宽松，值得知悉 |
| 13 | **快捷键已实现，界面只提示了 `Ctrl+O`** | `renderer/App.vue` 的 `onKeydown` 实现了 `Ctrl+O`（打开文件）与 `Ctrl+1/2/3`（切换三个页面）。界面上**只有 `Sidebar.vue` 底部提示了 `Ctrl`+`O` 打开文件**，`Ctrl+1/2/3` 没有任何文字说明 |

### 5.3 其他值得记录的细节

- `fetch-binaries.mjs` 的 `sha256()` 会**计算并打印**摘要，但代码里没有任何期望值可比对，
  所以下载完整性实际上只有 `content-length` 一层校验（注释里的"有期望值时"目前永不成立）。
- `.gitignore` 已排除 `resources/bin/`（约 291 MB：ffmpeg 139.1 MB + ffprobe 138.9 MB）与 `.downloads/`
  （归档缓存，复用下载用）。**仓库不提交二进制**，克隆后需要 `npm run setup` 或 `node scripts/fetch-binaries.mjs`；
  文件里也写明了这样做的三条理由与"需要开箱即用整包时用 `npm run dist` 产物 / Release 附件"的替代方案。
- `.gitignore` 同时忽略了 `test-assets/output/` 与 `test-assets/samples/`（冒烟测试的产物与合成素材）。
  实测 `test-assets/output/` 里残留了一个 `.palette-smoke.png`（927 字节，时间戳早于本次核对），
  它是**已删除的 GIF 调色板预生成功能的遗留产物**——当前 `smoke-test.mjs` 里已经没有任何 `palette` 相关的
  文件生成逻辑，该文件属于陈旧产物，可安全删除。
- 根目录有一个空的 `.qtprobe/` 目录，来源不明，与项目无关。
- **`npm run smoke:ui` 在"已有实例运行"时不会真正执行，但看起来像成功了**：`main.ts` 顶部用
  `app.requestSingleInstanceLock()` 做单实例保护。本次核对中实测到：当**另一个** Electron 实例
  （携 `--smoke --smoke-file=… --smoke-convert`）正在运行时，再执行 `npm run smoke:ui`
  **不会刷新 `docs/screenshots/` 里的任何 PNG**，而命令本身**并不报错**（退出码 0）。
  换句话说，此时"自检通过"的实际含义是"另一个实例在跑"，容易把"没跑"误读成"跑过了"。
  **建议**：跑界面自检前先确认没有其它实例（`Get-Process electron`），并把 `docs/screenshots/*.png`
  的时间戳作为"本轮确实跑过"的旁证。此问题与单实例保护的行为细节（`app.quit()` 之后 `whenReady()` 是否仍触发
  `runSmokeCheck()`）**尚未逐行确认**，此处只记录可复现的现象，不推断内部机制。
- 本次核对期间代码库处于**持续修改状态**（核对过程中 `package.json` 新增了 `make:icon` / `fix:esbuild` /
  `smoke:ui:full`，`renderer/App.vue` 又补了一条"`__lumenAddFiles` 必须返回 `undefined`"的注释——
  因为 `executeJavaScript` 用结构化克隆传值，返回 Vue 响应式对象或 Promise 会让渲染进程崩溃）。
  因此本文档中的引用一律用**函数名 / 符号名**而不是行号；具体数字（文件大小、耗时、版本号）均为
  本次核对的实测值，实测环境为 `ffmpeg N-126435-gf93cd72dde-20260906`。

---

## 6. 遗留问题与后续可做的事

按优先级排列：

1. **产出并验证安装包**（当前最大的空白）：图标已就绪（`build/icon.ico` 由 `scripts/make-icon.mjs` 生成），
   但 `release/` 目录从未产出过。需要跑 `npm run dist` 与 `npm run dist:portable`，
   安装后确认 `resources/bin/ffmpeg.exe` 与 `ffprobe.exe` 被正确释放（`process.resourcesPath/bin`）且能真的转一个文件。
2. **补上冒烟测试没覆盖的样本**：HDR 片源（验证 `zscale`/`tonemap` 链，目前一次都没执行过）、
   真正带旋转元数据的手机视频（现有样本的 `rotate=90` 未被这份 ffmpeg 保留，探测回来 `rotation=0`，用例自跳过）、
   带字幕与多音轨的 MKV（字幕与多音轨映射分支未覆盖）、
   以及**带片头黑场的视频**（用于证明 `blackdetect` + `signalstats` 真的能跳过黑帧——
   目前 `testsrc2` 素材没有黑场，只能证明这条链路跑得通）。
3. **引入单元测试框架**（Vitest），把 `format.ts`、`progress.ts`、`sanitizeFileName()`、`clampThumbnailTime()`
   这些纯函数的边界穷举起来（第 5.2 节第 1 条）。
4. **清理未引用的预留代码**：`pickBestVideoCodec()`、`clearCapabilityCache()`、`warmThumbnail()`、`extractFrameAt()`
   ——要么接进 UI（例如"手动挑封面"用 `extractFrameAt()`），要么删掉（第 5.2 节第 8 条）。
5. **合并重复逻辑**：`probe.ts` 的 `thumbnailAtSec` 与 `thumbnail.ts` 的候选点计算；
   以及 `commands.ts` 的 `quoteArg()` 与 `convert.ts` 的 `formatCommand()` 两份命令行转义实现
   （第 5.2 节第 10 条）。
6. **决定二进制是否入库**，然后完成首次提交与推送（见 4.3）。当前 `.gitignore` 已排除，即取向是"忽略二进制"。
7. **给 GIF 加硬性限制**：例如时长超过阈值时提示或自动截取前 N 秒，而不是只靠预设 `tip` 文字提醒（第 5.2 节第 5 条）。
8. **评估接入硬件解码**（`-hwaccel` 系列参数），当前只用了硬件编码。
9. 让界面上能看见已实现的全部快捷键（`Ctrl+1/2/3` 目前无提示，第 5.2 节第 13 条）。
10. 考虑：任务队列持久化（重启后保留历史）、缩略图缓存容量上限与 LRU 清理、打包产物的代码签名。
