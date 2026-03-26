import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Plus, Clock, X, Download, FileUp, Loader2 } from 'lucide-react'
import { useSyncStore } from '../stores/sync'
import { SettingsDrawer } from '../components/SettingsDrawer'
import { SyncDialog } from '@/components/sync-dialog'
import type { Platform as DialogPlatform } from '@/components/sync-dialog'
import { cn } from '@/lib/utils'
import { trackPageView, trackFeatureDiscovery } from '../../lib/analytics'
import { createLogger } from '../../lib/logger'
import { getCachedUpdateInfo, dismissUpdate, type UpdateCheckResult } from '../../lib/version-check'
import { parseDocument, FILE_ACCEPT } from '../../lib/document-importer'

const logger = createLogger('HomeNew')

export function HomeNew() {
  const navigate = useNavigate()
  const {
    status,
    article,
    platforms,
    selectedPlatforms,
    results,
    error,

    platformProgress,
    recovered,
    loadPlatforms,
    loadArticle,
    recoverSyncState,
    togglePlatform,
    selectAll,
    deselectAll,
    startSync,
    retryFailed,
    reset,
    checkRateLimit,
    setArticle,
  } = useSyncStore()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [allPlatforms, setAllPlatforms] = useState<DialogPlatform[]>([])

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [floatingEnabled, setFloatingEnabled] = useState(false)
  const [isFirstSync, setIsFirstSync] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load data
  useEffect(() => {
    const init = async () => {
      await recoverSyncState()
      // Render from cache first, then refresh
      try {
        const cached = await chrome.storage.local.get('platformListCache')
        if (cached.platformListCache?.length) {
          const filtered = cached.platformListCache.filter((p: any) => p.id !== 'zip-download')
          setAllPlatforms(filtered.map((p: any) => ({
            id: p.id, name: p.name, icon: p.icon,
            isAuthenticated: p.isAuthenticated, username: p.username,
            homepage: p.homepage,
          })))
        }
      } catch {}
      loadAllPlatforms()
      loadArticle()
      chrome.storage.local.get(['floatingButtonEnabled', 'syncHistory'], (r) => {
        setFloatingEnabled(r.floatingButtonEnabled ?? false)
        setIsFirstSync(!r.syncHistory || r.syncHistory.length === 0)
      })
      const cached = await getCachedUpdateInfo()
      if (cached?.hasUpdate && cached.info) {
        setUpdateInfo(cached)
      }
    }
    init()
    trackPageView('home').catch(() => {})
  }, [])

  const loadAllPlatforms = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh: false } })
      const mapped: DialogPlatform[] = (response.platforms || [])
        .filter((p: any) => p.id !== 'zip-download')
        .map((p: any) => ({
          id: p.id, name: p.name, icon: p.icon,
          isAuthenticated: p.isAuthenticated, username: p.username,
          homepage: p.homepage,
        }))
      setAllPlatforms(mapped)
      await loadPlatforms()
    } catch (error) {
      logger.error('Failed to load platforms:', error)
    }
  }

  // Open editor
  const handleEditArticle = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'OPEN_EDITOR',
        platforms: allPlatforms,
        selectedPlatforms,
      })
      window.close()
    }
  }

  // 处理文件导入
  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    try {
      const parsed = await parseDocument(file)

      const importedArticle = {
        title: parsed.title,
        content: parsed.content,
        html: parsed.content,
        markdown: parsed.markdown || parsed.content,
        summary: parsed.content.replace(/<[^>]+>/g, '').slice(0, 100),
      }

      // 并行执行：保存文章到 storage 和获取平台列表
      const [storageResponse] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh: false } }),
        chrome.storage.local.set({ pendingArticle: importedArticle }),
      ])

      const platforms = (storageResponse?.platforms || []).filter((p: any) => p.id !== 'zip-download')

      // 保存平台信息到 storage
      await chrome.storage.local.set({ editorPlatforms: platforms })

      logger.info('Document imported, opening editor in new tab')

      // 打开新标签页显示编辑器
      const editorUrl = chrome.runtime.getURL('src/editor/index.html')
      await chrome.tabs.create({ url: editorUrl })

      // 关闭 popup
      window.close()
    } catch (error) {
      logger.error('Failed to import document:', error)
      setRateLimitWarning(`导入失败: ${error instanceof Error ? error.message : '未知错误'}`)
      setTimeout(() => setRateLimitWarning(null), 5000)
    } finally {
      setIsImporting(false)
      // 清空 input 以便再次选择相同文件
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  // 打开文件选择器
  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  // Start sync with rate-limit check
  const handleStartSync = async () => {
    const warning = await checkRateLimit()
    if (warning) {
      setRateLimitWarning(warning)
      setTimeout(() => setRateLimitWarning(null), 8000)
    }
    startSync()
  }

  const successCount = results.filter(r => r.success).length

  return (
    <div className="flex flex-col h-[500px]">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b">
        <div className="flex items-center gap-2">
          <img src="/assets/icon-48.png" alt="Logo" className="w-6 h-6" />
          <h1 className="font-semibold">文章同步助手</h1>
        </div>
        <nav className="flex items-center gap-0.5">
          <button
            onClick={() => navigate('/add-cms')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">添加</span>
          </button>
          <button
            onClick={() => navigate('/history')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">历史</span>
          </button>

          <button
            onClick={() => {
              setSettingsOpen(true)
              trackFeatureDiscovery('settings', 'header_icon').catch(() => {})
            }}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">设置</span>
          </button>
        </nav>
      </header>

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept={FILE_ACCEPT}
        onChange={handleFileImport}
        className="hidden"
      />

      {/* Version update banner */}
      {updateInfo?.hasUpdate && updateInfo.info && (
        <div className="px-4 pt-3">
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 text-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <Download className="w-4 h-4" />
                <span>新版本 v{updateInfo.info.version} 可用</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={updateInfo.info.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  下载
                </a>
                <button
                  onClick={async () => {
                    if (updateInfo.info) {
                      await dismissUpdate(updateInfo.info.version)
                      chrome.runtime.sendMessage({ type: 'CLEAR_UPDATE_BADGE' }).catch(() => {})
                      setUpdateInfo(null)
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  title="忽略此版本"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {updateInfo.info.releaseNotes && (
              <p className="text-xs text-muted-foreground mt-1">{updateInfo.info.releaseNotes}</p>
            )}
          </div>
        </div>
      )}

      {/* Share / welcome banner (first time only) */}


      {/* 导入文档按钮 */}
      <div className="px-4 pt-3">
        <button
          onClick={handleImportClick}
          disabled={isImporting || status === 'syncing'}
          className={cn(
            'w-full py-2 px-3 rounded-lg border border-dashed border-gray-300 dark:border-gray-600',
            'flex items-center justify-center gap-2 text-sm text-gray-600 dark:text-gray-400',
            'hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gray-400 transition-colors',
            (isImporting || status === 'syncing') && 'opacity-50 cursor-not-allowed'
          )}
        >
          {isImporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FileUp className="w-4 h-4" />
          )}
          导入文档 (Word/Markdown)
        </button>
      </div>

      {/* SyncDialog — the unified sync flow */}
      <SyncDialog
        article={article}
        platforms={allPlatforms}
        status={status}
        selectedPlatforms={selectedPlatforms}
        results={results}
        platformProgress={platformProgress}
        error={error}
        onTogglePlatform={togglePlatform}
        onSelectAll={selectAll}
        onDeselectAll={deselectAll}
        onStartSync={handleStartSync}
        onRetryFailed={retryFailed}
        onReset={reset}
        onCancel={reset}
        onEditArticle={handleEditArticle}
        className="flex-1 min-h-0"
      />

      {/* First sync success hint */}
      {status === 'completed' && isFirstSync && successCount > 0 && (
        <div className="px-4 pb-3">
          <div className="bg-green-50 dark:bg-green-950/20 rounded-lg p-2.5 space-y-1.5">
            <p className="text-xs font-medium text-green-700 dark:text-green-400">
              首次同步成功！以后同步更方便：
            </p>
            {!floatingEnabled && (
              <button
                onClick={() => {
                  chrome.storage.local.set({ floatingButtonEnabled: true })
                  setFloatingEnabled(true)
                }}
                className="text-xs text-primary hover:underline block"
              >
                开启悬浮按钮 — 在任意文章页一键同步
              </button>
            )}
            <p className="text-xs text-green-600 dark:text-green-500">
              下次在文章页点击扩展图标即可快速同步
            </p>
          </div>
        </div>
      )}

      {/* Settings drawer */}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Rate limit warning (non-blocking toast) */}
      {rateLimitWarning && (
        <div className="fixed top-2 left-2 right-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="bg-yellow-50 dark:bg-yellow-950/50 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 shadow-lg flex items-start gap-2">
            <span className="text-lg flex-shrink-0">⚠️</span>
            <p className="text-sm text-yellow-800 dark:text-yellow-200 flex-1">{rateLimitWarning}</p>
            <button
              onClick={() => setRateLimitWarning(null)}
              className="text-yellow-600 dark:text-yellow-400 hover:text-yellow-800 dark:hover:text-yellow-200 flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
