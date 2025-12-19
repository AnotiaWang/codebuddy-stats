import os from 'node:os'
import path from 'node:path'

/**
 * 获取 CodeBuddy 配置目录
 * - Windows: %APPDATA%/CodeBuddy
 * - macOS: ~/.codebuddy
 * - Linux: $XDG_CONFIG_HOME/codebuddy 或 ~/.codebuddy
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'CodeBuddy')
  }
  if (process.platform === 'linux') {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME
    if (xdgConfigHome) {
      return path.join(xdgConfigHome, 'codebuddy')
    }
  }
  // macOS 和 Linux 默认
  return path.join(os.homedir(), '.codebuddy')
}

/**
 * 获取项目数据目录
 */
export function getProjectsDir(): string {
  return path.join(getConfigDir(), 'projects')
}

/**
 * 获取设置文件路径
 */
export function getSettingsPath(): string {
  return path.join(getConfigDir(), 'settings.json')
}

/**
 * 简化项目路径显示
 * 保持原始名称不变
 */
export function shortenProjectName(name: string): string {
  return name
}
