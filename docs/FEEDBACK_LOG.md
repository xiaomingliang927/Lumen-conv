# 反馈记录（Lumen-conv 视频格式转换器）

本文件记录这次协作中**人类（项目所有者 / 雇主）给出的反馈与要求**，以及 AI 的响应与落地情况。
同时附一节「待用户确认的问题」，列出目前仍需要人类拍板的事项。

记录原则：只记录真实发生过的反馈。AI 自己的判断与推演不算"反馈"，即便它影响了后续动作。
**开发者 / AI 自测发现的缺陷同样不是用户反馈**，因此单列一行并明确标注来源（"反馈来源"列写明"不是用户反馈"），
不与人类反馈混同。

---

## 1. 反馈与响应记录

| 时间 / 阶段 | 反馈来源 | 反馈内容 | AI 的响应与落地情况 |
| --- | --- | --- | --- |
| 立项阶段 | 项目所有者（转述线上笔试题目） | 提供线上笔试的 **7 条原始要求**，作为本次会话的最高优先级约束：① 视频信息显示 + 缩略图；② 用 ffmpeg 命令行转换；③ 自主优化；④ 生成会话总结 md 并记录开发者决策与反馈；⑤ 提交 github；⑥ 界面选型必须与"客户端"关联，关联为 0 不予考虑；⑦ 设计目标是给人用，不能做的东西自己都用不明白甚至不测试 | 把 7 条要求当作需求基线，逐条拆成可验证的功能点，并在实现完成后逐条回溯。落地情况：<br>① `probe.ts` + `thumbnail.ts`（智能选帧 + 磁盘缓存）<br>② `commands.ts` + `process.ts`，界面可展开查看完整命令行原文<br>③ 12 项自主优化，逐条列出代码位置（见 `README.md`）<br>④ 本次交付的 `docs/SESSION_SUMMARY.md` + `docs/DECISIONS.md` + `docs/FEEDBACK_LOG.md`<br>⑤ 配置远端仓库；实际推送状态见下方"交付方式"行与 `SESSION_SUMMARY.md`<br>⑥ 选 Electron（详见 `DECISIONS.md` D-001），并在 README 中单独举证"为什么这是真桌面应用"<br>⑦ 界面层的可用性投入：拖拽即添加、空状态引导、失败任务不死路、全中文文案、设置页诊断区、深浅色主题 |
| 选型阶段 | 项目所有者 | 在 AI 给出选型分析（Electron vs Tauri vs PySide6 vs WPF，含本机环境探测结果）之后，**选择了「Electron + Vue 3 + Vite + TypeScript」**，而非 Tauri / PySide6 / WPF | 按此选型落地，未再回退讨论其他三条路线。后续所有实现（进程模型、esbuild 打包主进程、electron-builder 打包、`extraResources` 释放二进制）都建立在这个选型上。备选方案与本机环境探测的对应关系记录在 `DECISIONS.md` 的 D-001 |
| 交付方式（较早阶段） | 项目所有者 | 选择「**现在就给仓库地址和凭据，全程直接推 GitHub**」的交付方式，并提供仓库 `git@github.com:xiaomingliang927/Lumen-conv.git`（**SSH** 形式） | 配置 `origin` 为该 SSH 地址。因受限环境里 MSYS 版 ssh 报 `couldn't create signal pipe`，按环境限制改用 **Windows 原生 OpenSSH**：`git config core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"`。远端仓库原有 README 内容仅一行 `# Lumen-conv`，按约定**重命名为 `README.upstream.md` 保留**（未删除上游文件）。<br>⚠️ **实际推送尚未完成**：核对时 `git log` 仅有 1 个提交（即远端原有的 `Initial commit`），本项目全部源码仍为未跟踪状态。详见 `SESSION_SUMMARY.md` 第 4.3 节 |
| 会话中途 | 项目所有者 | 把会话的**沙箱策略从"询问"改为"完全放开文件访问"**，解除文件写入限制 | 解除限制后，源码落盘、依赖安装、二进制下载与解包、构建产物生成都不再被沙箱拦截，这也是 `scripts/install.mjs` 能把 npm 缓存固定到项目内 `.npm-cache/` 的前提（此前写工作区外缓存目录会 `EPERM`）。该限制的解除记录在 `README.md` 的"环境踩坑备忘"第 1 条与 `scripts/install.mjs` 的注释中 |
| 文档阶段（上一轮） | 项目所有者 | 要求为项目补齐交付文档，并**明确要求"不要编造事实"**：只使用已给出的信息，且必须用 read/grep/glob 读源码核实细节；不确定的地方写"待验证"；并如实报告代码与描述不一致之处 | 逐份核对源码（`package.json`、`shared/`、`electron/`、`renderer/`、`scripts/` 与构建配置），产出交付文档；**并且不只做静态核对，还实际执行了仓库自带的验证命令**。`docs/SESSION_SUMMARY.md` 第 4 节据此区分"已实机验证 / 尚未验证"，第 5 节列出描述与代码不一致或实现有缺口的地方 |
| 文档同步阶段（上一轮） | 项目所有者 | 指出"上一轮文档产出之后代码发生了多处修复与变更"，要求把文档与当前代码对齐；**再次强调先读代码再改文档**，如果代码与描述不符以代码为准并在汇报中指出；并给出变更清单（依赖与二进制来源、GIF 缺陷修复、源码目录改名、图标与界面自检等） | 逐项用 read/grep/glob 核实全部 14 条变更描述，并重跑三条验证命令：`npm run typecheck`（退出码 0）、`npm run smoke`（**50/50 通过**）、`npm run smoke:ui:file`（**32/32 通过**，产出 4 张截图）。据此把 7 份文档全部对齐。**核实中发现描述与代码/实测不符之处并如实上报**，例如：实测压缩比为 661 KB → 250 KB（**38%**）而非描述里的 36%；低分辨率 GIF 回归产物为 **1609 KB** 而非描述里的 1546 KB。另外查出一条描述里没提到的问题：已有 Electron 实例持单实例锁时 `npm run smoke:ui` 不会刷新截图却不报错。核对期间代码库仍在被另一侧修改（`package.json` 新增脚本、`renderer/App.vue` 补注释），因此本轮所有数字都绑定到核实时的代码状态并在文档中注明 |
| 开发阶段（文档对齐之后） | **开发者 / AI 自测（不是用户反馈）** | 界面自检强化到 `--smoke-convert` 一级、并把断言改成"点击前后引擎队列长度必须 0 → 1"之后，暴露出**一条此前两轮自测都没抓到的严重缺陷**：Vue 响应式代理导致 IPC 结构化克隆失败，「开始转换」按钮静默失效（最先在"改过字幕勾选"这条路径上复现；进一步核对表明旧表达式下**每次点击都会失败**）；同时暴露出 `executeJavaScript` 的 `void el.click(); true` 克隆陷阱（`void` 只丢弃值，DOM 节点仍会被结构化克隆） | 修复 `useStore.ts` 的 `effectiveOptions()`（JSON 往返去响应式）与 `startConversion()` 的 try/catch + 错误 toast；`main.ts` 的自检表达式全部包 IIFE 并加 `evalJs(label, expr)` 标签封装；`App.vue` 增加 `unhandledrejection` / `error` 全局监听并显式 `String()` 化；`notifyDone()` 的 `requestPermission()` 改为 `void … .catch()`；`FileList.vue` 的 `.file-sub` 间距 5px → 6px。修复后 `npm run smoke:ui:full` **44/44 通过、退出码 0**，控制台无任何克隆错误。**这条按要求标注来源：它是开发者自测发现的，不是用户反馈**；完整复盘见 `SESSION_SUMMARY.md` 第 5.1.1 节 |
| 打包阶段（本轮） | **开发者 / AI 自测（不是用户反馈）** | 新增"离线便携版打包"能力后，**只有把打包产物真的跑起来**才暴露出来的两个问题：① **打包态路径 bug**——`app.getAppPath()` 在打包态指向 `...\resources\app.asar`（一个**文件**），自检代码却拿它当目录做 `mkdirSync()`，便携版上直接抛 `ENOTDIR, not a directory`（开发态 44/44 全绿完全掩盖了它）；② **同一次运行里截图互相覆盖**——先截 `queue-done.png`（转换完成后）再截 `queue.png`，于是两个文件是同一张图（sha256 相同），而文档一直宣称"`queue.png` 是空队列" | ① `electron/main.ts` 新增 `smokeBaseDir()`：`app.isPackaged` 时返回 `path.dirname(app.getPath('exe'))`，否则返回 `app.getAppPath()`；**截图目录**与 `--smoke-file=` 的相对路径解析都改用它。修复后便携版自检 **44/44 通过、退出码 0**。<br>② `runSmokeCheck()` 里用 `ranConversion` 判定：跑过 `--smoke-convert` 就**不再写 `queue.png`**，只在它不存在时给提示；正确工作流固定为两步（`npm run smoke:ui:file` → `npm run smoke:ui:full`）。重新生成后 `queue.png`（22,942 字节，空队列，逐字节稳定）与 `queue-done.png`（54–58 KB，有任务，因含「已用时」文本会波动）**哈希不同**。<br>③ 顺带把「应用内转换：队列卡片显示完成与产物大小」从"只打印不断言"改成真断言：状态含「已完成」+ 产物大小含数字 + 存在打开按钮。**这两条按要求标注来源：均为开发者自测发现，不是用户反馈**；记录见 `SESSION_SUMMARY.md` 第 5.1 节第 9-11 条与 `TEST_CASES.md` 的 A8 |

---

## 2. 人类反馈对项目走向的实际影响

把上面几条反馈按"影响程度"重新排一下，可以看出这次协作的决策重心：

| 反馈 | 影响 |
| --- | --- |
| 7 条原始要求 | **决定性的**。其中需求 6（客户端关联）直接决定了技术选型，需求 7（给人用）决定了工作量分配——大量时间花在错误路径、空状态、诊断信息上，而不是堆格式数量 |
| 选定 Electron | **决定性的**。锁定了后续所有架构决策（多进程、IPC 契约、esbuild 打主进程、extraResources 释放二进制） |
| 给仓库与凭据、全程推 GitHub | **流程性的**。改变了工作方式（需要处理 SSH、代理镜像、`.gitignore` 范围），但不影响技术方案 |
| 中途放开沙箱 | **解除阻塞**。此前文件写入受限导致安装与构建反复失败；放开后安装链路才真正跑通 |
| 要求"不要编造事实" | **质量约束**。促使对所有结论做代码核对，并把"未验证"的部分显式标注出来，而不是写成"已完成" |

---

## 3. 待用户确认的问题

> 本节做过两次状态刷新：文档同步阶段有 **8 项落地**；本轮又追加 **2 项**（界面自检严格断言、跨进程传参决策），
> 合计 **10 项已经落地**（下面 3.0 节逐条给出证据），其余仍待人类决策。
> **已落地的不再列在"待确认"里**，避免把"已经做完的事"继续挂在待办清单上。
> 后两项的起因是开发者自测发现的缺陷，不是用户反馈（来源标注见第 1 节最后一行）。

### 3.0 上一轮待确认、现已落地的事项

| 原问题 | 结论与证据 |
| --- | --- |
| `resources/bin/` 与 `.downloads/` 是否提交进 git？（上轮第 2 项） | **已拍板：忽略**。`.gitignore` 已排除两者，并写明了三条理由；ffmpeg.exe 单个 139 MB 已超过 GitHub 单文件 100 MB 硬限制。克隆后用 `npm run setup` 获取 |
| 是否补齐 `build/icon.ico`？（上轮第 3 项） | **已补齐**。`scripts/make-icon.mjs` 用 ffmpeg 的 `geq` 滤镜生成 `build/icon.ico`（7 档尺寸）与 `build/icon.png`，含像素自检（`npm run make:icon`）。决策记录见 `DECISIONS.md` D-015。**但安装包仍未产出**，见 3.1 第 2 项 |
| 是否补充界面截图？（上轮第 4 项） | **已产出 5 张**：`main.png`、`main-with-file.png`、`queue.png`、`queue-done.png`、`settings.png`，全部由 `npm run smoke:ui:full` 自动生成（不是手工摆拍），README 已引用 |
| 是否接入 FFmpeg-Builds 新构建以启用 AV1？（上轮第 8 项） | **已启用**。实际落地的就是 FFmpeg-Builds master 构建 `N-126435-gf93cd72dde-20260906`，含 `libsvtav1`，AV1 软编码可用 |
| Electron 运行时要不要现在修好？（上轮第 9 项） | **已修好**。`npm run smoke:ui:full` 能启动真实窗口、加载真实视频、在应用内真的跑完一次转换、截图，并以退出码 0 结束（**44/44 通过**） |
| 是否接通已存在但未生效的功能？（上轮第 10 项） | **已接通**。`openFolderOnFinish` 在任务首次变为 `done` 时真正打开输出目录；`settings:reset` 与 `jobs:cancel-all` 已在 preload 暴露，设置页底部有「恢复默认设置」；`hardwareAcceleration` 与 `safeMode` 两个从未被读取的字段**直接删除**，`errors.ts` 的提示文案改为指向真实存在的「高级选项 → 视频编码器」 |
| 是否修掉那条已复现的 GIF 缺陷？（上轮第 11 项） | **已修复并补齐回归用例**。GIF 调色板链改为合并进已有 `-vf`（过滤空串），冒烟测试新增两条命令装配用例 + 一条真实转码回归用例（640×480 源 + 480p 档 + 不改帧率 → 1609 KB 有效产物） |
| `src/` → `renderer/` 的改名是否需要同步？（上轮第 12 项） | **已同步**。本轮把全部文档里的路径引用统一为 `renderer/`（`docs/` 与 `README.md` 已无 `src/` 引用） |
| 界面自检要不要覆盖"点按钮真的能开始转换"？（由开发者自测提出，非用户反馈） | **已覆盖且断言升级为严格判定**。`npm run smoke:ui:full` 现在是 **44/44 通过、退出码 0**：点击前先 `engine.remove()` 清空队列，点击后要求引擎队列长度从 **0 变为 1**。正是这条断言暴露了"按钮静默失效"的克隆缺陷（见 `TEST_CASES.md` 的 A7 与 `SESSION_SUMMARY.md` 第 5.1.1 节） |
| 跨进程传参是否要立规矩？（由上述缺陷引出） | **已立规矩**：新增决策记录 `DECISIONS.md` **D-016**——跨 IPC 传参统一走"去响应式的纯对象"（JSON 往返），并写明了它丢失 Date/Map 的代价与适用边界 |

### 3.1 影响验收的事项

1. **是否要现在完成 GitHub 提交与推送？**
   当前仓库只有远端原有的 1 个提交（`fa29cd3 Initial commit`），本项目源码全部未跟踪。
   需求 5 要求"项目提交 github"，这一步需要明确由谁在什么时候执行。
   注意 `.gitignore` 已就绪，`git add -A` 不会把 290 MB 二进制带进去。

2. **是否要在有网络的环境补一个 NSIS 安装包？**
   便携版已经有了并实测跑通（`release/Lumen-conv-便携版/`，602.3 MB，44/44 自检通过），
   但 **NSIS 安装包本机做不出来**：`electron-builder --win nsis` 需要额外工具链
   （`app-builder-bin` / `nsis` / `winCodeSign`）与一份与 `@electron/get` 不通用的 Electron 缓存，
   两次实测都以 `Timeout awaiting 'request' for 600000ms` 失败（见 `SESSION_SUMMARY.md` 第 4.3 节与 `DECISIONS.md` D-017）。
   需要确认：**是否值得换到有网络的环境跑一次 `npm run dist:nsis`**（能拿到带图标、带版本信息、带安装向导的正式包），
   以及由谁执行、在什么环境上验收。

### 3.2 内容补充类

3. **是否需要补充演示视频？**
   转码类工具用一段 30 秒的录屏（拖入 → 看信息 → 选预设 → 转换 → 看进度 → 打开产物）
   往往比截图更有说服力。目前未制作。

4. **是否需要把便携版挂到 GitHub Release？**
   便携版已产出（`release/Lumen-conv-便携版/`，目录总计 **602.3 MB**，已在 `.gitignore` 中排除），
   可以把整个目录打成 zip 作为 Release 附件，这样评审不需要自己构建
   （也绕开了"clone 后必须联网抓 290 MB 二进制"这一步）。
   需要确认是否采用这种方式，以及是否接受 Release 附件的大小（**注意：Release 附件不进入 git 仓库，
   不受"单文件 100 MB"那条仓库限制的约束，但 602 MB 的上传耗时与流量都不小**；
   此外便携版 exe 目前是 Electron 默认图标、无版本信息，见 `DECISIONS.md` D-017）。

### 3.3 技术细节类

5. **是否需要为项目补一个 `LICENSE` 文件？**
   `package.json` 声明 `"license": "MIT"`，但仓库根目录没有 `LICENSE` 文件。
   是否需要补一份标准 MIT 文本？

6. **冒烟测试没覆盖的样本要不要补？**
   `npm run smoke` 已覆盖 50 项并全部通过（含批量转换 2 项），但以下几类仍无样本：
   HDR 片源、真正带旋转元数据的手机视频（现有样本的 `rotate=90` 未被这份 ffmpeg 保留，用例自行跳过）、
   带字幕与多音轨的 MKV、带片头黑场的视频（用于证明缩略图确实会跳过黑帧）。
   需要确认是否值得为这几条准备素材。

7. **是否在真实 NVIDIA / AMD 机器上验证硬件编码？**
   本机只有 Intel 核显可用（H.264 QSV 实测通过），NVENC 与 AMF 只能做到"探测失败并如实告知"。
   `-cq` / `-b:v` 这些真卡参数没有在任何硬件上跑过——需要确认是否有条件补验。

8. **是否调整界面配色 / 视觉风格？**
   当前是深色为主的配色（`--bg-base: #0f1115` 一类的暗色调），并支持跟随系统 / 深色 / 浅色三种主题。
   如果需要更亮或更"商务"的观感，可以调 `renderer/styles/global.css` 里的主题变量。**未收到过配色反馈，故未改动。**

---

## 4. 反馈落实情况一览

| 反馈 | 状态 |
| --- | --- |
| 7 条原始要求 | 6 条已落地（① ② ③ ④ ⑥ ⑦ 有代码依据，其中 ① ② ③ 已由 `npm run smoke` 的 50 项检查实机验证，⑦ 另有界面自检的 40 项断言，含"按钮点击真的创建了任务"与"质量档位真的影响 ffmpeg 命令"），第 ⑤ 条（提交 github）**已执行**（见下表） |
| 选定 Electron 技术栈 | ✅ 已落地（后端逻辑与界面都已实机验证：`smoke` 50/50、`smoke:ui:full` 44/44、退出码 0） |
| 全程直接推 GitHub | ✅ 已执行：`https://github.com/xiaomingliang927/Lumen-conv`（SSH 走 Windows 原生 OpenSSH；HTTPS 亦可直接 clone），共 8 次提交 |
| 指出"点预设卡片右侧的标签没反应"（本轮） | ✅ 已修复，且**问题比反馈的更严重**：右侧标签本就不是按钮，但整张卡片点了也不换高亮——预设选择写进了按文件的 overrides，而选中态读全局。附带修好同类根因的质量/分辨率/帧率/编码器/音频/文件名模板，并新增 4 项预设交互断言 |
| 追问"质量下拉是可以用的吗"（本轮） | ✅ 可用，并补上**硬证据**：切「极小体积」后真实任务的 ffmpeg 命令里出现 `-crf 34`。同时发现它与预设是**同一个根因**的更大面积版本（6 个控件全部写错位置），一并修复 |
| 要求打包到桌面并能直接运行（本轮） | ✅ 已落地：`scripts/package-portable.mjs --shortcut` 用 PowerShell 的 WScript.Shell 创建桌面快捷方式，`Lumen-conv 视频格式转换器.lnk` 指向便携版；实测从快捷方式启动可完成真实转换 |
| 中途放开沙箱 | ✅ 已生效，安装与构建链路随之跑通 |
| "不要编造事实"（上一轮） | ✅ 已执行：全部结论基于源码核对与**实际执行验证命令**，未验证项显式标注 |
| "先读代码再改文档，以代码为准并指出不符"（上一轮） | ✅ 已执行：核实 14 条变更描述并重跑三条验证命令；发现的 3 处数字/事实不符已在 `SESSION_SUMMARY.md` 与本文件第 1 节如实记录 |
| 开发者自测发现的缺陷（**非用户反馈**） | ✅ 已修复并补上防回归断言：克隆缺陷的根因、假通过复盘、断言强化与四条预防措施记录在 `SESSION_SUMMARY.md` 第 5.1.1 节、`TEST_CASES.md` 的 A7、`DECISIONS.md` 的 D-016 |
| 打包阶段自测发现的两个问题（**非用户反馈**，本轮） | ✅ 已修复：① 打包态 `app.getAppPath()` 指向文件导致的 `ENOTDIR` → 新增 `smokeBaseDir()`，便携版自检 **44/44 通过、退出码 0**；② `queue.png` 被 `queue-done.png` 覆盖 → 跑过转换就不再写 `queue.png`，两者现已哈希不同；③ 顺带把队列卡片那条断言从"只打印"升级为真断言。见 `SESSION_SUMMARY.md` 第 5.1 节第 9-11 条、`TEST_CASES.md` 的 A8、`DECISIONS.md` 的 D-017 |
| 便携版打包（本轮新增能力，**非用户反馈**） | ✅ 已落地：`scripts/package-portable.mjs` 离线组装出 `release/Lumen-conv-便携版/`（`Lumen-conv.exe` 200.4 MB、目录 602.3 MB），实跑自检 44/44 通过；**NSIS 安装包仍未产出**，原因是环境限制而非设计取舍（见 `SESSION_SUMMARY.md` 第 4.3 节） |

> 与本文档配套的还有：`README.md`（项目主文档）、`docs/SESSION_SUMMARY.md`（会话总结与实际验证边界，
> 第 5 节按"已修复 / 仍然存在"列出代码审查发现）、`docs/DECISIONS.md`（17 条决策的备选方案与代价）、
> `docs/CORE_IMPLEMENTATION.md`（核心实现说明）、`docs/TEST_CASES.md`（边界与异常用例）。
