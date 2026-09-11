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

### 4.1 渲染进程状态管理与跨 IPC 传参：必须去响应式

渲染层的状态中心是 `renderer/composables/useStore.ts`（模块级单例 + `ref`/`computed`，不引 Pinia，
见 D-002）。它有一条**必须遵守的纪律**：

> **任何要跨 IPC 送出去的值，都必须是"去响应式的纯对象"，不能是 Vue 的 Proxy。**

原因：`contextBridge` 暴露的方法最终走 `ipcRenderer.invoke`，而 Electron IPC 用**结构化克隆**序列化参数，
Proxy 不是可克隆类型，会直接抛 `An object could not be cloned.`。
Vue 的 `ref`/`reactive` 是惰性代理——只要你从响应式对象上读出一个对象/数组字段，读到的就是 Proxy，
所以 `{ ...options.value, ...file.overrides }` 这种看起来很正常的合并，产出的数组字段仍然是 Proxy。

规范做法（`effectiveOptions()`）：

```ts
export function effectiveOptions(file: LoadedFile): ConversionOptions {
  const merged = { ...options.value, ...(file.overrides ?? {}) };
  return JSON.parse(JSON.stringify(merged)) as ConversionOptions;   // 脱掉整棵结构的响应式
}
```

- 用 **JSON 往返**而不是 `structuredClone`：后者同样无法克隆 Proxy，且这里没有需要保类型的值
  （结构里只有 string / number / boolean / null / 数组），JSON 往返最稳妥。取舍与备选方案见 **D-016**。
- 这条纪律曾经被违反，代价是**「开始转换」按钮完全失效且不报错**：合并结果里的数组字段始终是 Proxy
  （`options` 这个 `ref` 自己的数组字段就已经是 Proxy 数组，所以不只是"改过字幕勾选"才会中招），
  点击后队列里什么都没有。真实缺陷的完整复盘见 `docs/SESSION_SUMMARY.md` 第 5.1.1 节。
- 配套要求：**桥接层调用必须兜住异常**。`startConversion()` 用 `try/catch` 包住 `api.createJobs()`，
  失败时 `console.error` + `showToast('无法创建转换任务：' + msg, 'danger', 8000)`。
  跨 IPC 的失败默认只会留下一行无上下文的控制台错误，用户看到的是"点了没反应"。
- 同类约束在自检代码里也成立：`executeJavaScript` 的表达式结果同样走结构化克隆，
  所以 `window.__lumenAddFiles()` 必须返回 `undefined`，被测表达式必须以基本类型收尾（见 7.1）。

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

当前共 **48 项通过 / 0 失败，总耗时 18.4s**（实测数据见 `docs/TEST_CASES.md` 的 A 部分）。

`npm run smoke:ui` / `npm run smoke:ui:file` / `npm run smoke:ui:full` —— 界面自检，启动真实 Electron 窗口，
用 `executeJavaScript` 检查关键元素，再用 `capturePage()` 截图到 `docs/screenshots/`，带退出码。三级递进：

| 命令 | 做的事 | 检查项 |
| --- | --- | --- |
| `npm run smoke:ui` | 启动窗口 → 等 `data-store-ready` → 逐页切换截图 | **14 项** |
| `npm run smoke:ui:file` | 加 `--smoke-file=…`，通过 `window.__lumenAddFiles` 走真实 `addFiles` 路径加载一个视频 | **29 项** |
| `npm run smoke:ui:full` | 再加 `--smoke-convert`，在应用内真的点一次「开始转换」并等任务跑到终态 | **40 项** |

**同一套自检也会在打包态跑一遍**：便携版可以带参数启动，跑的是完全相同的 `runSmokeCheck()`：

```bash
release/Lumen-conv-便携版/Lumen-conv.exe --smoke --smoke-file=<绝对路径> --smoke-convert
```

实测 **40/40 通过、退出码 0**（含应用内真实转换：状态 `done`、产物 706 KB、进度 100%）。
这一步不是重复劳动——打包态会暴露开发态永远碰不到的问题，最典型的就是 `app.getAppPath()` 指向
`resources/app.asar`（一个文件）导致的 `ENOTDIR`（见 8.2）。

**为什么不是"截到图就算过"**：早期版本的界面自检只看截图是否成功，结果截到过一张**空白的设置页**——
因为 store 数据还没加载完，设置页的 `v-if` 让整块内容都没渲染，而 DOM 骨架（标题栏/导航/文件区）是存在的。
现在的等待条件是"DOM 骨架存在 **且** `document.documentElement` 上有 `data-store-ready="1"`"
（该属性由 `renderer/App.vue` 在 `initStore()` 完成后设置），并且每个页面都断言具体内容：
设置页要求 `.settings .card` ≥ 3 个、队列页要求标题存在、导航高亮必须落在正确的项上。

同样地，`--smoke-file` 不走"直接塞假数据"的捷径，而是调用 `window.__lumenAddFiles()`
——它内部就是拖拽/选择文件用的同一个 `addFiles`，所以截图反映的是真实交互结果。
（该钩子必须返回 `undefined`：`executeJavaScript` 会用结构化克隆把返回值传回主进程，
Vue 的响应式对象与 Promise 都不可克隆，返回它们会让渲染进程直接崩溃。这条也已踩过。）

#### 7.1 界面自检里的五条工程约定（都是踩坑换来的）

**① 所有被测表达式包成 IIFE，以基本类型收尾。**
`executeJavaScript` 会把**表达式的结果**结构化克隆回主进程，而 DOM 节点、Vue 响应式对象、Promise 都不可克隆。
反面教材：早期写成 `void el.click(); true` —— `void` 只丢弃值，那个 DOM 节点仍会作为表达式中间值被克隆，
于是抛 `An object could not be cloned.` 并让整个 `await` 失败（任务从未创建）。正确写法：

```js
(() => { document.querySelectorAll('.nav-item')[1].click(); return true; })()
```

**② 每一步都过 `evalJs(label, expr)` 封装。**
原生克隆错误只给一行 `An object could not be cloned.`，**不带任何位置信息**，
`runSmokeCheck()` 里有 15 处调用点（其中若干在等待循环里），出错时无从定位。
`main.ts` 里的 `evalJs()` 给每一步加标签，失败时打印并抛出 `步骤「xxx」失败：…`：

```ts
const evalJs = async <T>(label: string, expression: string): Promise<T> => {
  try {
    return (await win.webContents.executeJavaScript(expression)) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[smoke] ✘ 步骤「${label}」执行失败：${msg}`);
    throw new Error(`步骤「${label}」失败：${msg}`);
  }
};
```

**③ 断言必须落在"这次操作造成的副作用"上，并且要先清场。**
`--smoke-convert` 会先直接调一次 `createJobs` 做链路诊断（能区分"IPC 坏了"还是"界面路径坏了"），
再做一次真实按钮点击。关键在于：**点击前先 `engine.remove()` 清空队列并记录 `beforeClick`**，
点击后要求 `engine.list().length > beforeClick`（实测 0 → 1）。
没有这一步，前一步诊断留下的任务会让"队列里有任务"这条断言在**按钮完全失效**时也成立——这就是假通过。

**④ 渲染层挂全局错误监听，方便定位只在某条路径出现的克隆错误。**
`renderer/App.vue` 在 `onMounted` 里注册 `unhandledrejection` 与 `error` 监听，
并**显式 `String()` 化**错误内容（直接 `console.error(event)` 打不出内容）。

**⑤ 一个文件只能有一个含义："截图文件名 = 该文件声称拍到的状态"。**
`queue.png` 与 `queue-done.png` 一度是同一次运行里的同一张图（sha256 相同）：脚本先截
`queue-done.png`（转换完成后），再截 `queue.png`，后者把**前一步产出的空队列那张**覆盖掉了，
而文档仍然宣称"`queue.png` 是空队列"。修复方式不是"把图重命名"，而是让两者的**产出条件互斥**：
`const ranConversion = process.argv.includes('--smoke-convert')`，跑过转换就**不写** `queue.png`，
只在它不存在时打印一句提示。于是正确工作流变成两步：

| 步骤 | 命令 | 新增截图 |
| --- | --- | --- |
| 1 | `npm run smoke:ui:file`（或 `--smoke --smoke-file=…`，**不带** `--smoke-convert`） | `main.png`、`main-with-file.png`、**`queue.png`（空队列）**、`settings.png` |
| 2 | `npm run smoke:ui:full`（带 `--smoke-convert`） | 只新增 `queue-done.png`，**不动 `queue.png`** |

实测两个文件已**哈希不同**：`queue.png`（空队列）与 `queue-done.png`（有任务）。
> 这类"截图字节数/哈希"只对**当次运行**成立：`queue-done.png` 里任务卡片带「已用时」，
> 截图瞬间的秒数不同就会让 PNG 在 54–58 KB 之间波动。文档记录它们只为证明"两张图确实不同"，
> 不是固定契约（`queue.png` 因为不含时间信息，倒是一直稳定在 22,942 字节）。
与 ③ 一样，这条约定针对的是同一类错误：**断言/产物被"另一条路径"满足**，看上去成功，实际什么都没证明。

> 测试跑的是产品代码本身，而不是另写一份等价实现 —— 否则"测过了"没有说服力。

---

## 8. 便携版（打包态）的目录布局与路径约定

便携版由 `scripts/package-portable.mjs` **离线手工组装**（`npm run dist:portable`），
不经过 electron-builder。它的目录布局刻意与 `extraResources` 的语义保持一致：

```
release/Lumen-conv-便携版/
├─ Lumen-conv.exe                主程序（Electron 运行时本体改名而来）
├─ *.dll / *.pak / locales/      Electron 运行时（已排除用不到的 default_app.asar）
├─ resources/
│  ├─ app.asar                   主进程 + preload + 渲染层产物（dist/ + dist-electron/ + 精简 package.json）
│  └─ bin/
│     ├─ ffmpeg.exe              ← resources/bin/ffmpeg.exe
│     └─ ffprobe.exe             ← resources/bin/ffprobe.exe
└─ （运行期还会生成）docs/screenshots/  仅当带 --smoke 启动时，落在 exe 同级目录
```

### 8.1 为什么 `binaries.ts` 不需要打包态分支

`binaries.ts` 的 `bundledCandidates()` 依次尝试两个候选：

| 顺序 | 候选路径 | 命中场景 |
| --- | --- | --- |
| 1 | `process.resourcesPath/bin/<kind>.exe` | 打包态：`process.resourcesPath` = `<安装目录或便携版目录>/resources` |
| 2 | `app.getAppPath()/resources/bin/<kind>.exe` | 开发态：`app.getAppPath()` = 项目根 |

关键在于**同一份 `resources/bin/` 布局在两种形态下都成立**：便携版就是把两个 exe 复制到
`resources/bin/`，与 electron-builder 的 `extraResources` 释放位置逐字一致。
所以 `binaries.ts` **一行分支都不用加**，`fetch-binaries.mjs` 也只需要往一个地方写。
（这一点在 D-014 里作为决策理由写下了，便携版是它的第二次验证：打包态实测
`resources/bin/ffmpeg.exe -version` 输出 `N-126435-gf93cd72dde-20260906`。）

### 8.2 打包态特有的路径陷阱：`app.getAppPath()` 指向一个文件

界面自检的基准目录**不能**直接用 `app.getAppPath()`：

- **开发态**：它确实等于项目根，`join(base, 'docs/screenshots')` 是正常目录；
- **打包态**：它等于 `...\resources\app.asar` —— 那是一个**文件**。
  拿它当目录去 `mkdirSync()` 会抛 `ENOTDIR, not a directory`（实测在便携版上踩到，
  开发态 40/40 全绿也照样暴露不了这个问题）。

修复方式是 `electron/main.ts` 里新增的 `smokeBaseDir()`：

```ts
function smokeBaseDir(): string {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
}
```

**截图目录**与 `--smoke-file=` 的**相对路径解析**都改用它。语义上这是"基准目录 =
用户能看到、也写得进去的那个目录"：开发态是项目根，打包态是 exe 所在目录。

> 这类问题的通用教训：凡是"开发态正好成立"的路径假设，都要在打包态再验一次。
> 这也是为什么本项目的验证分两层——`smoke:ui:*`（开发态）与直接在便携版 exe 上跑同一套自检（打包态）。

### 8.3 已知限制

便携版的 `Lumen-conv.exe` **图标与版本信息仍是 Electron 原值**：脚本会尝试用
`node_modules/electron-winstaller/vendor/rcedit.exe` 写入 `build/icon.ico` 与版本信息，
但该版本 rcedit 在**路径含非 ASCII 字符**时（本项目路径含中文）报 `Fatal error: Unable to load file`，
脚本如实跳过并打印警告，**刻意不做环境相关绕行**（例如把 exe 复制到临时 ASCII 路径再改回来）。
需要带图标的正式安装包时，应在有网络的环境跑 `npm run dist:nsis`（详见 `docs/DECISIONS.md` D-017）。

---

## 9. 已知限制

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
8. **没有 NSIS 安装包，便携版的 exe 用 Electron 默认图标、无版本信息**：`npm run dist:nsis`
   （`electron-builder --win nsis`）在本机受限网络下无法完成（需要额外工具链，且它的 Electron 缓存与
   `@electron/get` 不通用，两次实测都以 `Timeout awaiting 'request' for 600000ms` 失败，详见 D-017）。
   已产出并实测跑通的是**离线手工组装的便携版**（见第 8 节），其图标写入因 rcedit 对非 ASCII 路径的限制而跳过（见 8.3）
9. **界面自检依赖单实例锁**：`smoke:ui` 在已有实例运行时不会真正执行（见 `docs/SESSION_SUMMARY.md` 第 5.3 节）
10. **`-movflags +faststart` 在直通分支不生效**：`buildVideoArgs()` 的 `-c copy` 分支在函数开头就 `return`，
    走不到后面 `if (container === 'mp4')` 那一段
