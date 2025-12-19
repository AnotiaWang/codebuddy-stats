/**
 * 格式化数字，添加千分位分隔符
 */
export function formatNumber(num: number | string | null | undefined): string {
  const n = typeof num === 'number' ? num : Number(num ?? 0)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US')
}

/**
 * 格式化金额
 */
export function formatCost(cost: number): string {
  const n = Number.isFinite(cost) ? cost : 0
  return `$${n.toFixed(2)}`
}

/**
 * 格式化 tokens 数量 (K/M/B)
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(1)}B`
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`
  }
  return String(tokens)
}

/**
 * 格式化百分比
 */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

/**
 * 截断字符串
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/**
 * 右对齐字符串
 */
export function padLeft(str: string, len: number): string {
  return str.padStart(len)
}

/**
 * 左对齐字符串
 */
export function padRight(str: string, len: number): string {
  return str.padEnd(len)
}
