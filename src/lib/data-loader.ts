import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { getIdeDataDir, getProjectsDir, getSettingsPath } from './paths.js'
import { DEFAULT_MODEL_ID, getPricingForModel, tokensToCost } from './pricing.js'
import { loadWorkspaceMappings, type WorkspaceMapping } from './workspace-resolver.js'

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
  /** 工作区 hash -> 路径映射（仅 IDE source 有效） */
  workspaceMappings?: Map<string, import('./workspace-resolver.js').WorkspaceMapping>
}

export type UsageSource = 'code' | 'ide'

export interface LoadUsageOptions {
  days?: number | null
  source?: UsageSource
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

function computeUsageCost(usage: RawUsage, modelId: string): { cost: number; stats: UsageStats } {
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

  return { cost: inputCost + outputCost, stats }
}

function computeMinDate(days?: number | null): string | null {
  if (!days) return null
  const d = new Date()
  d.setDate(d.getDate() - days + 1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().split('T')[0] ?? null
}

function toISODateString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().split('T')[0] ?? null
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function ensureDailyModelStats(dailyData: DailyData, date: string, project: string, modelId: string): DailyModelStats {
  dailyData[date] ??= {}
  dailyData[date]![project] ??= {}
  dailyData[date]![project]![modelId] ??= {
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
  }
  return dailyData[date]![project]![modelId]!
}

function finalizeAnalysis(
  defaultModelId: string,
  dailyData: DailyData,
  modelTotals: Record<string, SummaryStats>,
  projectTotals: Record<string, SummaryStats>,
  grandTotal: GrandTotal,
  workspaceMappings?: Map<string, WorkspaceMapping>
): AnalysisData {
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
  const topProjectEntry = Object.entries(projectTotals).sort((a, b) => b[1].cost - a[1].cost)[0]

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
    workspaceMappings,
  }
}

/**
 * 加载所有用量数据
 */
export async function loadUsageData(options: LoadUsageOptions = {}): Promise<AnalysisData> {
  const source: UsageSource = options.source ?? 'code'
  if (source === 'ide') {
    return loadIdeUsageData(options)
  }
  return loadCodeUsageData(options)
}

async function loadCodeUsageData(options: LoadUsageOptions = {}): Promise<AnalysisData> {
  const defaultModelId = await loadModelFromSettings()
  const jsonlFiles = await findJsonlFiles(BASE_DIR)
  const minDate = computeMinDate(options.days)

  const dailyData: DailyData = {}
  const modelTotals: Record<string, SummaryStats> = {}
  const projectTotals: Record<string, SummaryStats> = {}
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

        if (minDate && date < minDate) continue

        const recordModelId = record?.providerData?.model
        const modelFromRecord = typeof recordModelId === 'string' ? recordModelId : null
        const usedModelId = modelFromRecord || defaultModelId

        const { cost, stats: usageStats } = computeUsageCost(usage, usedModelId)

        const dayStats = ensureDailyModelStats(dailyData, date, projectName, usedModelId)
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

  return finalizeAnalysis(defaultModelId, dailyData, modelTotals, projectTotals, grandTotal)
}

interface IdeConversationMeta {
  id?: unknown
  createdAt?: unknown
  lastMessageAt?: unknown
}

interface IdeRequestUsage {
  inputTokens?: unknown
  outputTokens?: unknown
  totalTokens?: unknown
}

interface IdeRequest {
  messages?: unknown
  usage?: IdeRequestUsage
}

interface IdeConversationIndex {
  requests?: unknown
}

async function findIdeHistoryDirs(): Promise<string[]> {
  const root = getIdeDataDir()
  const out = new Set<string>()

  let level1: fsSync.Dirent[] = []
  try {
    level1 = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  for (const dirent of level1) {
    if (!dirent.isDirectory()) continue
    const codeBuddyIdeDir = path.join(root, dirent.name, 'CodeBuddyIDE')
    if (!(await pathExists(codeBuddyIdeDir))) continue

    const directHistory = path.join(codeBuddyIdeDir, 'history')
    if (await pathExists(directHistory)) {
      out.add(directHistory)
      continue
    }

    let nested: fsSync.Dirent[] = []
    try {
      nested = await fs.readdir(codeBuddyIdeDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const child of nested) {
      if (!child.isDirectory()) continue
      const nestedHistory = path.join(codeBuddyIdeDir, child.name, 'history')
      if (await pathExists(nestedHistory)) {
        out.add(nestedHistory)
      }
    }
  }

  return [...out]
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw) as unknown
}

async function readFileHeadUtf8(filePath: string, bytes = 64 * 1024): Promise<string> {
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

function extractModelIdFromMessageHead(head: string): string | null {
  // extra 是一个转义的 JSON 字符串，形如: "extra": "{\"modelId\":\"gpt-5.1\",...}"
  // 正则需要匹配包含转义字符的完整字符串
  const extraMatch = head.match(/"extra"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
  if (!extraMatch?.[1]) return null

  try {
    // extraMatch[1] 是转义后的内容，需要先解析为字符串
    const extraStr = JSON.parse(`"${extraMatch[1]}"`) as string
    const extra = JSON.parse(extraStr) as { modelId?: unknown; modelName?: unknown }
    if (typeof extra.modelId === 'string' && extra.modelId) return extra.modelId
    if (typeof extra.modelName === 'string' && extra.modelName) return extra.modelName
    return null
  } catch {
    return null
  }
}

async function inferIdeModelIdForRequest(
  conversationDir: string,
  request: IdeRequest,
  messageModelCache: Map<string, string>
): Promise<string | null> {
  const messages = Array.isArray(request.messages) ? (request.messages as unknown[]) : []

  for (let i = 0; i < Math.min(messages.length, 3); i++) {
    const messageId = messages[i]
    if (typeof messageId !== 'string' || !messageId) continue

    const cached = messageModelCache.get(messageId)
    if (cached) return cached

    const msgPath = path.join(conversationDir, 'messages', `${messageId}.json`)
    try {
      const head = await readFileHeadUtf8(msgPath)
      const modelId = extractModelIdFromMessageHead(head)
      if (modelId) {
        messageModelCache.set(messageId, modelId)
        return modelId
      }
    } catch {
      // ignore
    }
  }

  return null
}

async function loadIdeUsageData(options: LoadUsageOptions = {}): Promise<AnalysisData> {
  const defaultModelId = await loadModelFromSettings()
  const minDate = computeMinDate(options.days)

  // 加载工作区映射
  const workspaceMappings = await loadWorkspaceMappings()

  const dailyData: DailyData = {}
  const modelTotals: Record<string, SummaryStats> = {}
  const projectTotals: Record<string, SummaryStats> = {}
  const grandTotal: GrandTotal = {
    cost: 0,
    tokens: 0,
    requests: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }

  const historyDirs = await findIdeHistoryDirs()
  const messageModelCache = new Map<string, string>()

  for (const historyDir of historyDirs) {
    let workspaces: fsSync.Dirent[] = []
    try {
      workspaces = await fs.readdir(historyDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue
      const workspaceHash = ws.name
      const workspaceDir = path.join(historyDir, workspaceHash)
      const workspaceIndexPath = path.join(workspaceDir, 'index.json')

      let convList: IdeConversationMeta[] = []
      try {
        const parsed = (await readJsonFile(workspaceIndexPath)) as unknown
        if (Array.isArray(parsed)) {
          convList = parsed as IdeConversationMeta[]
        } else if (parsed && typeof parsed === 'object') {
          const maybe = (parsed as any).conversations ?? (parsed as any).items ?? (parsed as any).list
          if (Array.isArray(maybe)) convList = maybe as IdeConversationMeta[]
        }
      } catch {
        continue
      }

      for (const conv of convList) {
        const conversationId = typeof conv.id === 'string' ? conv.id : null
        if (!conversationId) continue

        const date = toISODateString(conv.lastMessageAt) ?? toISODateString(conv.createdAt)
        if (!date) continue
        if (minDate && date < minDate) continue

        const conversationDir = path.join(workspaceDir, conversationId)
        const convIndexPath = path.join(conversationDir, 'index.json')

        let convIndex: IdeConversationIndex | null = null
        try {
          convIndex = (await readJsonFile(convIndexPath)) as IdeConversationIndex
        } catch {
          continue
        }

        const requests = Array.isArray(convIndex?.requests) ? (convIndex!.requests as IdeRequest[]) : []
        for (const req of requests) {
          const usage = req?.usage
          const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : Number(usage?.inputTokens ?? 0)
          const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : Number(usage?.outputTokens ?? 0)
          const totalTokens =
            typeof usage?.totalTokens === 'number'
              ? usage.totalTokens
              : Number.isFinite(Number(usage?.totalTokens))
                ? Number(usage?.totalTokens)
                : inputTokens + outputTokens

          if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(totalTokens)) continue

          const inferredModelId = await inferIdeModelIdForRequest(conversationDir, req, messageModelCache)
          const usedModelId = inferredModelId || defaultModelId

          const rawUsage: RawUsage = {
            prompt_tokens: Math.max(0, inputTokens),
            completion_tokens: Math.max(0, outputTokens),
            total_tokens: Math.max(0, totalTokens),
          }

          const { cost, stats } = computeUsageCost(rawUsage, usedModelId)

          const projectName = workspaceHash
          const dayStats = ensureDailyModelStats(dailyData, date, projectName, usedModelId)
          dayStats.cost += cost
          dayStats.promptTokens += stats.promptTokens
          dayStats.completionTokens += stats.completionTokens
          dayStats.totalTokens += stats.totalTokens
          dayStats.requests += 1

          modelTotals[usedModelId] ??= { cost: 0, tokens: 0, requests: 0 }
          modelTotals[usedModelId]!.cost += cost
          modelTotals[usedModelId]!.tokens += stats.totalTokens
          modelTotals[usedModelId]!.requests += 1

          projectTotals[projectName] ??= { cost: 0, tokens: 0, requests: 0 }
          projectTotals[projectName]!.cost += cost
          projectTotals[projectName]!.tokens += stats.totalTokens
          projectTotals[projectName]!.requests += 1

          grandTotal.cost += cost
          grandTotal.tokens += stats.totalTokens
          grandTotal.requests += 1
        }
      }
    }
  }

  return finalizeAnalysis(defaultModelId, dailyData, modelTotals, projectTotals, grandTotal, workspaceMappings)
}
