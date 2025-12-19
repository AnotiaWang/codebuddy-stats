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
CodeBuddy Cost Analyzer

Usage: cost-analyzer [options]

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

type HeatmapData = {
  dates: string[]
  costs: number[]
  maxCost: number
}

// 生成热力图数据
function generateHeatmapData(dailySummary: AnalysisData['dailySummary']): HeatmapData {
  const sortedDates = Object.keys(dailySummary).sort()
  if (sortedDates.length === 0) return { dates: [], costs: [], maxCost: 0 }

  const costs = sortedDates.map(d => dailySummary[d]?.cost ?? 0)
  const maxCost = Math.max(...costs)

  return {
    dates: sortedDates,
    costs,
    maxCost,
  }
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
function renderOverview(box: any, data: AnalysisData, width: number, note: string): void {
  const { dailySummary, grandTotal, topModel, topProject, cacheHitRate, activeDays } = data
  const heatmap = generateHeatmapData(dailySummary)

  // 根据宽度计算热力图周数
  const availableWidth = width - 10
  const maxWeeks = Math.min(Math.floor(availableWidth / 2), 26) // 最多 26 周 (半年)

  let content = '{bold}Cost Heatmap{/bold}\n\n'

  // 生成正确的日期网格 - 从今天往前推算
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]!

  // 找到最近的周六作为结束点（或今天）
  const endDate = new Date(today)

  // 往前推 maxWeeks 周
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - maxWeeks * 7 + 1)
  // 调整到周日开始
  startDate.setDate(startDate.getDate() - startDate.getDay())

  // 构建周数组，每周从周日到周六
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

  const maxCost = heatmap.maxCost || 1
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
    content += row + '\n'
  }

  content += '    Less {gray-fg}·░▒▓{/gray-fg}{white-fg}█{/white-fg} More\n\n'

  // 汇总指标 - 根据宽度决定布局
  const avgDailyCost = activeDays > 0 ? grandTotal.cost / activeDays : 0
  const summaryWidth = Math.min(width - 6, 70)

  content += '{bold}Summary{/bold}\n'
  content += '─'.repeat(summaryWidth) + '\n'

  if (width >= 80) {
    // 双列布局
    content += `{green-fg}Total cost:{/green-fg}       ${formatCost(grandTotal.cost).padStart(12)}    `
    content += `{green-fg}Active days:{/green-fg}      ${String(activeDays).padStart(8)}\n`
    content += `{green-fg}Total tokens:{/green-fg}     ${formatTokens(grandTotal.tokens).padStart(12)}    `
    content += `{green-fg}Total requests:{/green-fg}   ${formatNumber(grandTotal.requests).padStart(8)}\n`
    content += `{green-fg}Cache hit rate:{/green-fg}   ${formatPercent(cacheHitRate).padStart(12)}    `
    content += `{green-fg}Avg daily cost:{/green-fg}   ${formatCost(avgDailyCost).padStart(8)}\n\n`
  } else {
    // 单列布局
    content += `{green-fg}Total cost:{/green-fg}       ${formatCost(grandTotal.cost)}\n`
    content += `{green-fg}Total tokens:{/green-fg}     ${formatTokens(grandTotal.tokens)}\n`
    content += `{green-fg}Total requests:{/green-fg}   ${formatNumber(grandTotal.requests)}\n`
    content += `{green-fg}Active days:{/green-fg}      ${activeDays}\n`
    content += `{green-fg}Cache hit rate:{/green-fg}   ${formatPercent(cacheHitRate)}\n`
    content += `{green-fg}Avg daily cost:{/green-fg}   ${formatCost(avgDailyCost)}\n\n`
  }

  if (topModel) {
    content += `{cyan-fg}Top model:{/cyan-fg}        ${topModel.id} (${formatCost(topModel.cost)})\n`
  }
  if (topProject) {
    const projectMaxLen = width >= 100 ? 60 : 35
    const shortName = resolveProjectName(topProject.name, data.workspaceMappings)
    content += `{cyan-fg}Top project:{/cyan-fg}      ${truncate(shortName, projectMaxLen)} (${formatCost(topProject.cost)})\n`
  }

  if (note) {
    content += `\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 渲染 By Model 视图
function renderByModel(box: any, data: AnalysisData, width: number, note: string): void {
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
    'Cost'.padStart(12) +
    'Requests'.padStart(12) +
    'Tokens'.padStart(12) +
    'Avg/Req'.padStart(10) +
    '{/underline}\n'

  for (const [modelId, stats] of sorted) {
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

  if (note) {
    content += `\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 渲染 By Project 视图
function renderByProject(box: any, data: AnalysisData, width: number, note: string): void {
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
    'Cost'.padStart(12) +
    'Requests'.padStart(12) +
    'Tokens'.padStart(12) +
    '{/underline}\n'

  for (const [projectName, stats] of sorted) {
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

  if (note) {
    content += `\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 渲染 Daily 视图
function renderDaily(box: any, data: AnalysisData, scrollOffset = 0, width: number, note: string): void {
  const { dailySummary, dailyData } = data
  const sortedDates = Object.keys(dailySummary).sort().reverse()

  // 根据宽度计算列宽
  const availableWidth = width - 6 // padding
  const dateCol = 12
  const costCol = 12
  const reqCol = 10
  const fixedCols = dateCol + costCol + reqCol
  const remainingWidth = availableWidth - fixedCols
  const modelCol = Math.max(15, Math.min(25, Math.floor(remainingWidth * 0.4)))
  const projectCol = Math.max(20, remainingWidth - modelCol)

  let content = '{bold}Daily Cost Details{/bold}\n\n'
  content +=
    '{underline}' +
    'Date'.padEnd(dateCol) +
    'Cost'.padStart(costCol) +
    'Requests'.padStart(reqCol) +
    'Top Model'.padStart(modelCol) +
    'Top Project'.padStart(projectCol) +
    '{/underline}\n'

  const visibleDates = sortedDates.slice(scrollOffset, scrollOffset + 20)

  for (const date of visibleDates) {
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

    content +=
      date.padEnd(dateCol) +
      formatCost(daySummary.cost).padStart(costCol) +
      formatNumber(daySummary.requests).padStart(reqCol) +
      truncate(topModel.id, modelCol - 1).padStart(modelCol) +
      truncate(shortProject, projectCol - 1).padStart(projectCol) +
      '\n'
  }

  if (sortedDates.length > 20) {
    content += `\n{gray-fg}Showing ${scrollOffset + 1}-${Math.min(scrollOffset + 20, sortedDates.length)} of ${sortedDates.length} days (↑↓ to scroll){/gray-fg}`
  }

  if (note) {
    content += `\n\n{gray-fg}备注：${note}{/gray-fg}\n`
  }

  box.setContent(content)
}

// 纯文本输出模式
function printTextReport(data: AnalysisData): void {
  const { modelTotals, projectTotals, grandTotal, topModel, topProject, cacheHitRate, activeDays } = data

  console.log('\n🤖 CodeBuddy Cost Analysis Report')
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
    console.log(`Top project:       ${topProject.name}`)
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
    title: 'CodeBuddy Cost Analyzer',
    forceUnicode: true,
    fullUnicode: true,
  })

  // Tab 状态
  const tabs = ['Overview', 'By Model', 'By Project', 'Daily']
  let currentTab = 0
  let dailyScrollOffset = 0

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
    let content = ' Cost Analysis  '

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
        ? `针对 CodeBuddy Code ≤ 2.20.0 版本产生的数据，由于没有请求级别的 model ID，用量是基于当前 CodeBuddy Code 设置的 model ID（${data.defaultModelId}）计算价格的`
        : 'IDE 的 usage 不包含缓存命中/写入 tokens，无法计算缓存相关价格与命中率；成本按 input/output tokens 估算'

    switch (currentTab) {
      case 0:
        renderOverview(contentBox, data, width, note)
        break
      case 1:
        renderByModel(contentBox, data, width, note)
        break
      case 2:
        renderByProject(contentBox, data, width, note)
        break
      case 3:
        renderDaily(contentBox, data, dailyScrollOffset, width, note)
        break
    }
  }

  // 更新状态栏
  function updateStatusBar(): void {
    const daysInfo = options.days ? `Last ${options.days} days` : 'All time'
    const sourceInfo = currentSource === 'code' ? 'Code' : 'IDE'
    const leftContent = ` ${daysInfo} | Source: ${sourceInfo} | Total: ${formatCost(data.grandTotal.cost)} | q quit, Tab view, s source, r refresh`
    const rightContent = `v${VERSION} `
    const width = Number(screen.width) || 80
    const padding = Math.max(0, width - leftContent.length - rightContent.length)
    statusBar.setContent(leftContent + ' '.repeat(padding) + rightContent)
  }

  // 键盘事件
  screen.key(['tab'], () => {
    currentTab = (currentTab + 1) % tabs.length
    dailyScrollOffset = 0
    updateTabBar()
    updateContent()
    screen.render()
  })

  screen.key(['S-tab'], () => {
    currentTab = (currentTab - 1 + tabs.length) % tabs.length
    dailyScrollOffset = 0
    updateTabBar()
    updateContent()
    screen.render()
  })

  screen.key(['up', 'k'], () => {
    if (currentTab === 3) {
      dailyScrollOffset = Math.max(0, dailyScrollOffset - 1)
      updateContent()
      screen.render()
    }
  })

  screen.key(['down', 'j'], () => {
    if (currentTab === 3) {
      const maxOffset = Math.max(0, Object.keys(data.dailySummary).length - 20)
      dailyScrollOffset = Math.min(maxOffset, dailyScrollOffset + 1)
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
      data = await loadUsageData({ days: options.days, source: currentSource })
      dailyScrollOffset = 0
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
      dailyScrollOffset = 0
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
    updateContent()
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
