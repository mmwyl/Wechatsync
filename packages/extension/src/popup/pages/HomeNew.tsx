import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, RefreshCw, FileText, Loader2, Check, X, ExternalLink, ChevronDown, ChevronUp, Plus, Clock, Pencil, Download, FileUp } from 'lucide-react'
import { useSyncStore } from '../stores/sync'
import { PlatformGrid, type Platform as GridPlatform } from '../components/PlatformGrid'
import { SettingsDrawer } from '../components/SettingsDrawer'
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
    imageProgress,
    platformProgress,
    history,
    recovered,
    loadPlatforms,
    loadArticle,
    loadHistory,
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
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [allPlatforms, setAllPlatforms] = useState<GridPlatform[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 加载数据（优先恢复同步状态）
  useEffect(() => {
    const init = async () => {
      // 先尝试恢复同步状态
      await recoverSyncState()
      // 再加载其他数据
      loadAllPlatforms()
      loadArticle()
      loadHistory()
      // 加载版本更新信息
      const cached = await getCachedUpdateInfo()
      if (cached?.hasUpdate && cached.info) {
        setUpdateInfo(cached)
      }
    }
    init()
    // 追踪页面访问
    trackPageView('home').catch(() => {})
  }, [])

  // 加载所有平台（包括未登录的）
  const loadAllPlatforms = async (forceRefresh = false) => {
    if (forceRefresh) {
      setRefreshing(true)
    }
    try {
      // CHECK_ALL_AUTH 现在返回 DSL 和 CMS 合并的列表
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh } })

      const platforms: GridPlatform[] = (response.platforms || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        isAuthenticated: p.isAuthenticated,
        username: p.username,
        error: p.error,
        homepage: p.homepage,
      }))

      setAllPlatforms(platforms)

      // 同时更新 store（用于同步）
      loadPlatforms()
    } catch (error) {
      logger.error('Failed to load platforms:', error)
    } finally {
      setRefreshing(false)
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

      const platforms = storageResponse?.platforms || []

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

  // 选择状态
  const selectedSet = new Set(selectedPlatforms)
  const authenticatedPlatforms = allPlatforms.filter(p => p.isAuthenticated)

  // 切换全选
  const handleSelectAll = () => {
    if (selectedPlatforms.length === authenticatedPlatforms.length) {
      deselectAll()
    } else {
      selectAll()
    }
  }

  // 同步中的平台
  const syncingPlatforms = status === 'syncing'
    ? selectedPlatforms.filter(id => !results.find(r => r.platform === id))
    : []

  // 同步结果映射
  const resultMap = results.reduce((acc, r) => {
    acc[r.platform] = { success: r.success, url: r.postUrl }
    return acc
  }, {} as Record<string, { success: boolean; url?: string }>)

  // 成功/失败统计
  const successCount = results.filter(r => r.success).length
  const failedCount = results.filter(r => !r.success).length

  // 最近历史（最多3条）
  const recentHistory = history.slice(0, 3)

  return (
    <div className="flex flex-col h-[500px]">
      {/* 头部 */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <img src="/assets/icon-48.png" alt="Logo" className="w-6 h-6" />
          <h1 className="font-semibold">同步助手</h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/add-cms')}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
            title="添加站点"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate('/history')}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
            title="同步历史"
          >
            <Clock className="w-4 h-4" />
          </button>
          <button
            onClick={() => loadAllPlatforms(true)}
            disabled={refreshing}
            className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
            title="刷新平台状态"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          </button>
          <button
            onClick={() => {
              setSettingsOpen(true)
              trackFeatureDiscovery('settings', 'header_icon').catch(() => {})
            }}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 主内容 */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 版本更新提示 */}
        {updateInfo?.hasUpdate && updateInfo.info && (
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
                      // 清除扩展图标上的更新 badge
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
        )}

        {/* 导入文档按钮 */}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            onChange={handleFileImport}
            className="hidden"
          />
          <button
            onClick={handleImportClick}
            disabled={isImporting || status === 'syncing'}
            className={cn(
              'flex-1 py-2 px-3 rounded-lg border border-dashed border-gray-300 dark:border-gray-600',
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

        {/* 文章预览 */}
        <div className="bg-muted/50 rounded-lg p-3">
          {article ? (
            <div className="flex gap-3">
              {article.cover && (
                <img
                  src={article.cover}
                  alt=""
                  className="w-16 h-16 rounded object-cover flex-shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <h2 className="font-medium text-sm line-clamp-2">{article.title}</h2>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                  {article.summary || '已检测到文章内容'}
                </p>
              </div>
              <button
                onClick={async () => {
                  // 获取当前标签页
                  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
                  if (tab?.id) {
                    // 发送消息到 content script 打开编辑器
                    chrome.tabs.sendMessage(tab.id, {
                      type: 'OPEN_EDITOR',
                      platforms: allPlatforms,
                      selectedPlatforms: selectedPlatforms, // 传递已选中的平台
                    })
                    // 关闭 popup
                    window.close()
                  }
                }}
                className="flex-shrink-0 p-2 rounded-lg hover:bg-muted transition-colors"
                title="编辑文章"
              >
                <Pencil className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <FileText className="w-5 h-5 mr-2" />
              <span className="text-sm">请在文章页面打开扩展</span>
            </div>
          )}
        </div>

        {/* 平台选择 */}
        <PlatformGrid
          platforms={allPlatforms}
          selected={selectedSet}
          onToggle={togglePlatform}
          onSelectAll={handleSelectAll}
          loading={status === 'loading' && allPlatforms.length === 0}
          syncing={syncingPlatforms}
          results={resultMap}
        />

        {/* 错误提示 */}
        {error && (
          <div className="bg-red-50 dark:bg-red-950/30 rounded-lg p-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* 最近同步 */}
        {recentHistory.length > 0 && status !== 'syncing' && status !== 'completed' && (
          <div className="space-y-2">
            <button
              onClick={() => setHistoryExpanded(!historyExpanded)}
              className="flex items-center justify-between w-full text-sm"
            >
              <span className="text-muted-foreground">最近同步</span>
              {historyExpanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>

            {historyExpanded && (
              <div className="space-y-2">
                {recentHistory.map(item => {
                  const results = item.results || []
                  const success = results.filter(r => r.success).length
                  const total = results.length
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-2 bg-muted/30 rounded-lg"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{item.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(item.startTime ?? item.timestamp ?? Date.now()).toLocaleDateString()}
                        </p>
                      </div>
                      <span className={cn(
                        'text-xs px-2 py-0.5 rounded',
                        success === total ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                      )}>
                        {success}/{total}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* 底部操作栏 */}
      <footer className="flex-shrink-0 border-t bg-background">
        {/* 同步中进度面板 */}
        {status === 'syncing' && (
          <div className="px-4 pt-3 pb-2 bg-blue-50 dark:bg-blue-950/30 border-b space-y-2">
            {/* 进度头部 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                  同步中...
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
                  {results.length}/{selectedPlatforms.length}
                </span>
                <button
                  onClick={reset}
                  className="text-xs px-2 py-1 rounded bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-300 dark:hover:bg-blue-700 transition-colors"
                  title="取消同步"
                >
                  取消
                </button>
              </div>
            </div>

            {/* 总进度条 */}
            <div className="h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${(results.length / selectedPlatforms.length) * 100}%` }}
              />
            </div>

            {/* 各平台详细进度 */}
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {selectedPlatforms.map(platformId => {
                const platform = allPlatforms.find(p => p.id === platformId)
                const progress = platformProgress.get(platformId)
                const result = results.find(r => r.platform === platformId)

                // 已完成的平台
                if (result) {
                  return (
                    <div key={platformId} className="flex items-center gap-2 text-xs">
                      {result.success ? (
                        <Check className="w-3 h-3 text-green-500 flex-shrink-0" />
                      ) : (
                        <X className="w-3 h-3 text-red-500 flex-shrink-0" />
                      )}
                      <span className={cn(
                        'font-medium',
                        result.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
                      )}>
                        {platform?.name || platformId}
                      </span>
                      {result.success ? (
                        <span className="text-green-600 dark:text-green-500">完成</span>
                      ) : (
                        <span className="text-red-600 dark:text-red-500 truncate max-w-[120px]" title={result.error}>
                          {result.error || '失败'}
                        </span>
                      )}
                    </div>
                  )
                }

                // 进行中的平台
                if (progress) {
                  const stageText = {
                    starting: '准备中...',
                    uploading_images: progress.imageProgress
                      ? `上传图片 ${progress.imageProgress.current}/${progress.imageProgress.total}`
                      : '上传图片...',
                    saving: '保存文章...',
                    completed: '完成',
                    failed: progress.error || '失败',
                  }[progress.stage]

                  return (
                    <div key={platformId} className="flex items-center gap-2 text-xs">
                      <Loader2 className="w-3 h-3 animate-spin text-blue-500 flex-shrink-0" />
                      <span className="font-medium text-blue-700 dark:text-blue-300">
                        {platform?.name || platformId}
                      </span>
                      <span className="text-blue-600 dark:text-blue-400">
                        {stageText}
                      </span>
                      {progress.stage === 'uploading_images' && progress.imageProgress && (
                        <div className="flex-1 h-1 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden max-w-[60px]">
                          <div
                            className="h-full bg-blue-400 transition-all"
                            style={{ width: `${(progress.imageProgress.current / progress.imageProgress.total) * 100}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )
                }

                // 等待中的平台
                return (
                  <div key={platformId} className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <div className="w-3 h-3 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0" />
                    <span>{platform?.name || platformId}</span>
                    <span>等待中</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 完成状态面板 */}
        {status === 'completed' && results.length > 0 && (
          <div className="px-4 pt-3 pb-2 bg-muted/50 border-b space-y-2 max-h-40 overflow-y-auto">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">同步完成</span>
              <span className="text-xs text-muted-foreground">
                {successCount} 成功 / {failedCount} 失败
              </span>
            </div>
            <div className="space-y-1">
              {results.map(r => (
                <div key={r.platform} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    {r.success ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <X className="w-4 h-4 text-red-500" />
                    )}
                    {r.platformName || r.platform}
                  </span>
                  {r.success && r.postUrl && (
                    <a
                      href={r.postUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1 text-xs"
                    >
                      查看 <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {!r.success && r.error && (
                    <span className="text-xs text-red-500 truncate max-w-[100px]" title={r.error}>
                      {r.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 按钮区 */}
        <div className="p-4">
          {status === 'completed' ? (
            <div className="flex gap-2">
              {failedCount > 0 && (
                <button
                  onClick={retryFailed}
                  className="flex-1 py-3 text-sm bg-primary/10 text-primary rounded-lg hover:bg-primary/20"
                >
                  重试失败项
                </button>
              )}
              <button
                onClick={reset}
                className={cn(
                  'py-3 bg-muted text-foreground rounded-lg font-medium hover:bg-muted/80 transition-colors',
                  failedCount > 0 ? 'flex-1' : 'w-full'
                )}
              >
                完成
              </button>
            </div>
          ) : (
            <button
              onClick={async () => {
                // 检查频率，仅提醒不阻止
                const warning = await checkRateLimit()
                if (warning) {
                  setRateLimitWarning(warning)
                  // 8秒后自动关闭提醒
                  setTimeout(() => setRateLimitWarning(null), 8000)
                }
                // 无论有无警告都继续同步
                startSync()
              }}
              disabled={!article || selectedPlatforms.length === 0 || status === 'syncing'}
              className={cn(
                'w-full py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2',
                !article || selectedPlatforms.length === 0
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : status === 'syncing'
                  ? 'bg-primary/70 text-primary-foreground cursor-wait'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              {status === 'syncing' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  同步中 {results.length}/{selectedPlatforms.length}
                </>
              ) : (
                <>
                  🚀 同步到 {selectedPlatforms.length} 个平台
                </>
              )}
            </button>
          )}
        </div>
      </footer>

      {/* 设置抽屉 */}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* 频率警告提示（非阻塞） */}
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
