# 核心实现说明

本文档说明 Lumen-conv 的关键实现思路与取舍，配合 `docs/DECISIONS.md`（决策记录）一起阅读。

- 面向评审：想快速判断"这个项目是真做出来的还是壳子"时，看本文第 2、3、5、7 节。
- 面向开发者：想改代码时，看第 1、4、6 节。

---

## 1. 进程与模块划分

```
┌─────────────────────────────────────────────────────────────────┐
│ 渲染进程 renderer/（Vue 3，无 nodeIntegration，contextIsolation） │
│   App.vue ── FileList / DetailsPanel / JobQueue / SettingsView   │
│   composables/useStore.ts   状态中心（任务状态是主进程的投影）    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ window.converter（preload 白名单）
┌───────────────────────────┴─────────────────────────────────────┐
│ preload.ts     contextBridge 暴露 28 个方法，统一 {ok,data|error} │
└───────────────────────────┬─────────────────────────────────────┘
                            │ ipcMain.handle（每个 handler 都包了 try/catch）
┌───────────────────────────┴─────────────────────────────────────┐
│ 主进程 electron/                                                 │
│   main.ts        窗口 / 协议 / IPC 路由 / 生命周期                │
│   settings.ts    设置持久化（原子写）                             │
│   ffmpeg/                                                        │
│     binaries.ts     二进制定位（自定义 > 随包分发 > PATH）        │
│     probe.ts        ffprobe JSON → 结构化信息                     │
│     thumbnail.ts    智能选帧 + 磁盘缓存                           │
│     commands.ts     结构化选项 → ffmpeg 参数数组                  │
│     progress.ts     -progress pipe:1 → 百分比/速度/剩余时间       │
│     capabilities.ts 编码器能力探测（硬件编码器真跑一次）          │
│     errors.ts       ffmpeg 错误 → 人类可读提示                    │
│     convert.ts      任务引擎（队列/并发/取消/重试）               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ spawn（参数数组，不经 shell）
                     ffmpeg.exe / ffprobe.exe  ← resources/bin/
```

**契约唯一来源**：`shared/types.ts`。主进程、preload、渲染进程引用同一份类型定义，
改一处三边同时生效，避免"IPC 参数对不上"这类只有运行时才暴露的问题。

---

## 2. 需求 1：视频信息与缩略图

### 2.1 信息探测（`probe.ts`）

一次 `ffprobe -print_format json -show_format -show_streams -show_chapters` 拿全量信息，
再翻译成 UI 直接可用的结构。几处容易被忽略但影响正确性的处理：

| 处理 | 为什么 |
|---|---|
| `displayWidth/Height` 同时考虑 `sample_aspect_ratio` 与旋转角 | 非方形像素（老 DVD、部分手机录像）与竖拍视频若不校正，UI 上比例是错的 |
| `avg_frame_rate` 优先于 `r_frame_rate` | VFR（可变帧率）视频里 `r_frame_rate` 是容器下限，会显示成 1000fps 之类 |
| 旋转角从 `side_data_list[].rotation` 与 `tags.rotate` 两处读取 | 新版 ffprobe 挪了位置，只读一处会在部分文件上读不到 |
| `isAttachedPic` 过滤封面图 | MP3/MP4 的专辑封面是"一路视频流"，不排除会把纯音频文件误判成视频 |
| `format_name` 做优先级挑选 | ffprobe 对 WebM 返回 `matroska,webm`，直接取第一段会把 WebM 显示成 MKV（这个 bug 是冒烟测试发现的） |
| 0 字节与目录提前拦截 | 避免把无意义的错误丢给 ffprobe 再翻译 |

### 2.2 缩略图（`thumbnail.ts`）

**问题**：固定在第 0 秒抽帧，遇到片头黑场、片头台标、淡入就会得到一张黑图 —— 这是同类工具最常见的体验缺陷。

**做法（三级策略）**：

1. `blackdetect=d=0.1:pix_th=0.10` 扫描前 60 秒，得到黑场区间
2. 候选抽帧点取时长的 10% / 25% / 50% / 5%（外加 2 秒兜底），落在黑场内的候选点顺移到黑场结束后 0.4 秒
3. 逐个候选点抽帧，用 `signalstats` 的 `YAVG` 算平均亮度，低于 12 视为"仍然太暗/无内容"，换下一个点

**缓存设计**：键 = `sha1(路径 + 文件大小 + 修改时间 + 目标宽度)`，落在 `userData/cache/thumbs/`。

- 用"大小 + 修改时间"而不是文件内容哈希：抽帧本身就要读文件，算内容哈希等于白读一遍
- **缓存键刻意不含抽帧时间点**：同一文件只保留一张封面。早期实现把时间点写进键里，结果用户每次点开文件都会因为传了不同的 `atSec` 而重算（首版真实 bug）
- 显式指定时间点（`atSec`）时覆盖同一张缓存，语义是"换一张封面"

**降级**：抽帧失败不抛异常，返回 `{ filePath: null, error: '…' }`，UI 显示占位图。缩略图失败不应该阻断用户转换视频。

---

## 3. 需求 2：ffmpeg 命令行

### 3.1 为什么返回参数数组

```ts
// commands.ts
return { args: ['-c:v', 'libx264', '-crf', '23', ...], commandText: '…' }
```

- 传给 `spawn` 的是**数组**，不经过 shell。中文路径、空格路径、`&`、`^` 都不需要转义，也没有注入风险
- 同时另存一份 `commandText`（经引号转义）供 UI 展示与用户复制 —— 这是"确实在用命令行"最直观的证据

### 3.2 编码器私有参数集中处理

| 编码器 | 质量参数 | 说明 |
|---|---|---|
| libx264 / libx265 | `-crf N -preset medium` | 软编码标准做法 |
| NVENC | `-rc vbr -cq N -preset p5` | NVENC 不支持 CRF 语义，`-cq` 是近似物 |
| QSV | `-global_quality N -look_ahead 1` | Intel 的对应参数 |
| AMF | `-b:v Nk` | AMD 没有等价 CQ，退化为码率控制 |
| libvpx-vp9 | `-crf N -b:v 0 -row-mt 1` | VP9 恒定质量模式必须显式 `-b:v 0` |
| GIF | 见 3.4 | 两遍调色板 |

UI 只需要传 `qualityId: 'balanced'`，不需要知道这些差异。

### 3.3 自动纠偏（用户没要求，但不做就会出问题）

- **旋转**：源带 `rotate=90` 元数据时追加 `transpose=1`。重新编码后元数据经常会丢，不转正的话手机上拍的视频转出来是横的
- **HDR → SDR**：源是 PQ/HLG 且目标不是 10bit 编码器时，插入 `zscale → tonemap=hable → zscale` 链。不做的话转出来画面明显发灰
- **只缩不放**：目标分辨率高于源分辨率时不生成 `scale` 滤镜。放大只会变糊并浪费体积
- **像素格式**：H.264/H.265 输出强制 `yuv420p`（或 10bit 源的 `yuv420p10le`），否则部分设备无法播放
- **faststart**：MP4 加 `-movflags +faststart`，索引前置，网页可边下边播

### 3.4 GIF 的调色板两遍法（单进程内联）

ffmpeg 默认的 GIF 转换只有 256 色的固定调色板，画面有明显色带。这里改用标准两遍流程，
但**两遍都跑在同一个 ffmpeg 进程的滤镜链里**，不落地调色板 PNG、也不需要第二个进程：

```
[前置缩放/帧率滤镜],split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3
```

做法是把这条链**合并进已有的 `-vf`**（`commands.ts` 的 `buildVideoArgs()` 里 `codecId === 'gif'` 分支）：

- 如果前面已经因为缩放/旋转/HDR/帧率生成了 `-vf`，就把调色板链追加到同一条 `-vf` 的值上；
- 如果没有，就新建一个 `-vf`。

**这里踩过一个真实的坑**：前置滤镜可能恰好为空（源分辨率已经 ≤ 目标档位、且没有改帧率、无旋转、非 HDR），
早期实现直接拼 `${已有滤镜},split…`，于是滤镜链**以逗号开头**，ffmpeg 报 `No such filter: ''`
并以退出码 1 失败，产物是 0 字节。GIF 预设默认 480p，所以高 ≤480p 的源走默认设置时必然失败。
修复方式是先用 `.filter((s) => s.length > 0)` 滤掉空串再 `join(',')`，冒烟测试为此补了两条用例
（一条纯命令装配的回归、一条真实转码的回归，见 `docs/TEST_CASES.md`）。

代码注释里保留了这次踩坑记录，避免以后有人"简化"回原来的写法。

代价是耗时约两倍（解码两遍），收益是观感差别肉眼可辨。

### 3.5 校验前置

失败要尽早暴露，而不是让用户等 20 分钟再看到错误：

| 时机 | 校验内容 |
|---|---|
| 入队前 | 源文件能否探测、预设是否存在、参数组合是否合法、**磁盘剩余空间是否够** |
| 装配时 | 编码器 ↔ 容器是否匹配、直通时源编码能否装进目标容器、字幕类型 ↔ 容器是否兼容 |
| 完成后 | 产物是否存在、是否 0 字节、是否明显小于预估体积（< 5% 时给出警告） |

### 3.6 进度上报

主进程给 ffmpeg 加 `-progress pipe:1 -nostats`，解析 stdout 的 `key=value` 流：

```
frame=120
out_time_us=25000000     ← 注意 out_time_ms 这个字段名在部分版本里单位也是微秒
speed=2.5x
progress=continue
```

`progress.ts` 把它换算成 `percent / etaSec / speed / processedText`，并做两件事：

- **节流 400ms**：ffmpeg 默认每 0.5s 报一次，多路并发时再兜一层，避免 IPC 消息过密
- **ETA 双路估算**：优先用 ffmpeg 的 `speed`；硬件编码器常常不上报 `speed`，此时用"已处理时长 ÷ 已用时"反推平均速度

**不确定进度**：总时长未知（`totalDurationSec = 0`）时 `percent` 返回 `null`，UI 走不确定进度条 —— 而不是假装从 0% 开始爬。

### 3.7 取消与清理

- 取消调用 `taskkill /pid <pid> /T /F`（Windows）杀**整棵进程树**。只 kill 父进程会留下 ffmpeg 子进程继续吃 CPU
- 取消后删除半成品输出文件。不做这一步，用户会在输出目录里看到一堆 0 字节或只转了几秒的 `.mp4`，还得自己分辨哪个是坏的
- 应用退出时 `cancelAll()`，避免 ffmpeg 变成孤儿进程

---

## 4. 任务引擎（`convert.ts`）

- **状态归主进程所有**，渲染进程只是投影：收到 `job:updated` 就整体替换。这样切页面、刷新界面都不影响任务，也不会出现"界面显示完成但实际失败"
- **并发控制**：默认 2，可调 1-4。ffmpeg 是 CPU/GPU 密集型，盲目并发会让总耗时更长（多个任务抢同一个编码器）
- **队列顺序**：`pump()` 在每次任务结束时重新调度，失败/取消不会卡住队列
- **重试**：重置状态并重新计算输出路径（原产物可能已被占用），而不是复用旧路径
- **输出冲突**：默认自动加 ` (1)`、` (2)` 后缀，不覆盖用户已有文件；也刻意不做"静默覆盖"
- **历史裁剪**：超过 300 条丢弃最老的已完成任务，避免长时间运行内存单调增长

---

## 5. 需求 3：自主优化清单

按"用户能感知到的收益"排序：

| # | 优化 | 解决的问题 |
|---|---|---|
| 1 | 硬件编码器**真跑一次**验证可用性 | `ffmpeg -encoders` 里永远有 nvenc/qsv/amf，即使机器上没显卡。只查列表会让用户选了"显卡加速"后立刻报错 |
| 2 | 智能选帧缩略图 | 片头黑场导致缩略图全黑 |
| 3 | 缩略图磁盘缓存 | 批量导入时重复抽帧，界面卡顿 |
| 4 | 杀进程树 + 清理半成品 | 取消后残留孤儿进程与 0 字节文件 |
| 5 | ffmpeg 错误翻译 + 修复建议 | 用户看不懂 `Could not find tag for codec` |
| 6 | 磁盘空间预检 | 转完 3 小时才发现磁盘满了 |
| 7 | 直通前容器兼容性预检 | 同上，白等 |
| 8 | HDR → SDR 色调映射 | HDR 片源转 SDR 后画面发灰 |
| 9 | 旋转自动转正 | 手机竖拍视频转出来是横的 |
| 10 | 只缩不放 | 无意义的放大，变糊且体积膨胀 |
| 11 | GIF 调色板两遍法 | 默认转换的 GIF 色带明显 |
| 12 | `+faststart` | MP4 无法边下边播 |
| 13 | 多镜像二进制获取脚本 | GitHub 直连不通时仍能装好 ffmpeg |
| 14 | 启动"快速探测 + 后台完整探测" | 硬件编码器试跑要 3-5 秒，全放在启动路径上界面会卡住 |
| 15 | 自定义协议 `lumen-media://` | 用正规方式给渲染进程访问本地文件，而不是关掉 `webSecurity` |
| 16 | 专家模式展示完整命令 | 出问题时用户可自查、可复制、可反馈 |

---

## 6. 安全模型

| 措施 | 作用 |
|---|---|
| `nodeIntegration: false` + `contextIsolation: true` | 渲染进程拿不到 Node API，XSS 也读不到文件系统 |
| preload 白名单 | 只暴露 28 个明确的方法，没有 `ipcRenderer.invoke(channel, …)` 这种通用后门 |
| 拒绝新窗口 + 外部链接走系统浏览器 | 防止应用内被导航到任意页面 |
| CSP 头 | 限制脚本/样式/连接来源 |
| `lumen-media://` 自定义协议 | 取代 `webSecurity: false`，本地文件访问是受控的 |
| 所有 IPC handler 包 try/catch | 异常统一转成 `{ok:false,error}`，不把堆栈泄漏到渲染进程 |

---

## 7. 自动化验证

`npm run smoke` —— 端到端冒烟测试，**直接复用产品代码模块**（用 esbuild 把 `electron/ffmpeg/*.ts` 打成 ESM 后 import，`electron` 模块用测试桩替代），覆盖：

- 环境检查：ffmpeg / ffprobe 是否就位并打印版本
- 素材合成：用 `lavfi` 合成 H.264/MP4、H.265/MKV、带旋转元数据的 MP4、480p 低分辨率 MP4、纯音频 MP3（不依赖外部素材）
- 需求 1：信息探测字段正确性；损坏文件、0 字节文件的错误文案
- 需求 1：缩略图生成、缓存命中、失败降级
- 需求 2：命令装配的关键参数（CRF/faststart/缩放/vn/hvc1/调色板/无前导逗号）
- 需求 2：**真实跑 ffmpeg** 完成 MP4→MP4、直通、WebM、HEVC、MP3、GIF、GIF 低分辨率回归、裁剪转换，并用 ffprobe 回读校验产物编码与时长
- 健壮性：错误翻译规则（磁盘满/显卡不可用/容器不兼容/取消）
- 进度：百分比、速度、ETA、未知总时长的不确定进度

当前共 **48 项，全部通过**（实测数据见 `docs/TEST_CASES.md` 的 A 部分）。

`npm run smoke:ui` / `npm run smoke:ui:file` / `npm run smoke:ui:full` —— 界面自检，启动真实 Electron 窗口，
用 `executeJavaScript` 检查关键元素，再用 `capturePage()` 截图到 `docs/screenshots/`，带退出码。三级递进：

| 命令 | 做的事 | 检查项 |
| --- | --- | --- |
| `npm run smoke:ui` | 启动窗口 → 等 `data-store-ready` → 逐页切换截图 | 14 项 |
| `npm run smoke:ui:file` | 加 `--smoke-file=…`，通过 `window.__lumenAddFiles` 走真实 `addFiles` 路径加载一个视频 | 21 项 |
| `npm run smoke:ui:full` | 再加 `--smoke-convert`，在应用内真的点一次「开始转换」并等任务跑到终态 | 26 项 |

**为什么不是"截到图就算过"**：早期版本的界面自检只看截图是否成功，结果截到过一张**空白的设置页**——
因为 store 数据还没加载完，设置页的 `v-if` 让整块内容都没渲染，而 DOM 骨架（标题栏/导航/文件区）是存在的。
现在的等待条件是"DOM 骨架存在 **且** `document.documentElement` 上有 `data-store-ready="1"`"
（该属性由 `renderer/App.vue` 在 `initStore()` 完成后设置），并且每个页面都断言具体内容：
设置页要求 `.settings .card` ≥ 3 个、队列页要求标题存在、导航高亮必须落在正确的项上。

同样地，`--smoke-file` 不走"直接塞假数据"的捷径，而是调用 `window.__lumenAddFiles()`
——它内部就是拖拽/选择文件用的同一个 `addFiles`，所以截图反映的是真实交互结果。
（该钩子必须返回 `undefined`：`executeJavaScript` 会用结构化克隆把返回值传回主进程，
Vue 的响应式对象与 Promise 都不可克隆，返回它们会让渲染进程直接崩溃。这条也已踩过。）

> 测试跑的是产品代码本身，而不是另写一份等价实现 —— 否则"测过了"没有说服力。

---

## 8. 已知限制

诚实列出当前版本没做到的事：

1. **没有单元测试框架**（Vitest/Jest）。当前用冒烟测试覆盖主流程，纯函数（`format.ts`、`progress.ts` 的解析）未做边界穷举
2. **字幕只是"能保留"**，不支持烧录（hardsub）、不支持外挂字幕文件、不支持从 MKV 抽取字幕为 srt
3. **硬件编码器的参数未经跨显卡验证**：本机只有 Intel 核显可用（H.264 QSV 实测可用），没有任何 **NVIDIA / AMD 显卡**，
   所以 NVENC 与 AMF 分支只做到"探测失败并如实告知原因"（本机显示"编码器初始化失败（通常是驱动问题）"），
   `-cq` / `-b:v` 这些真卡参数没有在硬件上跑过
4. **没有断点续传**：转换中断只能整段重来
5. **GIF 的调色板是整段统计**，超长视频（> 5 分钟）做 GIF 会非常慢且体积巨大，UI 只给了提示没有硬性限制
6. **打包产物未做代码签名**，Windows SmartScreen 会提示"未知发布者"
7. **未做多语言**，界面文案为硬编码中文
8. **打包尚未实机验证**：图标（`build/icon.ico`）已由脚本生成，但 `release/` 目录从未产出过，
   安装后的 `extraResources` 释放路径也未经运行验证
9. **界面自检依赖单实例锁**：`smoke:ui` 在已有实例运行时不会真正执行（见 `docs/SESSION_SUMMARY.md` 第 5.3 节）
10. **`-movflags +faststart` 在直通分支不生效**：`buildVideoArgs()` 的 `-c copy` 分支在函数开头就 `return`，
    走不到后面 `if (container === 'mp4')` 那一段
