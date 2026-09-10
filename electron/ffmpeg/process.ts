/**
 * 子进程封装：所有 ffmpeg / ffprobe 调用统一走这里。
 *
 * 关键设计：
 * - windowsHide: true —— 否则 Windows 上每执行一次 ffmpeg 都会闪一个黑窗口，
 *   这是「给人用」的桌面应用最低要求。
 * - 取消任务必须杀进程树：ffmpeg 被 kill 后子进程可能残留（尤其带 pipe 时），
 *   Windows 上用 taskkill /T /F，其他平台用负 PID 杀进程组。
 * - 每个进程都带超时兜底，避免 ffprobe 卡在损坏文件上把 UI 挂死。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被强杀 */
  timedOut: boolean;
  /** 是否被调用方取消 */
  canceled: boolean;
  spawnError: string | null;
}

export interface RunOptions {
  timeoutMs?: number;
  /** stdout 按行回调（用于 -progress 解析） */
  onStdoutLine?: (line: string) => void;
  /** stderr 按行回调（用于错误诊断与日志） */
  onStderrLine?: (line: string) => void;
  /** stderr 保留的最大尾部字符数，防止超长日志吃内存 */
  maxStderrChars?: number;
}

export interface RunningProcess {
  id: string;
  child: ChildProcess;
  /** 取消：杀进程树 */
  cancel: () => void;
  /** 等待结束 */
  done: Promise<RunResult>;
  canceled: boolean;
}

export function runProcess(
  bin: string,
  args: string[],
  options: RunOptions = {},
): RunningProcess {
  const { timeoutMs = 0, onStdoutLine, onStderrLine, maxStderrChars = 64 * 1024 } = options;

  const child = spawn(bin, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutTail = '';
  let stderrTail = '';
  let timedOut = false;
  let canceled = false;
  let spawnError: string | null = null;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    if (onStdoutLine) {
      stdoutTail += chunk;
      const lines = stdoutTail.split(/\r?\n/);
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onStdoutLine(line);
    }
  });

  child.stderr?.on('data', (chunk: string) => {
    // 只保留尾部，避免超长日志
    stderr = (stderr + chunk).slice(-maxStderrChars);
    if (onStderrLine) {
      stderrTail += chunk;
      const lines = stderrTail.split(/\r?\n/);
      stderrTail = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onStderrLine(line);
    }
  });

  child.on('error', (err) => {
    spawnError = err.message;
  });

  const done = new Promise<RunResult>((resolve) => {
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // 冲刷残余行
      if (onStdoutLine && stdoutTail.trim()) onStdoutLine(stdoutTail);
      if (onStderrLine && stderrTail.trim()) onStderrLine(stderrTail);
      resolve({ code, stdout, stderr, timedOut, canceled, spawnError });
    });
  });

  const handle: RunningProcess = {
    id: randomUUID(),
    child,
    canceled: false,
    cancel() {
      handle.canceled = true;
      canceled = true;
      killTree(child);
    },
    done,
  };
  return handle;
}

/** 杀整个进程树（Windows 必须用 taskkill /T，否则 ffmpeg 的子进程会残留） */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
    }
  }
}

/** 一次性执行并等待结果（用于 ffprobe / 版本查询等短命令） */
export async function exec(
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return runProcess(bin, args, options).done;
}
