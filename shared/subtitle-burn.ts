/**
 * 字幕烧录（hardcode）的滤镜拼装。
 *
 * ------------------------------------------------------------------ *
 * 为什么要单独一个模块
 *
 * 「保留字幕轨」和「烧进画面」是两件完全不同的事：
 *   · 保留轨道：字幕作为可选流封装进容器。设备**能否显示取决于播放器**——
 *     很多电视和手机默认不显示，对方看到的仍然是没有字幕的画面。
 *   · 烧录：把字幕画进像素里。任何设备都看得到，代价是视频必须重新编码、
 *     而且烧上去就关不掉。
 * 用户经常以为勾了"保留字幕"就万事大吉，所以界面上把这两件事分开讲。
 *
 * ------------------------------------------------------------------ *
 * 这个模块存在的第二个理由：**ffmpeg 滤镜里的路径转义是出了名的坑**
 *
 * `subtitles` 滤镜的路径要经过三层解析（ffmpeg 选项 → 滤镜图 → 滤镜参数），
 * Windows 路径 `C:\Users\季\视频\subs.srt` 直接塞进去必然失败。规则是：
 *   1. 反斜杠全部换成正斜杠（`\` → `/`）
 *   2. 冒号要转义成 `\:`（否则被当成滤镜参数的 key:value 分隔符）
 *   3. 单引号要写成 `'\''`（先闭合、转义、再打开）
 *   4. 整体用单引号包起来，避免空格与中文被拆开
 * 这套规则写在这里并有单测式的自检盯着，不要散落在调用处。
 */

/** 把绝对路径转成能安全放进 ffmpeg 滤镜图的写法 */
export function escapeFilterPath(p: string): string {
  return (
    "'" +
    p
      .replace(/\\/g, '/')
      // 冒号在滤镜参数里是 key:value 分隔符，必须转义
      .replace(/:/g, '\\:')
      // 单引号：闭合 → 转义一个单引号 → 重新打开
      .replace(/'/g, "'\\''") +
    "'"
  );
}

/**
 * 生成烧录字幕的滤镜片段。
 *
 * @param subtitlePath 字幕所在文件（通常是源视频本身，字幕是内嵌轨）
 * @param streamIndex  该字幕在**文件内的字幕流序号**（从 0 开始，不是全局流 index）
 */
export function burnSubtitleFilter(subtitlePath: string, streamIndex: number): string {
  return `subtitles=${escapeFilterPath(subtitlePath)}:si=${streamIndex}`;
}

/**
 * 把「全局流 index」换算成「文件内第几条字幕流」。
 *
 * 这两个数字经常被搞混：`probe` 里的 `subtitle[].index` 是**全局流序号**
 * （和视频、音频排在一起），而 `subtitles` 滤镜的 `si=` 要的是**只数字幕**的序号。
 * 例如某文件流顺序是 0=视频 1=音频 2=字幕 3=字幕，那么全局 index 3 对应 si=1。
 */
export function subtitleStreamOrdinal(subtitleIndexes: number[], globalIndex: number): number {
  const sorted = [...subtitleIndexes].sort((a, b) => a - b);
  const at = sorted.indexOf(globalIndex);
  return at >= 0 ? at : 0;
}
