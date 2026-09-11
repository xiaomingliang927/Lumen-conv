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
  质量与分辨率、实时预计体积、折叠的专业参数（音轨 / 字幕 / 裁剪 / 文件名模板）。
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
| `scripts/`（9 个 `.mjs`） | 安装、二进制获取、二进制校验、主进程构建、开发启动、esbuild 修复、冒烟测试、图标生成、**便携版离线打包（`package-portable.mjs`，本轮新增）** |
| `package.json` | **`dependencies` 为空**、21 个 npm 脚本（本轮新增 `dist:portable` 与 `dist:nsis`）、electron-builder 打包配置 |
| `vite.config.ts` / `tsconfig.json` / `tsconfig.electron.json` | 构建与类型检查配置 |
| `.npmrc` / `.gitignore` | 镜像配置与忽略规则（`resources/bin/`、`.downloads/`、`release/`、`test-assets/` 产物均已排除） |
| `README.upstream.md` | 远端仓库原有 README（内容仅一行 `# Lumen-conv`），按约定重命名保留 |
| `LICENSE` | MIT 全文（本轮补齐，此前只有 `package.json` 的 `license` 字段） |
| `build/icon.ico`、`build/icon.png` | 由 `scripts/make-icon.mjs` 生成的应用图标（入库） |
| `resources/bin/` | `ffmpeg.exe` + `ffprobe.exe`（**不入库**，由 `npm run setup` 获取） |
| `release/Lumen-conv-便携版/` | **本轮首次产出的可分发产物**（Windows x64 便携版，602.3 MB，**不入库**，由 `npm run dist:portable` 生成） |

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

- `README.md`：项目主文档（简介、五张界面截图、需求逐条对照、技术栈、ASCII 架构图、快速开始、目录结构、
  二进制获取与替换、常用操作、已知限制与后续计划、环境踩坑备忘、License）。
- `docs/SESSION_SUMMARY.md`：本文件。
- `docs/DECISIONS.md`：18 条 ADR 风格决策记录（D-001 … D-018；D-017 是打包方式决策，D-018 是本轮新增的"模式差异必须落在首屏"决策）
- `docs/FEEDBACK_LOG.md`：人类反馈与 AI 响应记录 + 待确认事项。
- `docs/CORE_IMPLEMENTATION.md`：核心实现说明（GIF 单进程调色板链、界面自检三级命令等）。
- `docs/TEST_CASES.md`：边界与异常用例记录（A 部分自动化覆盖 + B 部分需人工确认）。
- `docs/screenshots/README.md`：截图清单（8 张，逐张给出断言依据）。界面截图由 `npm run smoke:ui:full`
  自动生成到该目录（见第 4.1 节）。

---

## 4. 验证结果

验证手段是仓库里的几条自动化命令，都可重复执行、都有退出码：

```bash
npm run typecheck      # vue-tsc + tsc，均为 --noEmit
npm run smoke          # 端到端冒烟：合成素材 → 探测 → 缩略图 → 命令装配 → 真跑 ffmpeg → 校验产物
npm run smoke:ui       # 启动真实 Electron 窗口做界面自检并截图（14 项检查）
npm run smoke:ui:file  # 上一项 + 通过 __lumenAddFiles 加载真实视频后再截图（56 项检查）
npm run smoke:ui:full  # 再额外在应用内真的点一次「开始转换」并等任务跑完（61 项检查）
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
| **桌面应用已真正启动** | `npm run smoke:ui:full` 启动真实 Electron 窗口、加载真实视频、逐页截图、**在应用内真的点一次「开始转换」并等任务跑到终态**，**68/68 通过、退出码 0**，产出 8 张 PNG（见 4.1） |
| **便携版打包已产出并实机验证** | `npm run dist:portable`（`node scripts/package-portable.mjs --build`）**完全离线**产出 `release/Lumen-conv-便携版/`：`Lumen-conv.exe` **200.4 MB**（210,149,888 字节）、目录总计 **602.3 MB**；`release/` 已被 `.gitignore` 排除（`git check-ignore -v release/` 命中第 4 行）。产物**实跑全套界面自检 68/68 通过、退出码 0**（含应用内真实转换：状态 `done`、产物 3.15 MB、进度 100%），详见 4.1.1 |

#### 4.1.1 便携版（打包态）自检：`release/Lumen-conv-便携版/Lumen-conv.exe` **68/68 通过、退出码 0**

这是本轮新增的一层验证——**同一个自检程序，换成打包后的形态再跑一遍**：

```bash
release/Lumen-conv-便携版/Lumen-conv.exe --smoke \
  --smoke-file=<绝对路径> --smoke-assets=<仓库的 test-assets 目录> --smoke-convert
```

| 项目 | 实测结果 |
| --- | --- |
| 产物 | `release/Lumen-conv-便携版/Lumen-conv.exe` **200.4 MB**（210,149,888 字节）；目录总计 **602.3 MB** |
| 目录构成 | Electron 运行时（`*.dll` / `*.pak` / `locales/` 等，已排除 `default_app.asar`）+ `resources/app.asar` 231,086 字节 + `resources/bin/ffmpeg.exe` 145,876,992 字节 + `resources/bin/ffprobe.exe` 145,665,024 字节 |
| 自检结果 | **68/68 通过、退出码 0**，其中包含应用内真实转换：任务状态 `done`、产物 **3.15 MB**、进度 `percent=100` |
| 内置 ffmpeg | 便携版内 `resources/bin/ffmpeg.exe -version` 实测 `ffmpeg version N-126435-gf93cd72dde-20260906`，与开发态所用构建一致 |
| 二进制查找 | `resources/bin` 在开发态与打包态**路径约定一致**，因此 `binaries.ts` 无需任何分支（见 `docs/CORE_IMPLEMENTATION.md`） |
| 图标 / 版本信息 | **未写入**（实测 `Lumen-conv.exe` 的版本信息仍是 Electron 原值：`ProductName=Electron`、`OriginalFilename=electron.exe`）。原因见 4.2 与 4.3 |

这层验证的价值在**本轮被真实证明两次**：开发态全绿，并不意味着打包态也能跑——两次都是同一个根因
`app.getAppPath()` 在打包态指向 `...\resources\app.asar`（一个**文件**）：

1. 第一次：自检代码拿它当目录 `mkdirSync()`，便携版上直接抛 `ENOTDIR`（修复见 5.1 第 9 条）；
2. 第二次（本轮核对覆盖范围时才发现）：加载第二个样本的路径也用了它，于是
   **8 项多文件检查在打包态一次都没跑过**，摘要却照样打印"58/58 通过"——
   而文档一直宣称打包态与开发态"完全相同"。修复后打包态也是 **68/68**（见 5.1 第 14 条）。

> ⚠️ 打包态要带 `--smoke-assets=<仓库 test-assets 目录>`：便携版旁边**没有**测试素材
> （26 MB 的测试数据不该塞进分发包）。不传这个参数时，那 8 项检查**会明确报一条失败**，
> 而不是静默少跑。

#### 端到端冒烟测试：`npm run smoke` **56 项通过 / 0 失败**s

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
| **需求 2 · 真实转换（真跑 ffmpeg）** | MP4→MP4 重编码 3.15 MB；**MP4→MP4 无损直通 661 KB**（明显快于重编码）；MP4→WebM（VP9+Opus）641 KB；MP4→H.265 247 KB；MP4→MP3 142 KB；**MP4→GIF（调色板两遍法）694 KB**；**回归：低分辨率源直接用 GIF 默认预设 1609 KB**；裁剪 1-3 秒 → 产物回读时长 2.00 s；小体积档压缩比 661 KB → 250 KB（**38%**） |
| 容器兼容性预检 | theora 源直通 MP4 被拦并给出人话建议；VP9 源直通 MP4 被正确放行（不过度拦截）；H.264 直通 WebM 被拦 |
| 错误翻译 | 磁盘满 / 未知编码器（显卡不可用）/ 容器不兼容三类均翻译为中文结论 + 修复建议 |
| 取消语义 | 取消的任务标记为 `canceled` 而不是失败 |
| 进度解析 | `25% · 2.5× · ETA 30.0s`；`01:02:03.5 → 3723.5s`；未知总时长时 `percent=null`（界面走不确定进度条） |

> 逐条用例清单与判定条件见 `docs/TEST_CASES.md` 的 A 部分。

#### 界面自检：三级命令，最高一级 `npm run smoke:ui:full` **68/68 全部通过**

启动真实 Electron 窗口，等待 `data-store-ready`，通过 `window.__lumenAddFiles()`
（内部就是拖拽用的同一个 `addFiles`）加载 `test-assets/samples/sample-h264.mp4`，逐页断言并截图。

三个级别是递进关系，检查项只在上一级基础上**追加**（14 → 49 → 61）：

| 命令 | 追加的动作 | 检查项 |
| --- | --- | --- |
| `npm run smoke:ui` | 启动窗口 → 等 `data-store-ready` → 逐页切换截图 | **14 项** |
| `npm run smoke:ui:file` | 加 `--smoke-file=…`，加载真实视频后再断言信息面板与缩略图 | **56 项** |
| `npm run smoke:ui:full` | 加 `--smoke-convert`，在应用内真的点一次「开始转换」并等任务跑到终态 | **68 项** |

`smoke:ui:file` 一级（56 项）的断言与实测结果：

| 断言项 | 实测结果 |
| --- | --- |
| 界面骨架与样式 | 标题栏 / 侧边导航 / 文件区 / 详情面板均渲染；`--accent` 等 CSS 变量已加载；`data-theme` 已应用 |
| preload API | `window.converter.probe` 为函数 |
| 真实文件加载 | 信息面板出现 **9 行**；缩略图 `src` 为 `lumen-media://…`；时长角标显示；**9 张预设卡片**可选（默认选中「MP4 通用兼容」）；产物体积预估显示「预计 3.71 MB」；详情含「画面＝640×360」 |
| 页面内容（防空白页） | 设置页 **5 个** `.settings .card` 分组；队列页标题存在；导航高亮正确落在「设置」 |
| 截图产出 | `main.png`、`main-with-file.png`、`queue.png`、`settings.png`（full 模式另加 `queue-done.png`，共 **5 张**） |

`smoke:ui:full` 在上一级基础上追加的 **10 项**（这一级才是"界面真的能用"的证据）：

| 追加断言 | 实测结果 |
| --- | --- |
| 应用内转换：`createJobs` IPC 可用 | 直接调 IPC 入队 **1 个**，状态 `queued` |
| 应用内转换：界面按钮可点击 | 按钮「开始转换」，`disabled=false` |
| **应用内转换：按钮点击真的创建了任务** | 点击前后引擎队列长度 **0 → 1**（点击前先清空队列，严格判定） |
| 应用内转换：任务已创建 | 队列共 1 个任务 |
| 应用内转换：状态为已完成 | `done` |
| 应用内转换：产物文件存在 | `test-assets\samples\sample-h264 (2).mp4`（**3.15 MB**） |
| 应用内转换：进度到达 100% | `percent=100` |
| 应用内转换：命令文本已记录 | 命令含 `ffmpeg` / `-i` |
| 应用内转换：队列页截图已生成 | `queue-done.png` |
| 应用内转换：队列卡片显示完成与产物大小 | 断言 `job-card` 的状态芯片文本含「已完成」；同一行明细里还打印采集到的产物大小与是否有「打开位置」按钮（明细为「已完成」，产物 3.15 MB，有打开按钮——**注意这两项目前只打印、未单独断言**） |

**结果：68/68 通过，退出码 0，且控制台不再出现任何 `An object could not be cloned.` 错误**
（这条错误是本轮修复的克隆缺陷的标志，见 5.1.1）。

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
| **NSIS 安装包没有产出** | `npm run dist:nsis`（`electron-builder --win nsis`）在本机**做不出来**：需要额外工具链（`app-builder-bin` / `nsis` / `winCodeSign`）与一份与 `@electron/get` **不通用**的 Electron 缓存，受限网络下两次实测都卡在同一处以 `Timeout awaiting 'request' for 600000ms` 失败（详见 4.3）。所以"安装后 `extraResources` 能把 ffmpeg/ffprobe 释放到 `resources/bin` 且能执行"这条**在安装包形态下仍未验证**；**便携版形态下已验证**（`resources/bin` 就是在那个位置，68/68 通过） |
| **便携版 exe 没有图标与版本信息** | `package-portable.mjs` 会调用 `electron-winstaller` 附带的 `rcedit.exe` 写图标与版本信息，但该版本 rcedit 在**路径含非 ASCII 字符**时（本项目路径含中文）报 `Fatal error: Unable to load file`，脚本如实跳过。实测 `Lumen-conv.exe` 的版本信息仍为 Electron 原值。**脚本刻意不做环境相关绕行**（例如复制到临时 ASCII 路径再改回），需要带图标的正式安装包时应在有网络的环境跑 `npm run dist:nsis` |
| ~~旋转自动转正~~ | **已补齐并修掉一个真 bug**。原来这条是"未验证"：合成素材的 `rotate=90` 在新版 ffmpeg 下不再被保留，用例静默走"跳过"分支（**假通过**）。现在用 `-display_rotation 90` 造出真正带显示矩阵的 `rot90.mp4`，验证中**发现旧实现手动 `transpose` 会导致转两次互相抵消**（产物 720×1280 而非 1280×720）。已改为交由 ffmpeg 自动转正，并有真实转码用例 + 防回归断言。详见 `docs/TEST_CASES.md` A9 |
| HDR 色调映射 | 没有 HDR 样本，`zscale`/`tonemap` 滤镜链一次都没执行过 |
| 硬件编码器**实际转码** | 探测层已确认真实可用性（QSV H.264 可用），但**没有任何一条真实转码用例走硬件编码器**——冒烟测试不覆盖 `capabilities.ts`，也没有用 QSV 真转过一个文件。NVENC / AMF 的真卡参数更无从验证 |
| 缩略图的**避黑场**能力 | 智能选帧路径确实跑过（能出图、能命中缓存），但 `testsrc2` 彩条素材里没有黑场，所以 `blackdetect` + `signalstats` 的"避开黑帧"逻辑**只是执行了，没有被证明能正确跳过黑帧** |
| 字幕选择 / 多音轨映射 | 合成素材没有字幕轨与多音轨，相关分支未覆盖 |
| GitHub 推送 | 见下节"交付状态" |

> 本轮状态变化：
> ① 原先列在本表的 **`--smoke-convert`（应用内真跑转换）已移出**——`npm run smoke:ui:full` 实测 **68/68 通过、退出码 0**（含"按钮点击真的创建了任务"这条严格断言），证据见 4.1 与 `docs/screenshots/queue-done.png`。
> ② 原先列在本表的 **"安装包 / portable 从未产出"已移出**——便携版已产出并实机验证（见 4.1.1），
> 但**安装包（NSIS）确实没做出来**，原因见 4.3；"能装成安装包"这一条仍然只是配置层面的准备。

### 4.3 为什么最终没有用 electron-builder 出 NSIS 安装包

这一条**不是设计取舍，而是本机环境限制**，必须写清楚，避免被读成"已经支持多种打包方式"。

**结论**：`electron-builder --win nsis`（`npm run dist:nsis` / `npm run dist`）在本机**无法完成**，
两次实测**都卡在同一处**，均以 `Timeout awaiting 'request' for 600000ms` 失败。

**两个原因**（都在脚本注释与 `README.md` 的"环境踩坑备忘"里留了记录）：

1. **它需要额外的工具链**：`app-builder-bin`、`nsis`、`winCodeSign` 都要在打包时按需获取，
   受限网络下这一步必然超时，而不是"慢一点还能出来"。
2. **它的 Electron 二进制缓存与 `@electron/get` 不通用**：`scripts/fetch-binaries.mjs --electron`
   用 `@electron/get` 把运行时下载到自己的缓存里，`electron-builder` 不认这份缓存，
   所以"本地已经有 Electron 的 zip"也帮不上忙，它仍然要重新下载。

**替代方案（已落地并实测）**：`scripts/package-portable.mjs` —— **完全离线**手工组装便携版，
只用本机已有的 `node_modules/electron/dist` 与 `resources/bin/`，不触发任何下载：
复制 Electron 运行时（排除 `default_app.asar`）→ 用 `@electron/asar` 把 `dist/` + `dist-electron/` + 精简
`package.json` 打成 `resources/app.asar` → 复制 ffmpeg/ffprobe 到 `resources/bin/` → 尝试写图标与版本信息 →
`rename` 收尾（失败回退为复制，Windows 上目录改名偶发 `EPERM`）。
产物 `release/Lumen-conv-便携版/` 已实机验证 **68/68 通过、退出码 0**（见 4.1.1）。

**没有拿到的东西（如实列出）**：electron-builder 生态里的 **NSIS 安装向导、自动更新、代码签名**，
以及"图标与版本信息由工具链正确写入"这一条——便携版的 exe 现在是 Electron 默认图标、版本信息仍是 Electron 原值。
需要这些时，应在**有网络的环境**执行 `npm run dist:nsis`；`package.json` 里的 electron-builder 配置保持完整可用。
决策记录见 `docs/DECISIONS.md` 的 **D-017**。

### 4.4 交付状态（GitHub）

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

本节分三部分：**5.1 已修复**（每条都给出修复方式与验证证据，其中 5.1.1 是缺陷复盘）、**5.2 仍然存在**、
**5.3 其他值得记录的细节**。本节结论全部以源码与实测输出为准。

> 修订说明：本节此前版本列的 12 条缺陷中，有 7 条已经修复（5.1 表格第 1-7 条），其余仍然成立（5.2）。
> 原"与任务描述不一致"一节里的 5 条已随此前的改动消解（见 5.1 末尾）。
> **前一轮新增第 8 条**：Vue 响应式代理导致 IPC 结构化克隆失败、「开始转换」静默失效——
> 它是文档对齐之后才被自测发现并修复的，根因、假通过与断言强化过程见 5.1.1。
> **本轮再新增第 9-11 条**（都是新增便携版打包能力时真实踩到的）：
> 打包态的 `app.getAppPath()` 被当成目录用导致 `ENOTDIR`、同一次自检里 `queue.png` 被 `queue-done.png` 覆盖、
> 以及「队列卡片显示完成与产物大小」由"只打印"改为真断言。

### 5.1 已修复（含修复方式与验证证据）

| # | 原问题 | 修复方式 | 验证证据 |
| --- | --- | --- | --- |
| 1 | **低分辨率源转 GIF 滤镜链以逗号开头，ffmpeg 直接失败** | `commands.ts` 的 `buildVideoArgs()` 中 `codecId === 'gif'` 分支不再用 `filterOnly()` 取前置滤镜后拼接，而是**把调色板链合并进已有的 `-vf`**：有 `-vf` 就把 `[已有值, paletteChain].filter((s) => s.length > 0).join(',')` 写回，没有就 `args.push('-vf', paletteChain)` 新建。空串被过滤掉，因此不会产生前导逗号 | ① 命令装配用例「GIF 预设使用单次调用的内联调色板两遍链」断言 `!vf.startsWith(',')` 且前置 `fps=15` 被保留在同一侧；② 回归用例「回归：GIF 前置滤镜为空时不能生成前导逗号」构造"源就是 480p + 不改帧率"的场景，断言以 `split` 开头；③ **真实转码**回归用例「回归：低分辨率源直接用 GIF 默认预设（无前置滤镜）」用 640×480 源 + 480p 档 + `fpsId: 'source'` 真跑 ffmpeg，产出 **1609 KB** 有效 GIF。三条用例在 `npm run smoke` 中全部通过 |
| 2 | GIF 调色板 PNG 被预生成却未被主命令消费，白跑一个 ffmpeg 进程 | **整套预生成机制已删除**：`BuiltCommand` 不再有 `prePasses` / `postPasses` 字段，`VideoPlan` 不再有 `twoPass` 字段，`buildPaletteArgs()` / `filterOnly()` / `engine.cleanupPalette()` 均已删除，`InternalJob` 不再有 `palettePath` / `currentStage` / `prePassesDone`。GIF 现在**只启动一个 ffmpeg 进程、不落地任何临时调色板文件** | 全仓库 grep 上述符号：0 命中。`convert.ts` 的 `run()` 里 `const mainArgs = built.args;` 直接跑单条命令 |
| 3 | `postPasses` / `twoPass` 是死代码 | 随第 2 条一并删除，类型与实现里都不再存在 | 全仓库 grep `postPasses` / `twoPass`：0 命中 |
| 4 | `AppSettings.hardwareAcceleration` 从未被读取，而 `errors.ts` 却让用户去设置里关它 | **字段直接删除**（连同同样没被读取的 `safeMode`），`DEFAULT_SETTINGS` 同步移除；`errors.ts` 里"当前环境不支持所选的编码器"的 `hint` 改为引导用户去**「专业参数 → 视频编码器」改回软编码（H.264 / H.265）**——指向一个真实存在的界面位置 | `shared/types.ts` 的 `AppSettings` 与 `DEFAULT_SETTINGS` 中已无这两个字段；`errors.ts` 的 `unsupported-codec` 规则 hint 文本为"请在「专业参数 → 视频编码器」里改回不带「显卡加速」的软编码" |
| 5 | `AppSettings.openFolderOnFinish` 只存不用 | `renderer/composables/useStore.ts` 的 `onJobUpdated` 里检测**任务首次变为 `done`**（`job.state === 'done' && prev?.state !== 'done'`），此时若 `settings.openFolderOnFinish` 为真则调用 `api.openOutput(job.id)`。用 `prev?.state !== 'done'` 判断是为了避免后续任何一次 `job:updated` 重复打开资源管理器 | `useStore.ts` 的 `justFinished` 分支；`main.ts` 的 `jobs:open-output` handler 用 `shell.showItemInFolder` 实现 |
| 6 | `settings:reset` 与 `jobs:cancel-all` 通道已注册但 preload 无入口，设置页也没有「恢复默认设置」按钮 | `preload.ts` 已暴露 `resetSettings()` 与 `cancelAllJobs()`，`shared/types.ts` 的 `ConverterApi` 同步补齐；`SettingsView.vue` 底部 `about` 区新增「恢复默认设置」按钮（`resetAll()`），调用 `resetSettings()` 后回写 `settings` 并重新应用主题 | `preload.ts` 的 `resetSettings` / `cancelAllJobs` 键；`main.ts` 的 `settings:reset` / `jobs:cancel-all` handler；`SettingsView.vue` 的 `resetAll()` |
| 7 | 设置页的路径与目录只能手输，没有「浏览」按钮 | 新增 `dialog:pick-executable` handler（`main.ts`）+ preload 的 `pickExecutable()`；`SettingsView.vue` 的 ffmpeg / ffprobe 路径输入框旁各有「浏览」按钮，默认输出目录有「选择目录 / 恢复默认」，缩略图缓存有「清理缓存」（走 `cache:clear-thumbnails` → `clearThumbnailCache()`） | 上述三处 handler 与按钮均在源码中；设置页实测渲染出 5 个 `.settings .card` 分组，自检要求 ≥ 3 即通过 |
| 8 | **Vue 响应式代理导致 IPC 结构化克隆失败，「开始转换」按钮静默失效**（本轮新发现，最严重的一条） | `useStore.ts` 的 `effectiveOptions()` 由 `{ ...options.value, ...(file.overrides ?? {}) }` 改为 `JSON.parse(JSON.stringify(merged))`，把整个结构从响应式图上摘下来；`startConversion()` 用 `try/catch` 包住 `api.createJobs()`，失败时 `console.error` + `showToast('无法创建转换任务：' + msg, 'danger', 8000)`。**完整根因、影响面与复盘见 5.1.1** | 界面自检升到 `--smoke-convert` 一级并加严格断言后：`npm run smoke:ui:full` **68/68 通过、退出码 0**，控制台无任何 `An object could not be cloned.`；`test-assets\samples\sample-h264 (2).mp4` 3.15 MB 真实产出（见 `docs/screenshots/queue-done.png`） |
| 9 | **打包态路径 bug：便携版上一启动自检就抛 `ENOTDIR, not a directory`**（真实踩坑，只有打包形态才暴露） | 自检的基准目录原来直接用 `app.getAppPath()`。开发态它确实是**项目根**，但在打包态它指向 `...\resources\app.asar` —— 那是一个**文件**，而代码拿它去 `mkdirSync(<base>/docs/screenshots)`，于是 `ENOTDIR`。修复：`electron/main.ts` 新增 `smokeBaseDir()`，`app.isPackaged` 为真时返回 `path.dirname(app.getPath('exe'))`（安装目录 / 便携版目录），否则返回 `app.getAppPath()`；**截图目录**与 `--smoke-file=` 的相对路径解析都改用它 | ① 便携版 `release/Lumen-conv-便携版/Lumen-conv.exe --smoke --smoke-file=… --smoke-convert` 实测 **68/68 通过、退出码 0**（修复前在该形态下无法启动自检）；② 开发态 `smoke:ui:*` 行为不变，仍 **68/68**；③ 便携版目录下**没有**出现 `docs/screenshots/`（截图按设计落在 exe 旁边，运行时可写） |
| 10 | **同一次自检里截图互相覆盖：`queue.png` 与 `queue-done.png` 是同一张图** | 原来的顺序是"转换完成后先截 `queue-done.png`、再截 `queue.png`"，后者把第 1 步产出的**空队列**那张覆盖成同一张图（两个文件 sha256 完全相同），而文档仍宣称"`queue.png` 是空队列"。修复：用 `const ranConversion = process.argv.includes('--smoke-convert')` 判定，**跑过转换时不再写 `queue.png`**，仅在它不存在时 `console.warn` 提示"请先跑一次不带 `--smoke-convert` 的自检"；同时把正确的两步工作流写进 `main.ts` 的注释 | 重新生成后实测：`queue.png` **22,942 字节（22.4 KB，稳定）**（空队列）；`queue-done.png` **54–58 KB 波动**（有任务）——**哈希不同**。两步命令：`npm run smoke:ui:file` → `npm run smoke:ui:full`。注：`queue-done.png` 的字节数只对当次运行成立，因为任务卡片带「已用时」文本，截图瞬间的秒数不同就会改变 PNG 字节；`queue.png` 不含时间信息所以逐字节稳定。文档记录它们是为证明"两张图确实不同"，不是固定契约 |
| 11 | 顺带修：「队列卡片显示完成与产物大小」这条此前**只打印不断言** | `main.ts` 里该检查项由"只采集并打印"改为真断言：`queueReport.state.includes('已完成') && /\d/.test(queueReport.outSize) && queueReport.hasOpenBtn`，即**状态芯片含「已完成」+ 产物大小含数字 + 卡片上存在「打开位置」按钮**三者同时成立才通过 | 同一处 `extraChecks` 的判定表达式；实测输出「已完成」/ 产物 3.15 MB / 有打开按钮，全部断言通过 |
| 12 | **同类根因的第二批：质量 / 分辨率 / 帧率 / 编码器 / 音频 / 文件名模板全都写进了「按文件的 overrides」**（用户追问"质量下拉可以用吗"时发现） | 与第 8 条同源：界面回显读全局、写入却写按文件覆盖，后果是**调好的参数一换文件就全丢**，且界面上看不出任何征兆。修复：按语义分两类——表达"我想转成什么样"的走全局 `options`，真正与具体文件绑定的（裁剪区间、字幕轨道勾选）保留按文件覆盖；控件回显统一改用 `effectiveOptions(file)`，保证"界面显示的值 == 真正用于转换的值" | 新增 4 项质量下拉断言 + 1 项与 ffmpeg 命令对上的硬断言（切「极小体积」后真实任务命令里必须出现 `-crf 34`），实测 `-crf 34` 与界面选择一致 |
| 13 | **「推荐 / 自定义」两种模式的差别全在折叠线以下，用户看不出区别**（本轮用户真实反馈，原话"推荐设置和自定义没区别啊"） | **功能存在 ≠ 用户感知到**：代码里两种模式确实不同（专业参数区块 + 帧率下拉只在自定义模式出现），但这两处都在 900px 之外。量化根因：① 「视频信息」默认展开占约 270px，把「用途」推到 376px；② 专业参数挂在面板末尾。修复四处：① 视频信息默认收起成一行摘要（`infoOpen`）；② 模式切换下方新增「当前方案摘要」`plan-summary`；③ 专业参数区块**整体搬到面板最上面**（仅自定义模式出现，改名「专业参数」）；④ **取消**"切到自定义自动展开专业参数" | 自检新增断言"自定义模式：专业参数入口出现在首屏"实测 `专业参数@152`；"两种模式在首屏就有可见差别"现在**把两种模式的首屏都打印出来**（推荐 `视频信息@152 / 你要拿去干什么@235 / 在哪播 / 多大体积@646`；自定义 `专业参数@152 / 视频信息@205 / 你要拿去干什么@288 / 在哪播 / 多大体积@699`）。`smoke:ui:file` **56/56**、`smoke:ui:full` **68/68**，退出码 0。对照截图 `mode-recommended.png` / `mode-custom.png`。决策与代价见 `DECISIONS.md` D-018 |
| 14 | **打包态有 8 项检查被静默跳过 —— 文档却宣称"与开发态完全相同"**（本轮核对覆盖范围时发现，是 ENOTDIR 那条的漏网之鱼） | 第 9 条修 `app.getAppPath()` 时只改了**截图目录**与 `--smoke-file=` 两处，**漏了第三处**：加载第二个样本的路径仍写 `path.join(app.getAppPath(), 'test-assets', …)`。打包态 `app.getAppPath()` 是 `...\resources\app.asar`（文件），拼出来的路径永远不存在 → `if (existsSync(secondSample))` 为假 → **跨文件保留 / 勾选 3 项 / 质量联动 4 项，共 8 项检查一次都没跑过**，而摘要照样打印"58/58 通过"。这就是"少跑"伪装成"通过"：**只要没人数检查项个数，就永远发现不了**。修复：① 路径改用 `smokeBaseDir()`；② 新增 `--smoke-assets=<目录>` 参数（打包态 exe 旁边没有 test-assets，测试素材也不该塞进分发包）；③ **样本缺失时不再静默跳过，而是明确 push 一条失败**，提示怎么修 | 实测：便携版 `--smoke --smoke-file=… --smoke-assets=<仓库 test-assets> --smoke-convert` → **68/68 通过、退出码 0**（修复前是 58/58 且无人察觉）；故意传一个不存在的 `--smoke-assets` 时 → **46/47、退出码 1**，失败项文字直接说明"这 8 项检查会被跳过"（这条是"失败必须可见"的反向验证）。另外顺带确认：GUI 子系统 exe 用 PowerShell 的 `& exe … \| Select-String` 拿到的**不是**进程真实退出码，要用 `Start-Process -Wait -PassThru` 读 `.ExitCode` |
| 15 | **自定义模式里还摆着一排"用途推荐卡片"，用户认为不专业**（本轮用户真实反馈，原话"自定义不要这个推荐，缺少专业性，这个用最初那个版本自己调整更合适"） | D-018 只解决了"两种模式看不出区别"，但用户的下一层意思是**自定义模式根本不该出现推荐**。修复：① 「你要拿去干什么」整块在自定义模式下不渲染（连同"已偏离推荐值"提示与用途小贴士——它们讲的全是推荐值）；② 专业参数**常开**，删掉折叠开关与 `advancedOpen` 状态；③ 摘要行在自定义模式下显示「自定义参数」，而不是用户看不到、也改不了的用途名；④ **兼容性预检拆成独立区块、两种模式都显示**（它讲的是事实不是推荐，而且自定义模式下更容易手选 H.265 配老电视）；⑤ 区块顺序改由 CSS `order` 控制（不复制模板）：专业参数 → 质量与尺寸 → 在哪播 / 多大体积 → 视频信息 → 兼容性预检 | 新增两条专门盯这次需求的断言：「自定义模式：不出现用途推荐卡片」实测卡片数 **0**；「推荐模式：用途推荐卡片齐全」实测 **8**；并把"自定义模式出现专业参数"升级为"**且字段直接可见，不需要再点一次**"。`smoke:ui:file` **56/56**、`smoke:ui:full` **68/68**，退出码 0；便携版 **68/68**、退出码 0。对照截图 `mode-recommended.png`（8 张卡片）与 `mode-custom.png`（无卡片、参数铺满首屏）。决策与代价见 `DECISIONS.md` D-019 |

> 第 13 条还附了一个**自己造的坑**：把专业参数区块搬到最上面时，第一版只搬了开标签、
> 没搬内容、还多留了一个 `</div>`，于是 `pro-block` 把「视频信息 / 用途 / 在哪播 / 质量」全包了进去——
> 推荐模式下这些区块会被 `v-if="appMode === 'custom'"` **整体隐藏**。
> 好在 `vite build` 直接报 `Element is missing end tag`、`vue-tsc` 也不过，**构建期就拦住了**。
> 教训写在 D-018：搬动模板片段必须把"开标签 / 内容 / 闭标签"作为整体移动，改完立刻构建一次。

> 第 15 条又踩了一个同类但更隐蔽的坑：`evalJs` 的表达式是**模板字面量**，
> 我在里面写注释时用了反引号包住 `.usecase-card.active`，反引号提前结束模板串，
> 后面的内容被当成 JS 表达式解析，编译出的代码里凭空多出一个未定义的 `card`，
> 自检直接 `ReferenceError: card is not defined` 中断。
> **规则：`evalJs` 的表达式字符串里（包括注释）绝不出现反引号。**
> 注意：第 13 条的结论已被第 15 条取代——自定义模式下专业参数**常开**（不再有折叠入口），
> 用途卡片**整块不渲染**。相应地，"自定义首屏"的实测值也从
> `专业参数@152 / 视频信息@205 / …` 变成了只有 `专业参数@152`（参数面板占满首屏）。

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

### 5.1.1 案例复盘：「开始转换」静默失效——一条活过两轮自测的缺陷

这是本项目迄今为止**最严重**的一条缺陷：它让核心功能（点按钮开始转换）**完全不可用**，
而且**不报错、不崩溃、界面没有任何反应**。它值得单独复盘，因为"为什么它能活这么久"比"修了什么"更有价值。

**用户可感知的表现**

- **观察到并复现的路径**：在「专业参数 → 字幕轨道」里勾选或取消过任何一条字幕（即向该文件的 `overrides` 写入过内容）之后，
  点「开始转换」**什么都不发生**：队列页没有任何任务、按钮看起来正常、只有一个没有上下文的控制台错误。
- **进一步核对后的结论（影响面比最初观察到的更大）**：`options` 本身也是响应式的，它的
  `subtitleStreamIndexes` / `audioStreamIndexes` 两个数组字段**无论用户是否动过字幕，都已经是 Proxy 数组**。
  所以只要旧表达式成立，"没改过字幕"同样会失败——**旧实现里每一次点「开始转换」/「转换这个文件」都点不出任务**，
  "改过字幕"只是当初复现它的路径，不是必要条件。依据是下面的最小实验，证据边界见本节末尾。

**根因（三段链条）**

| 环节 | 发生了什么 |
| --- | --- |
| ① 状态写入 | `useStore.ts` 的 `setActiveOverride()` 把 `subtitleStreamIndexes` / `audioStreamIndexes` 写进 `file.overrides`；`files` 是 `ref`，于是这两个**数组字段被 Vue 包成了 Proxy 数组**。注意：**`options` 这个 `ref` 里的同名字段本身就是 Proxy 数组**，所以这一环不是必要条件 |
| ② 传参构造 | 旧实现 `effectiveOptions()` 是 `{ ...options.value, ...(file.overrides ?? {}) }`——展开运算符读的是响应式代理，合并结果里的数组仍是 Proxy |
| ③ 跨进程传输 | `startConversion()` 把合并结果塞进 `CreateJobRequest` 交给 `api.createJobs()` → `ipcRenderer.invoke`。Electron IPC 用**结构化克隆（structuredClone 语义）**序列化参数，而 Proxy 不可克隆，于是抛 `An object could not be cloned.` |

**可复现的最小实验**（Node + 与本项目同版本的 Vue，不需要启动应用）：

```bash
node -e "const {ref,isProxy}=require('vue');const o=ref({subtitleStreamIndexes:[],audioStreamIndexes:[]});const m={...o.value};console.log('isProxy(array) =',isProxy(m.subtitleStreamIndexes));try{structuredClone(m);console.log('structuredClone: OK')}catch(e){console.log('structuredClone:',e.name,'-',e.message)};structuredClone(JSON.parse(JSON.stringify(m)));console.log('after JSON round-trip: OK')"
```

实测输出：

```
isProxy(array) = true
structuredClone: DataCloneError - [object Array] could not be cloned.
after JSON round-trip: OK
```

三行输出分别对应：① 展开响应式对象得到的就是 Proxy 数组；② 它无法被结构化克隆（正是 `ipcRenderer.invoke` 会走的那条路）；
③ JSON 往返之后可以正常克隆——也就是修复的两行代码。

> 证据边界：修复前的源码**不在 git 历史里**（仓库此前从未提交过源码，索引中的版本已是修复后的版本），
> 所以上面的旧表达式取自当时的改动说明；"旧实现下每次点击都会失败"是由该表达式 + 上面的实验推出的结论，
> 而不是从旧源码里读出来的。修复后的代码、实验输出与 `smoke:ui:full` 的 68/68 都是可直接核对的。

旧实现的 `startConversion()` 内部没有 `try/catch`，异常沿 Promise 一路向外传：
两个调用点（`FileList.vue` 的 `convertAll()`、`DetailsPanel.vue` 的 `convertThis()`）虽然 `await` 了它，
但**只 `await` 不 `catch`**（`FileList.vue` 只有 `try/finally` 用来复位 `busy`），
而它们又是模板里的 `@click` 处理函数（`@click="convertAll"` / `@click="convertThis"`），
没有任何地方能把错误变成用户可见的反馈。于是结果就是：控制台留一行没有上下文的错误，界面**点了没反应**。

**修复**

```ts
// useStore.ts
export function effectiveOptions(file: LoadedFile): ConversionOptions {
  const merged = { ...options.value, ...(file.overrides ?? {}) };
  return JSON.parse(JSON.stringify(merged)) as ConversionOptions;   // 去响应式
}
```

- 用 **JSON 往返**而不是 `structuredClone`：这个结构里只有字符串 / 数字 / 布尔 / null / 数组，
  没有 Date、Map 等需要保类型的值，JSON 往返最稳妥且不依赖运行环境（决策记录见 `DECISIONS.md` 的 D-016）。
- 同时把桥接层兜住：`startConversion()` 用 `try/catch` 包住 `api.createJobs()`，
  失败时 `console.error('[startConversion] createJobs 调用失败：' + msg)` 并
  `showToast('无法创建转换任务：' + msg, 'danger', 8000)`——**这类错误以后不会再静默**。

**为什么前两轮自测没抓到它（关键）**

1. **"直接调 API"的路径本来就是好的**。`createJobs` 这条 IPC 链路没有问题：自检脚本里直接调用它
   （`--smoke-convert` 的"直接调用 createJobs 诊断"）能成功入队并跑完整个转换。
   所以任何"绕过界面、直接调 API"的验证都会全绿，包括 `npm run smoke`（它根本不加载渲染进程代码）。
2. **按钮路径失败了却不报错**：点了没反应，控制台只有一行无上下文提示，看起来像"截图脚本点空了"，
   而不像"产品缺陷"。
3. **最早的断言是假通过**：那时只断言"截图生成成功 / 队列里有任务卡片"。
   而队列里**恰好已经有一个任务**——上一步诊断用的直接 IPC 任务还没被清掉，
   于是"队列里有任务"这条断言**在按钮失效的情况下同样成立**。
4. **`void el.click(); true` 的克隆陷阱又把水搅浑**：早期写法里 `void` 只丢弃值，
   DOM 节点仍会作为表达式中间值被结构化克隆，同样抛 `An object could not be cloned.`，
   让整个 `await` 失败。看到这个报错时，第一反应容易归到"截图脚本的毛病"上，而不是"产品代码的毛病"。

**断言怎么改才暴露它**

把断言从"流程跑完了吗"改成"**这次操作造成的副作用发生了吗**"：

```js
// electron/main.ts 的 --smoke-convert 分支
for (const j of engine.list()) await engine.remove(j.id);   // 点击前先清空队列
const beforeClick = engine.list().length;                    // 期望 0
// …点击「开始转换」…
extraChecks.push(['应用内转换：按钮点击真的创建了任务', enqueued /* 0 → 1 */, `点击前后队列长度 ${beforeClick} → ${engine.list().length}`]);
```

清空前置 + 数量必须变化，这两点合起来才让"点击是否真的创建了任务"变成一个**不可被其它路径满足**的命题。

**预防同类问题（已落地的四条）**

| 措施 | 位置 |
| --- | --- |
| 跨 IPC 传参统一走"去响应式的纯对象"，并写进决策记录 D-016 | `useStore.ts`、`docs/DECISIONS.md` |
| 桥接层错误必须翻译成用户可见的 toast，不允许静默 reject | `useStore.ts` 的 `startConversion()` |
| `executeJavaScript` 一律包 IIFE、以基本类型收尾，并用 `evalJs(label, expr)` 给每一步加标签（原生克隆错误**不带位置信息**） | `main.ts` 的 `runSmokeCheck()` |
| 渲染层挂全局 `unhandledrejection` / `error` 监听并显式 `String()` 化错误（直接打印事件对象打不出内容） | `renderer/App.vue` |

**同一轮的其他加固**

- `notifyDone()` 的 `Notification.requestPermission()` 返回 Promise，已改为 `void … .catch()`，
  避免同类克隆问题把任务更新流程带崩。
- `renderer/components/FileList.vue` 的 `.file-sub` 的 `gap` 由 5px 调整为 6px
  （截图里出现过 `MP4 / QuickTime661 KB` 这种粘连）。
- `test-assets/output/` 与 `test-assets/samples/` 已在 `.gitignore` 中排除（第 31、32 行），
  自检产物不会入库。

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
- `.gitignore` 已排除 `resources/bin/`（约 291 MB：ffmpeg 139.1 MB + ffprobe 138.9 MB）、`.downloads/`
  （归档缓存，复用下载用）与 `release/`（打包产物）。**仓库不提交二进制与打包产物**，克隆后需要 `npm run setup`
  或 `node scripts/fetch-binaries.mjs`；文件里也写明了这样做的三条理由与"需要开箱即用整包时用
  `npm run dist:portable` 的便携版目录 / 安装包 / Release 附件"的替代方案。
- `.gitignore` 同时忽略了 `test-assets/output/` 与 `test-assets/samples/`（第 31-33 行，冒烟测试的产物与合成素材），
  两处**都不入库**。需要说清的是：**忽略 ≠ 清空**——工作区里这两个目录**仍然存在文件**
  （`output/` 是最近一次 `npm run smoke` 的 9 个产物：`smoke-copy.mp4` / `smoke-gif-480p.gif` / `smoke-h264.mp4` /
  `smoke-hevc.mp4` / `smoke-small.mp4` / `smoke-trim.mp4` / `smoke.gif`(0 字节) / `smoke.mp3` / `smoke.webm`；
  `samples/` 是 7 个合成素材：`broken.mp4` / `empty.mp4` / `sample-480p.mp4` / `sample-audio.mp3` /
  `sample-h264.mp4` / `sample-hevc.mkv` / `sample-rotated.mp4`）。
  **已知现象**：`smoke:ui:full` 在应用内转换时 `outputDir` 为 `null`，`convert.ts` 的 `resolveOutputPath()`
  会落回**源文件同目录**，而 `overwrite: false` 又触发自动改名（`名称 (1).ext`、`名称 (2).ext`……），
  所以每跑一次就会在 `test-assets/samples/` 里多出一个 `sample-h264 (n).mp4`。
  本轮核对时**带序号的产物已被清理干净**（全项目搜索 `(\d+)` 形式的文件名：0 命中），
  但**下次跑 `smoke:ui:full` 仍会重新产生**，这不是缺陷而是"默认输出目录 + 不覆盖"两条设计叠加的必然结果。
  此前记录过的陈旧产物 `.palette-smoke.png`（已删除的 GIF 调色板预生成功能遗留）本次检查中已不存在。
- 根目录有一个空的 `.qtprobe/` 目录，来源不明，与项目无关。
- **`npm run smoke:ui` 在"已有实例运行"时不会真正执行，但看起来像成功了**：`main.ts` 顶部用
  `app.requestSingleInstanceLock()` 做单实例保护。本次核对中实测到：当**另一个** Electron 实例
  （携 `--smoke --smoke-file=… --smoke-convert`）正在运行时，再执行 `npm run smoke:ui`
  **不会刷新 `docs/screenshots/` 里的任何 PNG**，而命令本身**并不报错**（退出码 0）。
  换句话说，此时"自检通过"的实际含义是"另一个实例在跑"，容易把"没跑"误读成"跑过了"。
  **建议**：跑界面自检前先确认没有其它实例（`Get-Process electron`），并把 `docs/screenshots/*.png`
  的时间戳作为"本轮确实跑过"的旁证。此问题与单实例保护的行为细节（`app.quit()` 之后 `whenReady()` 是否仍触发
  `runSmokeCheck()`）**尚未逐行确认**，此处只记录可复现的现象，不推断内部机制。
- 本次核对期间代码库处于**持续修改状态**（此前核对过程中 `package.json` 新增了 `make:icon` / `fix:esbuild` /
  `smoke:ui:full`，`renderer/App.vue` 又补了一条"`__lumenAddFiles` 必须返回 `undefined`"的注释——
  因为 `executeJavaScript` 用结构化克隆传值，返回 Vue 响应式对象或 Promise 会让渲染进程崩溃；
  本轮又把这条约束从"注释提醒"变成了 `effectiveOptions()` 的强制去响应式 + `evalJs()` 的标签化封装，
  见 5.1.1）。因此本文档中的引用一律用**函数名 / 符号名**而不是行号；
  具体数字（文件大小、耗时、版本号）均为实测值，实测环境为 `ffmpeg N-126435-gf93cd72dde-20260906`。
- **截图的一个曾经容易误解之处（已修复）**：`queue.png` 与 `queue-done.png` 一度是**同一张图**（sha256 相同）——
  `smoke:ui:full` 在转换完成后再截一次 `queue.png`，把前一步产出的空队列那张覆盖掉了。
  现在 `main.ts` 用 `ranConversion` 判定：**跑过转换就不再写 `queue.png`**，只在它不存在时提示。
  实测两者已**哈希不同**（`queue.png` 空队列稳定在 22,942 字节 / `queue-done.png` 有任务，54–58 KB 波动，
  因为它含「已用时」文本）。
  正确的两步工作流是 `npm run smoke:ui:file`（出空队列 `queue.png`）→ `npm run smoke:ui:full`（只加 `queue-done.png`）。
  详见 `docs/screenshots/README.md`。

---

## 6. 遗留问题与后续可做的事

按优先级排列：

1. **在有网络的环境产出并验证 NSIS 安装包**（当前最大的空白）：便携版已在本机实测跑通（见 4.1.1），
   缺的是**安装包**——`npm run dist:nsis` 需要额外工具链与独立的 Electron 缓存，本机受限网络下做不出来（见 4.3）。
   需要在联网环境执行，并在安装后确认 `resources/bin/ffmpeg.exe` 与 `ffprobe.exe` 被正确释放
   （`process.resourcesPath/bin`）、能真的转一个文件、且 exe 的图标与版本信息被正确写入。
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
6. **决定二进制是否入库**，然后完成首次提交与推送（见 4.4）。当前 `.gitignore` 已排除，即取向是"忽略二进制"。
7. **给 GIF 加硬性限制**：例如时长超过阈值时提示或自动截取前 N 秒，而不是只靠预设 `tip` 文字提醒（第 5.2 节第 5 条）。
8. **评估接入硬件解码**（`-hwaccel` 系列参数），当前只用了硬件编码。
9. 让界面上能看见已实现的全部快捷键（`Ctrl+1/2/3` 目前无提示，第 5.2 节第 13 条）。
10. 考虑：任务队列持久化（重启后保留历史）、缩略图缓存容量上限与 LRU 清理、打包产物的代码签名。
11. **补齐便携版打包缺的那一块**：给 `package-portable.mjs` 找一个**不依赖具体环境**的图标写入方式
    （当前 `rcedit.exe` 在含中文的路径下报 `Fatal error: Unable to load file`，脚本刻意跳过了绕行方案），
    或让便携版也走一遍"有网络环境构建"的流程以获得带图标、带版本信息的 exe。
