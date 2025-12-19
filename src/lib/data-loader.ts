import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { getProjectsDir, getSettingsPath } from './paths.js'
import { DEFAULT_MODEL_ID, getPricingForModel, tokensToCost } from './pricing.js'

export const BASE_DIR = getProjectsDir()

export interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  cache_creation_input_tokens?: number
}

export interface UsageStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  cacheWriteTokens: number
}

export interface DailyModelStats extends UsageStats {
  cost: number
  requests: number
}

export interface SummaryStats {
  cost: number
  tokens: number
  requests: number
}

export interface GrandTotal extends SummaryStats {
  cacheHitTokens: number
  cacheMissTokens: number
}

export type DailyData = Record<string, Record<string, Record<string, DailyModelStats>>>

export interface AnalysisData {
  defaultModelId: string
  dailyData: DailyData
  dailySummary: Record<string, SummaryStats>
  modelTotals: Record<string, SummaryStats>
  projectTotals: Record<string, SummaryStats>
  grandTotal: GrandTotal
  topModel: (SummaryStats & { id: string }) | null
  topProject: (SummaryStats & { name: string }) | null
  cacheHitRate: number
  activeDays: number
}

export interface LoadUsageOptions {
  days?: number | null
}

interface SettingsFile {
  model?: unknown
}

interface JsonlRecord {
  providerData?: {
    rawUsage?: RawUsage
    model?: unknown
  }
  timestamp?: unknown
}

async function loadModelFromSettings(): Promise<string> {
  try {
    const settingsPath = getSettingsPath()
    const settingsRaw = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(settingsRaw) as SettingsFile
    return typeof settings?.model === 'string' ? settings.model : DEFAULT_MODEL_ID
  } catch {
    return DEFAULT_MODEL_ID
  }
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(
      dirents.map(async dirent => {
        const res = path.resolve(dir, dirent.name)
        if (dirent.isDirectory()) {
          return findJsonlFiles(res)
        }
        return res.endsWith('.jsonl') ? [res] : ([] as string[])
      })
    )
    return files.flat()
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && (error as any).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function getProjectName(filePath: string): string {
  const parts = filePath.split(path.sep)
  const projectsIndex = parts.lastIndexOf('projects')
  if (projectsIndex !== -1 && projectsIndex < parts.length - 1) {
    return parts[projectsIndex + 1] ?? 'unknown-project'
  }
  return 'unknown-project'
}

function extractUsageStats(usage: RawUsage): UsageStats {
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0
  const cacheMissTokens =
    usage.prompt_cache_miss_tokens ?? (cacheHitTokens > 0 ? Math.max(promptTokens - cacheHitTokens, 0) : 0)
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheWriteTokens,
  }
}

function computeUsageCost(
  usage: RawUsage,
  modelId: string | null | undefined
): { cost: number; stats: UsageStats; modelId: string } {
  const stats = extractUsageStats(usage)
  const pricing = getPricingForModel(modelId)

  let inputCost = 0
  if (stats.cacheHitTokens || stats.cacheMissTokens || stats.cacheWriteTokens) {
    inputCost += tokensToCost(stats.cacheHitTokens, pricing.cacheRead)
    inputCost += tokensToCost(stats.cacheMissTokens, pricing.prompt)
    inputCost += tokensToCost(stats.cacheWriteTokens, pricing.cacheWrite)
  } else {
    inputCost += tokensToCost(stats.promptTokens, pricing.prompt)
  }

  const outputCost = tokensToCost(stats.completionTokens, pricing.completion)

  return { cost: inputCost + outputCost, stats, modelId: modelId || DEFAULT_MODEL_ID }
}

/**
 * 加载所有用量数据
 */
export async function loadUsageData(options: LoadUsageOptions = {}): Promise<AnalysisData> {
  const defaultModelId = await loadModelFromSettings()
  const jsonlFiles = await findJsonlFiles(BASE_DIR)

  // 计算日期过滤范围
  let minDate: string | null = null
  if (options.days) {
    const d = new Date()
    d.setDate(d.getDate() - options.days + 1)
    d.setHours(0, 0, 0, 0)
    minDate = d.toISOString().split('T')[0] ?? null
  }

  // 按日期 -> 项目 -> 模型 组织的数据
  const dailyData: DailyData = {}

  // 按模型汇总
  const modelTotals: Record<string, SummaryStats> = {}

  // 按项目汇总
  const projectTotals: Record<string, SummaryStats> = {}

  // 总计
  const grandTotal: GrandTotal = {
    cost: 0,
    tokens: 0,
    requests: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }

  for (const filePath of jsonlFiles) {
    const fileStat = await fs.stat(filePath)
    if (fileStat.size === 0) continue

    const fileStream = fsSync.createReadStream(filePath)
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    })

    const projectName = getProjectName(filePath)

    for await (const line of rl) {
      try {
        const record = JSON.parse(line) as JsonlRecord
        const usage = record?.providerData?.rawUsage
        const timestamp = record?.timestamp

        if (!usage || timestamp == null) continue

        const dateObj = new Date(timestamp as any)
        if (Number.isNaN(dateObj.getTime())) continue
        const date = dateObj.toISOString().split('T')[0]
        if (!date) continue

        // 日期过滤
        if (minDate && date < minDate) continue

        const recordModelId = record?.providerData?.model
        const modelId = typeof recordModelId === 'string' ? recordModelId : null
        const { cost, stats: usageStats, modelId: usedModelId } = computeUsageCost(usage, modelId)

        dailyData[date] ??= {}
        dailyData[date]![projectName] ??= {}
        dailyData[date]![projectName]![usedModelId] ??= {
          cost: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          cacheWriteTokens: 0,
          requests: 0,
        }

        const dayStats = dailyData[date]![projectName]![usedModelId]!
        dayStats.cost += cost
        dayStats.promptTokens += usageStats.promptTokens
        dayStats.completionTokens += usageStats.completionTokens
        dayStats.totalTokens += usageStats.totalTokens
        dayStats.cacheHitTokens += usageStats.cacheHitTokens
        dayStats.cacheMissTokens += usageStats.cacheMissTokens
        dayStats.cacheWriteTokens += usageStats.cacheWriteTokens
        dayStats.requests += 1

        modelTotals[usedModelId] ??= { cost: 0, tokens: 0, requests: 0 }
        modelTotals[usedModelId]!.cost += cost
        modelTotals[usedModelId]!.tokens += usageStats.totalTokens
        modelTotals[usedModelId]!.requests += 1

        projectTotals[projectName] ??= { cost: 0, tokens: 0, requests: 0 }
        projectTotals[projectName]!.cost += cost
        projectTotals[projectName]!.tokens += usageStats.totalTokens
        projectTotals[projectName]!.requests += 1

        grandTotal.cost += cost
        grandTotal.tokens += usageStats.totalTokens
        grandTotal.requests += 1
        grandTotal.cacheHitTokens += usageStats.cacheHitTokens
        grandTotal.cacheMissTokens += usageStats.cacheMissTokens
      } catch {
        // 忽略无法解析的行
      }
    }
  }

  // 计算每日汇总
  const dailySummary: Record<string, SummaryStats> = {}
  for (const date of Object.keys(dailyData)) {
    dailySummary[date] = { cost: 0, tokens: 0, requests: 0 }
    for (const project of Object.values(dailyData[date] ?? {})) {
      for (const model of Object.values(project ?? {})) {
        dailySummary[date]!.cost += model.cost
        dailySummary[date]!.tokens += model.totalTokens
        dailySummary[date]!.requests += model.requests
      }
    }
  }

  const topModelEntry = Object.entries(modelTotals).sort((a, b) => b[1].cost - a[1].cost)[0]
  const topProjectEntry =
    Object.entries(projectTotals).sort((a, b) => b[1].cost - a[1].cost)[0]

  // 计算缓存命中率
  const cacheHitRate =
    grandTotal.cacheHitTokens + grandTotal.cacheMissTokens > 0
      ? grandTotal.cacheHitTokens / (grandTotal.cacheHitTokens + grandTotal.cacheMissTokens)
      : 0

  return {
    defaultModelId,
    dailyData,
    dailySummary,
    modelTotals,
    projectTotals,
    grandTotal,
    topModel: topModelEntry ? { id: topModelEntry[0], ...topModelEntry[1] } : null,
    topProject: topProjectEntry ? { name: topProjectEntry[0], ...topProjectEntry[1] } : null,
    cacheHitRate,
    activeDays: Object.keys(dailyData).length,
  }
}
