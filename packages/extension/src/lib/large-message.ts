/**
 * 大消息中转模块
 *
 * 解决 chrome.runtime.sendMessage 的 64MiB 消息大小限制。
 * 通过 chrome.storage.local 中转大数据，只在消息中传递轻量引用。
 *
 * 流程：发送方写入 storage → 消息只传 key → 接收方从 storage 读取 → 清理
 */

import { createLogger } from './logger'

const logger = createLogger('LargeMessage')

/** storage key 前缀 */
const STORAGE_KEY_PREFIX = 'syncPayload_'

/**
 * 将大型 payload 存储到 chrome.storage.local
 * @returns storage key，用于在消息中引用
 */
export async function storeLargePayload(syncId: string, payload: Record<string, unknown>): Promise<string> {
  const storageKey = `${STORAGE_KEY_PREFIX}${syncId}`
  try {
    await chrome.storage.local.set({ [storageKey]: payload })
    logger.debug('Stored large payload:', storageKey)
    return storageKey
  } catch (error) {
    logger.error('Failed to store large payload:', error)
    throw error
  }
}

/**
 * 从 chrome.storage.local 读取大型 payload
 * 读取后自动清理 storage 中的数据
 */
export async function retrieveLargePayload<T = Record<string, unknown>>(storageKey: string): Promise<T> {
  try {
    const data = await chrome.storage.local.get(storageKey)
    const payload = data[storageKey]

    if (!payload) {
      throw new Error(`Payload not found for key: ${storageKey}`)
    }

    // 读取后立即清理，避免 storage 膨胀
    await chrome.storage.local.remove(storageKey).catch(() => {})
    logger.debug('Retrieved and cleaned payload:', storageKey)

    return payload as T
  } catch (error) {
    logger.error('Failed to retrieve large payload:', error)
    throw error
  }
}

/**
 * 清理可能残留的 syncPayload 数据（防止异常退出留下垃圾数据）
 * 建议在 background 启动时调用
 */
export async function cleanupStalePayloads(): Promise<void> {
  try {
    const allData = await chrome.storage.local.get(null)
    const staleKeys = Object.keys(allData).filter(key => key.startsWith(STORAGE_KEY_PREFIX))

    if (staleKeys.length > 0) {
      await chrome.storage.local.remove(staleKeys)
      logger.info(`Cleaned up ${staleKeys.length} stale payloads`)
    }
  } catch (error) {
    logger.error('Failed to cleanup stale payloads:', error)
  }
}
