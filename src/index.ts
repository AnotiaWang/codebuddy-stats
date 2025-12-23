#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import blessed from 'blessed'

import { loadUsageData } from './lib/data-loader.js'
import type { AnalysisData } from './lib/data-loader.js'
import { resolveProjectName } from './lib/workspace-resolver.js'
import { formatCost, formatNumber, formatPercent, formatTokens, truncate } from './lib/utils.js'

// 读取 package.json 获取版本号
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgPath = path.resolve(__dirname, '../package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }
const VERSION = pkg.version

type CliOptions = {
  days: number | null
  noTui: boolean
}

// 解析命令行参数
function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const options: CliOptions = { days: null, noTui: false }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10)
      options.days = Number.isFinite(parsed) ? parsed : null
      i++
    } else if (args[i] === '--no-tui') {
      options.noTui = true
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
CodeBuddy Stats

Usage: codebuddy-stats [options]

Options:
  --days <n>    只显示最近 n 天的数据
  --no-tui      使用纯文本输出（不启用交互式界面）
  --help, -h    显示帮助信息
`)
      process.exit(0)
    }
  }
  return options
}

// 获取热力图字符
function getHeatChar(cost: number, maxCost: number): string {
  if (cost === 0) return '·'
  const ratio = cost / maxCost
  if (ratio < 0.25) return '░'
  if (ratio < 0.5) return '▒'
  if (ratio < 0.75) return '▓'
  return '█'
}

// 渲染 Overview 视图
function renderOverview(box: any, data: AnalysisData, width: number, height: number, note: string): void {
  const { dailySummary, grandTotal, topModel, topProject, cacheHitRate, activeDays } = data

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  const stripTags = (s: string): string => s.replace(/\{[^}]+\}/g, '')
  const visibleLen = (s: string): number => stripTags(s).length
  const padEndVisible = (s: string, target: number): string => {
    const pad = Math.max(0, target - visibleLen(s))
    return s + ' '.repeat(pad)
  }

  const wrapGrayNoteLines = (text: string, maxWidth: number): string[] => {
    const prefix = '{gray-fg}'
    const suffix = '{/gray-fg}'
    const full = `备注：${text}`
    const w = Math.max(10, Math.floor(maxWidth || 10))
    const lines: string[] = []

    let i = 0
    while (i < full.length) {
      const chunk = full.slice(i, i + w)
      lines.push(prefix + chunk + suffix)
      i += w
    }

    return lines
  }

  const buildHeatmapLines = (heatWidth: number): string[] => {
    const safeWidth = Math.max(30, Math.floor(heatWidth || 30))

    // 根据宽度计算热力图周数
    const availableWidth = safeWidth - 10
    const maxWeeks = Math.min(Math.floor(availableWidth / 2), 26) // 最多 26 周 (半年)

    // 生成正确的日期网格 - 从今天往前推算
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]!

    // 找到最近的周六作为结束点（或今天）
    const endDate = new Date(today)

    // 往前推 maxWeeks 周
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - maxWeeks * 7 + 1)
    // 调整到周一开始（getDay(): 0=Sun, 1=Mon, ..., 6=Sat）
    const dayOfWeekStart = startDate.getDay()
    const offsetToMonday = dayOfWeekStart === 0 ? -6 : 1 - dayOfWeekStart
    startDate.setDate(startDate.getDate() + offsetToMonday)

    // 构建周数组，每周从周一到周日
    const weeks: string[][] = []
    const currentDate = new Date(startDate)
    while (currentDate <= endDate) {
      const week: string[] = []
      for (let d = 0; d < 7; d++) {
        const dateStr = currentDate.toISOString().split('T')[0]!
        week.push(dateStr)
        currentDate.setDate(currentDate.getDate() + 1)
      }
      weeks.push(week)
    }

    // 以“当前热力图窗口”的最大值做归一化（避免历史极值导致近期全是浅色）
    const visibleCosts: number[] = []
    for (const week of weeks) {
      for (const date of week) {
        if (!date || date > todayStr) continue
        visibleCosts.push(dailySummary[date]?.cost ?? 0)
      }
    }
    const maxCost = Math.max(...visibleCosts, 0) || 1

    // 月份标尺（在列上方标注月份变化）
    const colWidth = 2 // 每周一列：字符 + 空格
    const heatStartCol = 4 // 左侧周几标签宽度
    const headerLen = heatStartCol + weeks.length * colWidth
    const monthHeader = Array.from({ length: headerLen }, () => ' ')
    let lastMonth = -1
    let lastPlacedAt = -999

    for (let i = 0; i < weeks.length; i++) {
      const week = weeks[i]!
      const repDate = week.find(d => d && d <= todayStr) ?? week[0]
      if (!repDate) continue

      const m = new Date(repDate).getMonth()
      if (m !== lastMonth) {
        const label = monthNames[m]!
        const pos = heatStartCol + i * colWidth

        // 避免月份标签过于拥挤/相互覆盖
        if (pos - lastPlacedAt >= 4 && pos + label.length <= monthHeader.length) {
          for (let k = 0; k < label.length; k++) monthHeader[pos + k] = label[k]!
          lastPlacedAt = pos
        }
        lastMonth = m
      }
    }

    const lines: string[] = []
    lines.push('{bold}Cost Heatmap{/bold}')
    lines.push('')
    lines.push(`{gray-fg}${monthHeader.join('').trimEnd()}{/gray-fg}`)

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      let row = dayLabels[dayOfWeek]!.padEnd(4)
      for (const week of weeks) {
        const date = week[dayOfWeek]
        if (date && date <= todayStr && dailySummary[date]) {
          row += getHeatChar(dailySummary[date]!.cost, maxCost) + ' '
        } else if (date && date <= todayStr) {
          row += '· ' // 有日期但无数据
        } else {
          row += '  ' // 未来日期
        }
      }
      lines.push(row.trimEnd())
    }

    const rangeStart = weeks[0]?.[0] ?? todayStr
    lines.push(`{gray-fg}Range: ${rangeStart} → ${todayStr}{/gray-fg}`)
    lines.push('    Less {gray-fg}·░▒▓{/gray-fg}{white-fg}█{/white-fg} More')

    return lines
  }

  const buildSummaryLines = (summaryWidth: number, compact: boolean): string[] => {
    const avgDailyCost = activeDays > 0 ? grandTotal.cost / activeDays : 0
    const w = Math.max(24, Math.floor(summaryWidth || 24))
    const maxW = Math.min(w, 80)

    const lines: string[] = []
    lines.push('{bold}Summary{/bold}')
    if (!compact) lines.push('─'.repeat(Math.min(Math.max(10, maxW - 2), 70)))

    const twoCol = maxW >= 46

    if (twoCol) {
      const leftLabelW = 18
      const rightLabelW = 18
      const leftValW = 12
      const rightValW = 8
      const leftPartW = leftLabelW + leftValW + 4

      lines.push(
        padEndVisible(
          padEndVisible('{green-fg}~Total cost:{/green-fg}', leftLabelW) + formatCost(grandTotal.cost).padStart(leftValW),
          leftPartW,
        ) +
          padEndVisible(' {green-fg}Active days:{/green-fg}', rightLabelW) +
          String(activeDays).padStart(rightValW),
      )

      lines.push(
        padEndVisible(
          padEndVisible('{green-fg}Total tokens:{/green-fg}', leftLabelW) +
            formatTokens(grandTotal.tokens).padStart(leftValW),
          leftPartW,
        ) +
          padEndVisible(' {green-fg}Total requests:{/green-fg}', rightLabelW) +
          formatNumber(grandTotal.requests).padStart(rightValW),
      )

      lines.push(
        padEndVisible(
          padEndVisible('{green-fg}Cache hit rate:{/green-fg}', leftLabelW) +
            formatPercent(cacheHitRate).padStart(leftValW),
          leftPartW,
        ) +
          padEndVisible(' {green-fg}Avg daily cost:{/green-fg}', rightLabelW) +
          formatCost(avgDailyCost).padStart(rightValW),
      )
    } else {
      lines.push(`{green-fg}~Total cost:{/green-fg}      ${formatCost(grandTotal.cost)}`)
      lines.push(`{green-fg}Total tokens:{/green-fg}     ${formatTokens(grandTotal.tokens)}`)
      lines.push(`{green-fg}Total requests:{/green-fg}   ${formatNumber(grandTotal.requests)}`)
      lines.push(`{green-fg}Active days:{/green-fg}      ${activeDays}`)
      lines.push(`{green-fg}Cache hit rate:{/green-fg}   ${formatPercent(cacheHitRate)}`)
      lines.push(`{green-fg}Avg daily cost:{/green-fg}   ${formatCost(avgDailyCost)}`)
    }

    if (!compact) lines.push('')

    if (topModel) {
      const label = '{cyan-fg}Top model:{/cyan-fg} '
      const tail = `(${formatCost(topModel.cost)})`
      const maxIdLen = Math.max(4, maxW - visibleLen(label) - visibleLen(tail) - 2)
      lines.push(label + truncate(topModel.id, maxIdLen) + ' ' + tail)
    }

    if (topProject) {
      const label = '{cyan-fg}Top project:{/cyan-fg} '
      const shortName = resolveProjectName(topProject.name, data.workspaceMappings)
      const tail = `(${formatCost(topProject.cost)})`
      const maxNameLen = Math.max(4, maxW - visibleLen(label) - visibleLen(tail) - 2)
      lines.push(label + truncate(shortName, maxNameLen) + ' ' + tail)
    }

    return lines
  }

  const noteLines = note ? wrapGrayNoteLines(note, Math.max(20, width - 6)) : []

  // 尝试默认：热力图在上，Summary 在下
  const verticalHeat = buildHeatmapLines(width)
  const verticalSummary = buildSummaryLines(width, false)
  const verticalLines: string[] = [...verticalHeat, '', ...verticalSummary]
  if (noteLines.length) verticalLines.push('', ...noteLines)

  if (verticalLines.length <= height) {
    box.setContent(verticalLines.join('\n'))
    return
  }

  // 终端偏矮：尝试把 Summary 放到右侧（需要足够宽度）
  const gap = 6
  const minSummaryWidth = 34
  const leftWidthBudget = Math.max(30, width - minSummaryWidth - gap)
  const leftHeat = buildHeatmapLines(leftWidthBudget)
  const leftVisibleWidth = Math.max(...leftHeat.map(l => visibleLen(l)), 0)
  const rightWidth = Math.max(0, width - leftVisibleWidth - gap)

  if (rightWidth >= minSummaryWidth) {
    const rightSummary = buildSummaryLines(rightWidth, true)
    const rowCount = Math.max(leftHeat.length, rightSummary.length)
    const sideLines: string[] = []

    for (let i = 0; i < rowCount; i++) {
      const l = leftHeat[i] ?? ''
      const r = rightSummary[i] ?? ''
      sideLines.push(padEndVisible(l, leftVisibleWidth) + ' '.repeat(gap) + r)
    }

    if (noteLines.length) sideLines.push('', ...noteLines)

    if (sideLines.length <= height) {
      box.setContent(sideLines.join('\n'))
      return
    }
  }

  // fallback：仍然输出纵向布局（可滚动）
  box.setContent(verticalLines.join('\n'))
}

// 渲染 By Model 视图
function renderByModel(
  box: any,
  data: AnalysisData,
  scrollOffset = 0,
  width: number,
  note: string,
  pageSize: number,
): void {
  const { modelTotals, grandTotal } = data
  const sorted = Object.entries(modelTotals).sort((a, b) => b[1].cost - a[1].cost)

  // 根据宽度计算列宽
  const availableWidth = width - 6 // padding
  const fixedCols = 12 + 12 + 12 + 10 // Cost + Requests + Tokens + Avg/Req
  const modelCol = Math.max(20, Math.min(40, availableWidth - fixedCols))
  const totalWidth = modelCol + fixedCols

  let content = '{bold}Cost by Model{/bold}\n\n'
  content +=
    '{underline}' +
    'Model'.padEnd(modelCol) +
    '~Cost'.padStart(12) +
    'Requests'.padStart(12) +
    'Tokens'.padStart(12) +
    'Avg/Req'.padStart(10) +
    '{/underline}\n'

  const safePageSize = Math.max(1, Math.floor(pageSize || 1))
  const visibleModels = sorted.slice(scrollOffset, scrollOffset + safePageSize)

  for (const [modelId, stats] of visibleModels) {
    const avgPerReq = stats.requests > 0 ? stats.cost / stats.requests : 0
    content +=
      truncate(modelId, modelCol - 1).padEnd(modelCol) +
      formatCost(stats.cost).padStart(12) +
      formatNumber(stats.requests).padStart(12) +
      formatTokens(stats.tokens).padStart(12) +
      formatCost(avgPerReq).padStart(10) +
      '\n'
  }

  content += '─'.repeat(totalWidth) + '\n'
  content +=
    '{bold}' +
    'Total'.padEnd(modelCol) +
    formatCost(grandTotal.cost).padStart(12) +
    formatNumber(grandTotal.requests).padStart(12) +
    formatTokens(grandTotal.tokens).padStart(12) +
    '{/bold}\n'

  if (sorted.length > safePageSize) {
    content += `\n{gray-fg}Showing ${scrollOffset + 1}-${Math.min(scrollOffset + safePageSize, sorted.length)} of ${sorted.length} models (↑↓ to scroll){/gray-fg}`
  }

  if (note) {
    content += `\n\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 渲染 By Project 视图
function renderByProject(
  box: any,
  data: AnalysisData,
  scrollOffset = 0,
  width: number,
  note: string,
  pageSize: number,
): void {
  const { projectTotals, grandTotal } = data
  const sorted = Object.entries(projectTotals).sort((a, b) => b[1].cost - a[1].cost)

  // 根据宽度计算列宽
  const availableWidth = width - 6 // padding
  const fixedCols = 12 + 12 + 12 // Cost + Requests + Tokens
  const projectCol = Math.max(25, availableWidth - fixedCols)
  const totalWidth = projectCol + fixedCols

  let content = '{bold}Cost by Project{/bold}\n\n'
  content +=
    '{underline}' +
    'Project'.padEnd(projectCol) +
    '~Cost'.padStart(12) +
    'Requests'.padStart(12) +
    'Tokens'.padStart(12) +
    '{/underline}\n'

  const safePageSize = Math.max(1, Math.floor(pageSize || 1))
  const visibleProjects = sorted.slice(scrollOffset, scrollOffset + safePageSize)

  for (const [projectName, stats] of visibleProjects) {
    // 简化项目名
    const shortName = resolveProjectName(projectName, data.workspaceMappings)
    content +=
      truncate(shortName, projectCol - 1).padEnd(projectCol) +
      formatCost(stats.cost).padStart(12) +
      formatNumber(stats.requests).padStart(12) +
      formatTokens(stats.tokens).padStart(12) +
      '\n'
  }

  content += '─'.repeat(totalWidth) + '\n'
  content +=
    '{bold}' +
    `Total (${sorted.length} projects)`.padEnd(projectCol) +
    formatCost(grandTotal.cost).padStart(12) +
    formatNumber(grandTotal.requests).padStart(12) +
    formatTokens(grandTotal.tokens).padStart(12) +
    '{/bold}\n'

  if (sorted.length > safePageSize) {
    content += `\n{gray-fg}Showing ${scrollOffset + 1}-${Math.min(scrollOffset + safePageSize, sorted.length)} of ${sorted.length} projects (↑↓ to scroll){/gray-fg}`
  }

  if (note) {
    content += `\n\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 渲染 Daily 视图
function renderDaily(
  box: any,
  data: AnalysisData,
  scrollOffset = 0,
  selectedIndex = 0,
  width: number,
  note: string,
  pageSize: number,
): void {
  const { dailySummary, dailyData } = data
  const sortedDates = Object.keys(dailySummary).sort().reverse()

  // 根据宽度计算列宽
  const availableWidth = width - 6 // padding
  const dateCol = 12
  const costCol = 12
  const tokensCol = 10
  const reqCol = 10
  const fixedCols = dateCol + costCol + tokensCol + reqCol
  const remainingWidth = availableWidth - fixedCols
  const modelCol = Math.max(15, Math.min(25, Math.floor(remainingWidth * 0.4)))
  const projectCol = Math.max(20, remainingWidth - modelCol)

  let content = '{bold}Daily Cost Details{/bold}\n\n'
  content +=
    '{underline}' +
    'Date'.padEnd(dateCol) +
    '~Cost'.padStart(costCol) +
    'Tokens'.padStart(tokensCol) +
    'Requests'.padStart(reqCol) +
    'Top Model'.padStart(modelCol) +
    'Top Project'.padStart(projectCol) +
    '{/underline}\n'

  const safePageSize = Math.max(1, Math.floor(pageSize || 1))
  const visibleDates = sortedDates.slice(scrollOffset, scrollOffset + safePageSize)

  for (let i = 0; i < visibleDates.length; i++) {
    const date = visibleDates[i]!
    const daySummary = dailySummary[date]
    const dayData = dailyData[date]
    if (!daySummary || !dayData) continue

    // 找出当天 top model 和 project
    let topModel: { id: string; cost: number } = { id: '-', cost: 0 }
    let topProject: { name: string; cost: number } = { name: '-', cost: 0 }

    for (const [project, models] of Object.entries(dayData)) {
      let projectCost = 0
      for (const [model, stats] of Object.entries(models)) {
        const modelStats = stats as any
        projectCost += Number(modelStats.cost ?? 0)
        if (Number(modelStats.cost ?? 0) > topModel.cost) {
          topModel = { id: model, cost: Number(modelStats.cost ?? 0) }
        }
      }
      if (projectCost > topProject.cost) {
        topProject = { name: project, cost: projectCost }
      }
    }

    const shortProject = resolveProjectName(topProject.name, data.workspaceMappings)

    const isSelected = scrollOffset + i === selectedIndex
    const rowContent =
      date.padEnd(dateCol) +
      formatCost(daySummary.cost).padStart(costCol) +
      formatTokens(daySummary.tokens).padStart(tokensCol) +
      formatNumber(daySummary.requests).padStart(reqCol) +
      truncate(topModel.id, modelCol - 1).padStart(modelCol) +
      truncate(shortProject, projectCol - 1).padStart(projectCol)

    if (isSelected) {
      content += `{black-fg}{green-bg}${rowContent}{/green-bg}{/black-fg}\n`
    } else {
      content += rowContent + '\n'
    }
  }

  if (sortedDates.length > safePageSize) {
    content += `\n{gray-fg}Showing ${scrollOffset + 1}-${Math.min(scrollOffset + safePageSize, sortedDates.length)} of ${sortedDates.length} days (↑↓ scroll, Enter detail){/gray-fg}`
  } else {
    content += `\n{gray-fg}(↑↓ select, Enter detail){/gray-fg}`
  }

  if (note) {
    content += `\n\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 渲染 Daily Detail 视图（某一天的详细数据，按 project 分组显示所有 model 用量）
function renderDailyDetail(
  box: any,
  data: AnalysisData,
  date: string,
  scrollOffset = 0,
  width: number,
  pageSize: number,
): void {
  const { dailySummary, dailyData } = data
  const daySummary = dailySummary[date]
  const dayData = dailyData[date]

  if (!daySummary || !dayData) {
    box.setContent(`{bold}${date}{/bold}\n\nNo data available for this date.`)
    return
  }

  // 按 project 分组，每个 project 下按 cost 排序 models
  type ProjectDetail = {
    name: string
    shortName: string
    totalCost: number
    totalTokens: number
    totalRequests: number
    models: Array<{ id: string; cost: number; tokens: number; requests: number }>
  }

  const projectDetails: ProjectDetail[] = []

  for (const [projectName, models] of Object.entries(dayData)) {
    const shortName = resolveProjectName(projectName, data.workspaceMappings)
    const modelList: ProjectDetail['models'] = []
    let totalCost = 0
    let totalTokens = 0
    let totalRequests = 0

    for (const [modelId, stats] of Object.entries(models)) {
      const s = stats as any
      const cost = Number(s.cost ?? 0)
      const tokens = Number(s.totalTokens ?? 0)
      const requests = Number(s.requests ?? 0)
      modelList.push({ id: modelId, cost, tokens, requests })
      totalCost += cost
      totalTokens += tokens
      totalRequests += requests
    }

    // 按 cost 降序排序 models
    modelList.sort((a, b) => b.cost - a.cost)

    projectDetails.push({
      name: projectName,
      shortName,
      totalCost,
      totalTokens,
      totalRequests,
      models: modelList,
    })
  }

  // 按 project 总 cost 降序排序
  projectDetails.sort((a, b) => b.totalCost - a.totalCost)

  // 构建显示行（每行可以是 project 标题或 model 明细）
  type DisplayLine = { type: 'project'; project: ProjectDetail } | { type: 'model'; model: ProjectDetail['models'][0] }
  const displayLines: DisplayLine[] = []

  for (const project of projectDetails) {
    displayLines.push({ type: 'project', project })
    for (const model of project.models) {
      displayLines.push({ type: 'model', model })
    }
  }

  // 根据宽度计算列宽
  const availableWidth = width - 6 // padding
  const fixedCols = 12 + 12 + 12 // Cost + Requests + Tokens
  const nameCol = Math.max(25, availableWidth - fixedCols)
  const totalWidth = nameCol + fixedCols

  let content = `{bold}${date} - Project & Model Usage Details{/bold}\n\n`

  // 当天汇总
  content += `{green-fg}Total cost:{/green-fg}     ${formatCost(daySummary.cost)}    `
  content += `{green-fg}Tokens:{/green-fg} ${formatTokens(daySummary.tokens)}    `
  content += `{green-fg}Requests:{/green-fg} ${formatNumber(daySummary.requests)}    `
  content += `{green-fg}Projects:{/green-fg} ${projectDetails.length}\n\n`

  content +=
    '{underline}' +
    'Project / Model'.padEnd(nameCol) +
    '~Cost'.padStart(12) +
    'Requests'.padStart(12) +
    'Tokens'.padStart(12) +
    '{/underline}\n'

  const safePageSize = Math.max(1, Math.floor(pageSize || 1))
  const visibleLines = displayLines.slice(scrollOffset, scrollOffset + safePageSize)

  for (const line of visibleLines) {
    if (line.type === 'project') {
      const p = line.project
      content +=
        '{cyan-fg}' +
        truncate(p.shortName, nameCol - 1).padEnd(nameCol) +
        formatCost(p.totalCost).padStart(12) +
        formatNumber(p.totalRequests).padStart(12) +
        formatTokens(p.totalTokens).padStart(12) +
        '{/cyan-fg}\n'
    } else {
      const m = line.model
      content +=
        ('  ' + truncate(m.id, nameCol - 3)).padEnd(nameCol) +
        formatCost(m.cost).padStart(12) +
        formatNumber(m.requests).padStart(12) +
        formatTokens(m.tokens).padStart(12) +
        '\n'
    }
  }

  content += '─'.repeat(totalWidth) + '\n'
  content +=
    '{bold}' +
    `Total (${projectDetails.length} projects)`.padEnd(nameCol) +
    formatCost(daySummary.cost).padStart(12) +
    formatNumber(daySummary.requests).padStart(12) +
    formatTokens(daySummary.tokens).padStart(12) +
    '{/bold}\n'

  if (displayLines.length > safePageSize) {
    content += `\n{gray-fg}Showing ${scrollOffset + 1}-${Math.min(scrollOffset + safePageSize, displayLines.length)} of ${displayLines.length} rows (↑↓ scroll, Esc back){/gray-fg}`
  } else {
    content += `\n{gray-fg}(Esc back to Daily list){/gray-fg}`
  }

  box.setContent(content)
}

// 纯文本输出模式
function printTextReport(data: AnalysisData): void {
  const { modelTotals, projectTotals, grandTotal, topModel, topProject, cacheHitRate, activeDays } = data

  console.log('\n🤖 CodeBuddy Stats Report')
  console.log('='.repeat(50))

  console.log(`\nTotal cost:        ${formatCost(grandTotal.cost)}`)
  console.log(`Total tokens:      ${formatTokens(grandTotal.tokens)}`)
  console.log(`Total requests:    ${formatNumber(grandTotal.requests)}`)
  console.log(`Active days:       ${activeDays}`)
  console.log(`Cache hit rate:    ${formatPercent(cacheHitRate)}`)

  if (topModel) {
    console.log(`\nTop model:         ${topModel.id} (${formatCost(topModel.cost)})`)
  }
  if (topProject) {
    const shortName = resolveProjectName(topProject.name, data.workspaceMappings)
    console.log(`Top project:       ${shortName}`)
    console.log(`                   (${formatCost(topProject.cost)})`)
  }

  console.log('\n' + '-'.repeat(50))
  console.log('By Model:')
  for (const [model, stats] of Object.entries(modelTotals).sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`  ${model}: ${formatCost(stats.cost)} (${formatNumber(stats.requests)} req)`) // eslint-disable-line no-console
  }

  console.log('\n' + '-'.repeat(50))
  console.log('By Project:')
  for (const [project, stats] of Object.entries(projectTotals)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 10)) {
    const shortName = resolveProjectName(project, data.workspaceMappings)
    console.log(`  ${truncate(shortName, 40)}: ${formatCost(stats.cost)}`) // eslint-disable-line no-console
  }

  console.log('\n' + '='.repeat(50) + '\n')
}

// 主程序
async function main(): Promise<void> {
  const options = parseArgs()

  console.log('Loading data...')
  let currentSource: 'code' | 'ide' = 'code'
  let data = await loadUsageData({ days: options.days, source: currentSource })

  if (options.noTui) {
    printTextReport(data)
    return
  }

  // 创建 TUI
  const screen = blessed.screen({
    smartCSR: true,
    title: 'CodeBuddy Stats',
    forceUnicode: true,
    fullUnicode: true,
  })

  // Tab 状态
  const tabs = ['Overview', 'By Model', 'By Project', 'Daily']
  let currentTab = 0

  let modelScrollOffset = 0
  let projectScrollOffset = 0
  let dailyScrollOffset = 0
  let dailySelectedIndex = 0
  let dailyDetailDate: string | null = null // 当前查看详情的日期，null 表示在列表视图
  let dailyDetailScrollOffset = 0

  let modelPageSize = 10
  let projectPageSize = 10
  let dailyPageSize = 20
  let dailyDetailPageSize = 10

  // Tab 栏
  const tabBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  })

  // 内容区域
  const contentBox = blessed.box({
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-5',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
    padding: {
      left: 2,
      right: 2,
      top: 1,
    },
  })

  // 底部状态栏
  const statusBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: {
      fg: 'black',
      bg: 'green',
    },
  })

  screen.append(tabBar)
  screen.append(contentBox)
  screen.append(statusBar)

  // 更新 Tab 栏
  function updateTabBar(): void {
    let content = ' CodeBuddy Stats  '

    content += '{gray-fg}Source:{/gray-fg} '
    if (currentSource === 'code') {
      content += '{black-fg}{green-bg} Code {/green-bg}{/black-fg} '
      content += '{gray-fg}IDE{/gray-fg}  '
    } else {
      content += '{gray-fg}Code{/gray-fg} '
      content += '{black-fg}{green-bg} IDE {/green-bg}{/black-fg}  '
    }

    content += '{gray-fg}Views:{/gray-fg} '

    for (let i = 0; i < tabs.length; i++) {
      if (i === currentTab) {
        content += `{black-fg}{green-bg} ${tabs[i]} {/green-bg}{/black-fg} `
      } else {
        content += `{gray-fg}${tabs[i]}{/gray-fg} `
      }
    }
    content += ' {gray-fg}(Tab view, s source){/gray-fg}'
    tabBar.setContent(content)
  }

  // 更新内容
  function updateContent(): void {
    const width = Number(screen.width) || 80

    const note =
      currentSource === 'code'
        ? `针对 CodeBuddy Code < 2.20.0 版本产生的数据，由于没有请求级别的 model ID，用量是基于当前 CodeBuddy Code 设置的 model ID（${data.defaultModelId}）计算价格的`
        : 'IDE 的 usage 不包含缓存命中/写入 tokens，无法计算缓存相关价格与命中率；成本按 input/output tokens 估算'

    const screenHeight = Number(screen.height) || 24
    const contentBoxHeight = Math.max(1, screenHeight - 5) // 对应 contentBox: height = '100%-5'
    const paddingTop = Number((contentBox as any).padding?.top ?? 0)
    const paddingBottom = Number((contentBox as any).padding?.bottom ?? 0)
    const innerHeight = Math.max(1, contentBoxHeight - paddingTop - paddingBottom)

    // 根据当前可用高度动态调整每页行数（By Model / By Project / Daily），避免 resize 后内容溢出
    const baseLines = 3 // title + blank + header
    const hintLines = 2 // blank + hint line（最坏情况）
    const availableTextWidth = Math.max(20, width - 8)
    const estimatedNoteLines = note ? Math.max(1, Math.ceil(`备注：${note}`.length / availableTextWidth)) : 0
    const noteLines = note ? 2 + estimatedNoteLines : 0 // 两行空行 + 备注文本

    // By Model / By Project：表格尾部还有 total 两行
    const listReservedLines = baseLines + 2 + hintLines + noteLines + 1 // separator + total + safety
    modelPageSize = Math.max(1, innerHeight - listReservedLines)
    projectPageSize = Math.max(1, innerHeight - listReservedLines)

    // Daily：无 total 行
    const dailyReservedLines = baseLines + hintLines + noteLines + 1 // safety
    dailyPageSize = Math.max(1, innerHeight - dailyReservedLines)

    // Daily Detail：有 summary + total 行
    const dailyDetailReservedLines = baseLines + 3 + 2 + hintLines + 1 // summary(3) + separator + total + safety
    dailyDetailPageSize = Math.max(1, innerHeight - dailyDetailReservedLines)

    const modelMaxOffset = Math.max(0, Object.keys(data.modelTotals).length - modelPageSize)
    modelScrollOffset = Math.min(modelScrollOffset, modelMaxOffset)

    const projectMaxOffset = Math.max(0, Object.keys(data.projectTotals).length - projectPageSize)
    projectScrollOffset = Math.min(projectScrollOffset, projectMaxOffset)

    const dailyMaxOffset = Math.max(0, Object.keys(data.dailySummary).length - dailyPageSize)
    dailyScrollOffset = Math.min(dailyScrollOffset, dailyMaxOffset)
    dailySelectedIndex = Math.min(dailySelectedIndex, Math.max(0, Object.keys(data.dailySummary).length - 1))

    switch (currentTab) {
      case 0:
        renderOverview(contentBox, data, width, innerHeight, note)
        break
      case 1:
        renderByModel(contentBox, data, modelScrollOffset, width, note, modelPageSize)
        break
      case 2:
        renderByProject(contentBox, data, projectScrollOffset, width, note, projectPageSize)
        break
      case 3:
        if (dailyDetailDate) {
          renderDailyDetail(contentBox, data, dailyDetailDate, dailyDetailScrollOffset, width, dailyDetailPageSize)
        } else {
          renderDaily(contentBox, data, dailyScrollOffset, dailySelectedIndex, width, note, dailyPageSize)
        }
        break
    }
  }

  // 更新状态栏
  function updateStatusBar(): void {
    const daysInfo = options.days ? `Last ${options.days} days` : 'All time'
    const sourceInfo = currentSource === 'code' ? 'Code' : 'IDE'
    const rightContent = `v${VERSION}`
    const width = Number(screen.width) || 80

    // 根据剩余宽度决定左侧内容详细程度（预留版本号空间）
    const reservedForRight = rightContent.length + 2 // 版本号 + 两侧空格
    const availableForLeft = width - reservedForRight

    let leftContent: string
    const fullContent = ` ${daysInfo} | Source: ${sourceInfo} | Total: ${formatCost(data.grandTotal.cost)} | q quit, Tab view, s source, r refresh`
    const mediumContent = ` ${daysInfo} | ${sourceInfo} | ${formatCost(data.grandTotal.cost)} | q/Tab/s/r`
    const shortContent = ` ${sourceInfo} | ${formatCost(data.grandTotal.cost)} | q/Tab/s/r`
    const minContent = ` ${formatCost(data.grandTotal.cost)}`

    if (fullContent.length <= availableForLeft) {
      leftContent = fullContent
    } else if (mediumContent.length <= availableForLeft) {
      leftContent = mediumContent
    } else if (shortContent.length <= availableForLeft) {
      leftContent = shortContent
    } else {
      leftContent = minContent
    }

    const padding = Math.max(1, width - leftContent.length - rightContent.length)
    statusBar.setContent(leftContent + ' '.repeat(padding) + rightContent)
  }

  // 键盘事件
  screen.key(['tab'], () => {
    if (dailyDetailDate) return // 在 detail 视图时禁用 tab 切换
    currentTab = (currentTab + 1) % tabs.length
    modelScrollOffset = 0
    projectScrollOffset = 0
    dailyScrollOffset = 0
    dailySelectedIndex = 0
    contentBox.scrollTo(0)
    updateTabBar()
    updateContent()
    screen.render()
  })

  screen.key(['S-tab'], () => {
    if (dailyDetailDate) return // 在 detail 视图时禁用 tab 切换
    currentTab = (currentTab - 1 + tabs.length) % tabs.length
    modelScrollOffset = 0
    projectScrollOffset = 0
    dailyScrollOffset = 0
    dailySelectedIndex = 0
    contentBox.scrollTo(0)
    updateTabBar()
    updateContent()
    screen.render()
  })

  screen.key(['up', 'k'], () => {
    if (currentTab === 1) {
      modelScrollOffset = Math.max(0, modelScrollOffset - 1)
      updateContent()
      screen.render()
      return
    }
    if (currentTab === 2) {
      projectScrollOffset = Math.max(0, projectScrollOffset - 1)
      updateContent()
      screen.render()
      return
    }
    if (currentTab === 3) {
      if (dailyDetailDate) {
        // 在 detail 视图中滚动
        dailyDetailScrollOffset = Math.max(0, dailyDetailScrollOffset - 1)
      } else {
        // 在列表视图中移动选中项
        if (dailySelectedIndex > 0) {
          dailySelectedIndex--
          // 如果选中项在当前页之上，滚动页面
          if (dailySelectedIndex < dailyScrollOffset) {
            dailyScrollOffset = dailySelectedIndex
          }
        }
      }
      updateContent()
      screen.render()
      return
    }

    contentBox.scroll(-1)
    screen.render()
  })

  screen.key(['down', 'j'], () => {
    if (currentTab === 1) {
      const maxOffset = Math.max(0, Object.keys(data.modelTotals).length - modelPageSize)
      modelScrollOffset = Math.min(maxOffset, modelScrollOffset + 1)
      updateContent()
      screen.render()
      return
    }
    if (currentTab === 2) {
      const maxOffset = Math.max(0, Object.keys(data.projectTotals).length - projectPageSize)
      projectScrollOffset = Math.min(maxOffset, projectScrollOffset + 1)
      updateContent()
      screen.render()
      return
    }
    if (currentTab === 3) {
      if (dailyDetailDate) {
        // 在 detail 视图中滚动（计算总行数：project 数 + 每个 project 下的 model 数）
        const dayData = data.dailyData[dailyDetailDate]
        if (dayData) {
          let totalLines = 0
          for (const models of Object.values(dayData)) {
            totalLines += 1 + Object.keys(models).length // 1 for project header + model count
          }
          const maxOffset = Math.max(0, totalLines - dailyDetailPageSize)
          dailyDetailScrollOffset = Math.min(maxOffset, dailyDetailScrollOffset + 1)
        }
      } else {
        // 在列表视图中移动选中项
        const totalDays = Object.keys(data.dailySummary).length
        if (dailySelectedIndex < totalDays - 1) {
          dailySelectedIndex++
          // 如果选中项超出当前页，滚动页面
          if (dailySelectedIndex >= dailyScrollOffset + dailyPageSize) {
            dailyScrollOffset = dailySelectedIndex - dailyPageSize + 1
          }
        }
      }
      updateContent()
      screen.render()
      return
    }

    contentBox.scroll(1)
    screen.render()
  })

  screen.key(['enter'], () => {
    if (currentTab === 3 && !dailyDetailDate) {
      // 进入 detail 视图
      const sortedDates = Object.keys(data.dailySummary).sort().reverse()
      if (sortedDates[dailySelectedIndex]) {
        dailyDetailDate = sortedDates[dailySelectedIndex]!
        dailyDetailScrollOffset = 0
        updateContent()
        screen.render()
      }
    }
  })

  screen.key(['escape', 'backspace'], () => {
    if (currentTab === 3 && dailyDetailDate) {
      // 返回列表视图
      dailyDetailDate = null
      dailyDetailScrollOffset = 0
      updateContent()
      screen.render()
    }
  })

  screen.key(['q', 'C-c'], () => {
    screen.destroy()
    process.exit(0)
  })

  screen.key(['r'], async () => {
    statusBar.setContent(' {yellow-fg}Reloading...{/yellow-fg}')
    screen.render()
    try {
      const prevDetailDate = dailyDetailDate
      data = await loadUsageData({ days: options.days, source: currentSource })
      modelScrollOffset = 0
      projectScrollOffset = 0
      dailyScrollOffset = 0
      dailySelectedIndex = 0
      dailyDetailScrollOffset = 0
      // 如果之前在详情视图且该日期仍存在，保持在详情视图
      if (prevDetailDate && data.dailySummary[prevDetailDate]) {
        dailyDetailDate = prevDetailDate
      } else {
        dailyDetailDate = null
      }
      contentBox.scrollTo(0)
      updateTabBar()
      updateContent()
      updateStatusBar()
    } catch (err) {
      statusBar.setContent(` {red-fg}Reload failed: ${String(err)}{/red-fg}`)
    }
    screen.render()
  })

  screen.key(['s'], async () => {
    statusBar.setContent(' {yellow-fg}Switching source...{/yellow-fg}')
    screen.render()
    try {
      currentSource = currentSource === 'code' ? 'ide' : 'code'
      data = await loadUsageData({ days: options.days, source: currentSource })
      modelScrollOffset = 0
      projectScrollOffset = 0
      dailyScrollOffset = 0
      dailySelectedIndex = 0
      dailyDetailDate = null
      dailyDetailScrollOffset = 0
      contentBox.scrollTo(0)
      updateTabBar()
      updateContent()
      updateStatusBar()
    } catch (err) {
      statusBar.setContent(` {red-fg}Switch source failed: ${String(err)}{/red-fg}`)
    }
    screen.render()
  })

  // 监听窗口大小变化
  screen.on('resize', () => {
    updateTabBar()
    updateContent()
    updateStatusBar()
    screen.render()
  })

  // 初始渲染
  updateTabBar()
  updateContent()
  updateStatusBar()
  screen.render()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
