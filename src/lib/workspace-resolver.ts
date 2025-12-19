import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { getWorkspaceStorageDir } from './paths.js'

export interface WorkspaceMapping {
  hash: string
  folderUri: string
  displayPath: string
}

/**
 * 从 folder URI 提取纯路径（用于计算 MD5）
 */
function extractPathFromUri(folderUri: string): string | null {
  // 处理本地文件路径: file:///path/to/folder
  if (folderUri.startsWith('file://')) {
    try {
      const url = new URL(folderUri)
      return decodeURIComponent(url.pathname)
    } catch {
      return decodeURIComponent(folderUri.replace('file://', ''))
    }
  }

  // 处理远程路径: vscode-remote://codebuddy-remote-ssh%2B.../path
  if (folderUri.startsWith('vscode-remote://')) {
    try {
      const url = new URL(folderUri)
      return decodeURIComponent(url.pathname)
    } catch {
      const match = folderUri.match(/vscode-remote:\/\/[^/]+(.+)$/)
      if (match?.[1]) {
        return decodeURIComponent(match[1])
      }
    }
  }

  return null
}

/**
 * 从 folder URI 生成用于显示的友好路径
 */
function getDisplayPath(folderUri: string): string {
  // 本地路径
  if (folderUri.startsWith('file://')) {
    const p = extractPathFromUri(folderUri)
    if (p) {
      const home = os.homedir()
      if (p.startsWith(home)) {
        return '~' + p.slice(home.length)
      }
      return p
    }
  }

  // 远程路径
  if (folderUri.startsWith('vscode-remote://')) {
    const p = extractPathFromUri(folderUri)
    if (p) {
      const hostMatch = folderUri.match(/vscode-remote:\/\/codebuddy-remote-ssh%2B([^/]+)/)
      if (hostMatch?.[1]) {
        let host = decodeURIComponent(hostMatch[1])
        host = host.replace(/_x([0-9a-fA-F]{2})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        host = host.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        if (host.includes('@')) {
          const parts = host.split('@')
          host = parts[parts.length - 1]?.split(':')[0] || host
        }
        if (host.length > 20) {
          host = host.slice(0, 17) + '...'
        }
        return `[${host}]${p}`
      }
      return `[remote]${p}`
    }
  }

  return folderUri
}

/**
 * 计算路径的 MD5 hash（CodeBuddyExtension 使用纯路径计算）
 */
function computePathHash(p: string): string {
  return crypto.createHash('md5').update(p).digest('hex')
}

/**
 * 加载所有工作区映射
 */
export async function loadWorkspaceMappings(): Promise<Map<string, WorkspaceMapping>> {
  const mappings = new Map<string, WorkspaceMapping>()
  const storageDir = getWorkspaceStorageDir()

  let entries: fsSync.Dirent[] = []
  try {
    entries = await fs.readdir(storageDir, { withFileTypes: true })
  } catch {
    return mappings
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const workspaceJsonPath = path.join(storageDir, entry.name, 'workspace.json')
    try {
      const content = await fs.readFile(workspaceJsonPath, 'utf8')
      const data = JSON.parse(content) as { folder?: string }
      const folderUri = data.folder
      if (!folderUri) continue

      const extractedPath = extractPathFromUri(folderUri)
      if (!extractedPath) continue

      const hash = computePathHash(extractedPath)
      const displayPath = getDisplayPath(folderUri)

      mappings.set(hash, { hash, folderUri, displayPath })
    } catch {
      // 跳过无法读取的文件
    }
  }

  return mappings
}

/**
 * 解析项目名称，如果是 MD5 hash 则尝试从映射中获取可读路径
 */
export function resolveProjectName(name: string, mappings?: Map<string, WorkspaceMapping>): string {
  if (mappings && /^[a-f0-9]{32}$/.test(name)) {
    const mapping = mappings.get(name)
    if (mapping) {
      return mapping.displayPath
    }
  }
  return name
}
