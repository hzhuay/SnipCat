/**
 * 输出路径解析。
 *
 * 输出文件可能已被占用：磁盘上已存在同名文件，或队列里已有别的任务 claim 了
 * 这个路径。此时用 `_2`、`_3`… 递增改名。纯函数，渲染层的 output:check 与
 * 主进程调度器共用同一套规则，保证两端预测一致。
 */

/** 拆出「基础路径」与「扩展名」，如 `D:/a.mp4` → `{ base: 'D:/a', ext: '.mp4' }` */
function splitBaseExt(p: string): { base: string; ext: string } {
  const m = /^(.*?)(\.[^./\\]+)$/.exec(p)
  if (!m) return { base: p, ext: '' }
  return { base: m[1], ext: m[2] }
}

/**
 * 取一个未被占用的输出路径。
 *
 * @param requested 期望路径（含目录）
 * @param isTaken 判断路径是否已被占用（磁盘存在 / 队列已 claim）
 * @returns requested 可用时原样返回，否则 base_2.ext、base_3.ext… 第一个可用的
 */
export function resolveOutputPath(requested: string, isTaken: (p: string) => boolean): string {
  if (!isTaken(requested)) return requested

  const { base, ext } = splitBaseExt(requested)
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}${ext}`
    if (!isTaken(candidate)) return candidate
  }
  return `${base}_999${ext}`
}
