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
 * 获取 CodeBuddy IDE (CodeBuddyExtension) 数据目录
 * - macOS: ~/Library/Application Support/CodeBuddyExtension/Data
 * - Windows: %APPDATA%/CodeBuddyExtension/Data
 * - Linux: $XDG_CONFIG_HOME/CodeBuddyExtension/Data 或 ~/.config/CodeBuddyExtension/Data
 */
export function getIdeDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'CodeBuddyExtension', 'Data')
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdgConfigHome, 'CodeBuddyExtension', 'Data')
}

/**
 * 获取 CodeBuddy IDE 的 workspaceStorage 目录
 */
export function getWorkspaceStorageDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddy CN', 'User', 'workspaceStorage')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'CodeBuddy CN', 'User', 'workspaceStorage')
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'CodeBuddy CN', 'User', 'workspaceStorage')
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
