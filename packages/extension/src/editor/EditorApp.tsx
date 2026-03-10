import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Check, Loader2, ExternalLink, FileUp, Bold, Italic, Underline, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, Quote, Code, Heading1, Heading2, Heading3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createLogger } from '../lib/logger'
import { parseDocument, FILE_ACCEPT, type ParsedDocument } from '../lib/document-importer'
import { htmlToMarkdownNative } from '@wechatsync/core'
import { preprocessForPlatform, preprocessContentDOM, type PreprocessResult } from '../lib/content-processor'
const logger = createLogger('Editor')

interface Article {
  title: string
  content: string
  cover?: string
  url?: string
}

interface Platform {
  id: string
  name: string
  icon: string
  isAuthenticated: boolean
  username?: string
}

interface SyncResult {
  platform: string
  platformName?: string
  success: boolean
  postUrl?: string
  error?: string
}

// 同步阶段类型
type SyncStage = 'starting' | 'uploading_images' | 'saving' | 'completed' | 'failed'

// 平台同步详细进度
interface PlatformProgress {
  platform: string
  platformName: string
  stage: SyncStage
  imageProgress?: { current: number; total: number }
  error?: string
}

type SyncStatus = 'idle' | 'syncing' | 'completed'

// Storage key for selected platforms (same as popup)
const SELECTED_PLATFORMS_KEY = 'selectedPlatforms'

// 保存选中的平台到 storage
function saveSelectedPlatforms(platformIds: string[]) {
  chrome.storage.local.set({ [SELECTED_PLATFORMS_KEY]: platformIds }).catch((e) => {
    logger.error('Failed to save selected platforms:', e)
  })
}

export function EditorApp() {
  const [article, setArticle] = useState<Article | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [results, setResults] = useState<SyncResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [platformProgress, setPlatformProgress] = useState<Map<string, PlatformProgress>>(new Map())
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSyncIdRef = useRef<string | null>(null)

  // 保持 ref 与 state 同步
  useEffect(() => {
    currentSyncIdRef.current = currentSyncId
  }, [currentSyncId])

  const titleRef = useRef<HTMLHeadingElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // 富文本工具栏函数
  const execCommand = (command: string, value?: string) => {
    document.execCommand(command, false, value)
    contentRef.current?.focus()
  }

  const handleBold = () => execCommand('bold')
  const handleItalic = () => execCommand('italic')
  const handleUnderline = () => execCommand('underline')
  const handleBulletList = () => execCommand('insertUnorderedList')
  const handleNumberedList = () => execCommand('insertOrderedList')
  const handleAlignLeft = () => execCommand('justifyLeft')
  const handleAlignCenter = () => execCommand('justifyCenter')
  const handleAlignRight = () => execCommand('justifyRight')
  const handleQuote = () => execCommand('formatBlock', 'blockquote')
  const handleCode = () => execCommand('formatBlock', 'pre')
  const handleHeading1 = () => execCommand('formatBlock', 'h1')
  const handleHeading2 = () => execCommand('formatBlock', 'h2')
  const handleHeading3 = () => execCommand('formatBlock', 'h3')

  // 从 storage 加载文章数据（从 popup 打开时）
  useEffect(() => {
    const loadFromStorage = async () => {
      try {
        const storage = await chrome.storage.local.get(['pendingArticle', 'editorPlatforms'])

        if (storage.pendingArticle) {
          logger.info('Loading article from storage:', storage.pendingArticle.title)
          setArticle(storage.pendingArticle)

          // 设置初始内容到编辑器
          if (contentRef.current && storage.pendingArticle.content) {
            contentRef.current.innerHTML = storage.pendingArticle.content
          }

          // 清除 storage
          await chrome.storage.local.remove(['pendingArticle'])
        }

        if (storage.editorPlatforms) {
          logger.info('Loading platforms from storage:', storage.editorPlatforms.length)
          setPlatforms(storage.editorPlatforms.map((p: any) => ({
            id: p.id,
            name: p.name,
            icon: p.icon,
            isAuthenticated: p.isAuthenticated,
            username: p.username,
          })))

          // 清除 storage
          await chrome.storage.local.remove(['editorPlatforms'])
        }
      } catch (error) {
        logger.error('Failed to load from storage:', error)
      }
    }

    loadFromStorage()
  }, [])

  // 监听来自 background 的消息（独立标签页模式）
  useEffect(() => {
    const handleRuntimeMessage = (message: any) => {
      logger.debug('Received runtime message:', message)

      if (message.type === 'SYNC_PROGRESS') {
        if (message.result) {
          setResults(prev => [...prev, message.result])
        }
      } else if (message.type === 'SYNC_COMPLETE') {
        setStatus('completed')
        if (message.results) {
          setResults(message.results)
        }
      } else if (message.type === 'SYNC_ERROR') {
        setError(message.error || '同步失败')
        setStatus('idle')
      } else if (message.type === 'IMAGE_PROGRESS') {
        setPlatformProgress(prev => {
          const next = new Map(prev)
          next.set(message.platform, {
            platform: message.platform,
            platformName: message.platform,
            stage: 'uploading_images',
            imageProgress: { current: message.current, total: message.total },
          })
          return next
        })
      }
    }

    chrome.runtime.onMessage.addListener(handleRuntimeMessage)
    return () => chrome.runtime.onMessage.removeListener(handleRuntimeMessage)
  }, [])

  // 接收来自父窗口的消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data

        // 如果消息带有 syncId，需要匹配当前的 syncId
        if (data.syncId) {
          // 如果当前没有 syncId，保存这个 syncId（新同步开始）
          if (!currentSyncIdRef.current) {
            setCurrentSyncId(data.syncId)
          } else if (data.syncId !== currentSyncIdRef.current) {
            // 如果已有 syncId 且不匹配，忽略消息
            logger.debug('Ignoring message with different syncId:', data.syncId, 'current:', currentSyncIdRef.current)
            return
          }
        }

        logger.debug('Received message:', data)

        if (data.type === 'ARTICLE_DATA') {
          setArticle(data.article)
          // 设置初始内容
          if (contentRef.current && data.article.content) {
            contentRef.current.innerHTML = data.article.content
          }
        } else if (data.type === 'PLATFORMS_DATA') {
          setPlatforms(data.platforms)
          // 使用传递的已选中平台，如果没有则从 storage 读取
          if (data.selectedPlatformIds && data.selectedPlatformIds.length > 0) {
            setSelectedPlatforms(new Set(data.selectedPlatformIds))
            saveSelectedPlatforms(data.selectedPlatformIds)
          } else {
            // 从 storage 读取上次选中的平台
            chrome.storage.local.get(SELECTED_PLATFORMS_KEY).then((result) => {
              const storedPlatforms = result[SELECTED_PLATFORMS_KEY] as string[] | undefined
              const authenticated = data.platforms.filter((p: Platform) => p.isAuthenticated)
              const authenticatedIds = authenticated.map((p: Platform) => p.id)
              const authenticatedSet = new Set(authenticatedIds)

              let selected: string[]
              if (storedPlatforms && storedPlatforms.length > 0) {
                // 过滤掉未登录的平台
                selected = storedPlatforms.filter(id => authenticatedSet.has(id))
              } else {
                // 默认选中所有已登录平台
                selected = authenticatedIds
              }

              if (selected.length === 0) {
                // 如果过滤后为空，选中所有已登录平台
                selected = authenticatedIds
              }

              setSelectedPlatforms(new Set(selected))
            }).catch((e) => {
              logger.error('Failed to load selected platforms:', e)
              // 失败时默认选中所有已登录平台
              const authenticated = data.platforms.filter((p: Platform) => p.isAuthenticated)
              setSelectedPlatforms(new Set(authenticated.map((p: Platform) => p.id)))
            })
          }
        } else if (data.type === 'SYNC_PROGRESS') {
          if (data.result) {
            setResults(prev => [...prev, data.result])
          }
        } else if (data.type === 'SYNC_DETAIL_PROGRESS') {
          // 更新平台详细进度
          const progress = data.progress
          if (progress?.platform) {
            setPlatformProgress(prev => {
              const next = new Map(prev)
              next.set(progress.platform, progress)
              return next
            })
          }
        } else if (data.type === 'SYNC_COMPLETE') {
          setStatus('completed')
          // 显示频率限制警告（如果有）
          if (data.rateLimitWarning) {
            setRateLimitWarning(data.rateLimitWarning)
            // 8秒后自动关闭
            setTimeout(() => setRateLimitWarning(null), 8000)
          }
        } else if (data.type === 'SYNC_ERROR') {
          setError(data.error)
          setStatus('idle')
        }
      } catch (e) {
        logger.error('Failed to parse message:', e)
      }
    }

    window.addEventListener('message', handleMessage)

    // 通知父窗口已准备好
    window.parent.postMessage(JSON.stringify({ type: 'EDITOR_READY' }), '*')

    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // 关闭编辑器
  const handleClose = useCallback(() => {
    window.parent.postMessage(JSON.stringify({ type: 'CLOSE_EDITOR' }), '*')
  }, [])

  // 打开文件选择器
  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  // 处理文件导入
  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    try {
      const parsed = await parseDocument(file) as ParsedDocument
      setArticle(prev => prev ? {
        ...prev,
        title: parsed.title || prev.title,
        content: parsed.content || prev.content,
      } : null)

      // 更新编辑器内容
      if (contentRef.current) {
        contentRef.current.innerHTML = parsed.content || ''
      }
      if (titleRef.current) {
        titleRef.current.innerText = parsed.title || ''
      }

      logger.info('Document imported:', file.name)
    } catch (error) {
      logger.error('Failed to import document:', error)
      setError(`导入失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setIsImporting(false)
      // 清空 input 以便再次选择相同文件
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  // 切换平台选中状态
  const togglePlatform = (id: string) => {
    setSelectedPlatforms(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      // 保存到 storage，与 popup 同步
      saveSelectedPlatforms(Array.from(next))
      return next
    })
  }

  // 开始同步
  const handleSync = async () => {
    if (!article || selectedPlatforms.size === 0) return

    // 获取编辑后的内容
    const rawHtml = contentRef.current?.innerHTML || article.content || ''

    // 生成 syncId
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)

    setStatus('syncing')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())

    try {
      const platformsArr = Array.from(selectedPlatforms)

      // 获取平台预处理配置
      const configResponse = await chrome.runtime.sendMessage({
        type: 'GET_PREPROCESS_CONFIGS',
        platforms: platformsArr,
      })
      const configs = configResponse?.configs || {}

      // 为选中平台逐一进行本地预处理
      const platformContents: Record<string, PreprocessResult> = {}
      for (const platformId of platformsArr) {
        const config = configs[platformId]
        if (config) {
          platformContents[platformId] = preprocessForPlatform(rawHtml, config)
        } else {
          // 没有配置的平台使用默认处理
          const tempDiv = document.createElement('div')
          tempDiv.innerHTML = rawHtml
          preprocessContentDOM(tempDiv)
          const html = tempDiv.innerHTML
          platformContents[platformId] = {
            html,
            markdown: htmlToMarkdownNative(html),
          }
        }
      }

      const editedArticle = {
        ...article,
        title: titleRef.current?.innerText || article.title,
        content: rawHtml,
        html: rawHtml,
        markdown: htmlToMarkdownNative(rawHtml),
        platformContents,
      }

      // 发送同步请求到 background（通过 chrome.runtime.sendMessage）
      const response = await chrome.runtime.sendMessage({
        type: 'SYNC_ARTICLE_FROM_EDITOR',
        payload: {
          article: editedArticle,
          platforms: platformsArr,
          syncId,
        }
      })

      console.log('Sync response:', response)
    } catch (error) {
      console.error('Sync error:', error)
      setError('同步失败: ' + (error instanceof Error ? error.message : '未知错误'))
      setStatus('idle')
    }
  }

  // 重试失败项
  const handleRetry = async () => {
    const failedPlatforms = results.filter(r => !r.success).map(r => r.platform)
    if (failedPlatforms.length === 0) return

    const rawHtml = contentRef.current?.innerHTML || article!.content || ''

    // 生成新的 syncId
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)

    setStatus('syncing')
    setResults(prev => prev.filter(r => r.success))
    setPlatformProgress(new Map()) // 清空进度

    try {
      const configResponse = await chrome.runtime.sendMessage({
        type: 'GET_PREPROCESS_CONFIGS',
        platforms: failedPlatforms,
      })
      const configs = configResponse?.configs || {}

      const platformContents: Record<string, PreprocessResult> = {}
      for (const platformId of failedPlatforms) {
        const config = configs[platformId]
        if (config) {
          platformContents[platformId] = preprocessForPlatform(rawHtml, config)
        } else {
          const tempDiv = document.createElement('div')
          tempDiv.innerHTML = rawHtml
          preprocessContentDOM(tempDiv)
          const html = tempDiv.innerHTML
          platformContents[platformId] = {
            html,
            markdown: htmlToMarkdownNative(html),
          }
        }
      }

      const editedArticle = {
        ...article!,
        title: titleRef.current?.innerText || article!.title,
        content: rawHtml,
        html: rawHtml,
        markdown: htmlToMarkdownNative(rawHtml),
        platformContents,
      }

      await chrome.runtime.sendMessage({
        type: 'SYNC_ARTICLE_FROM_EDITOR',
        payload: {
          article: editedArticle,
          platforms: failedPlatforms,
          syncId,
        }
      })
    } catch (error) {
      console.error('Retry sync error:', error)
      setError('重试失败: ' + (error instanceof Error ? error.message : '未知错误'))
      setStatus('idle')
    }
  }

  const authenticatedPlatforms = platforms.filter(p => p.isAuthenticated)
  const successCount = results.filter(r => r.success).length
  const failedCount = results.filter(r => !r.success).length

  if (!article) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400 mx-auto" />
          <p className="mt-2 text-gray-500">加载文章中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部工具栏 */}
      <header className="fixed top-0 left-0 right-0 bg-white border-b shadow-sm z-50">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img src={chrome.runtime.getURL('assets/icon-48.png')} alt="Logo" className="w-6 h-6" />
            <span className="font-medium text-gray-700">同步助手 - 编辑模式</span>
          </div>

          {/* 隐藏的文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            onChange={handleFileImport}
            className="hidden"
          />

          <div className="flex items-center gap-2">
            {status === 'idle' && (
              <button
                onClick={handleSync}
                disabled={selectedPlatforms.size === 0}
                className={cn(
                  'px-4 py-2 rounded-lg font-medium transition-colors',
                  selectedPlatforms.size > 0
                    ? 'bg-blue-500 text-white hover:bg-blue-600'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                )}
              >
                同步到 {selectedPlatforms.size} 个平台
              </button>
            )}

            {status === 'syncing' && (
              <div className="flex items-center gap-2">
                <span className="px-4 py-2 rounded-lg bg-blue-400 text-white flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  同步中 {results.length}/{selectedPlatforms.size}
                </span>
                <button
                  onClick={() => {
                    setStatus('idle')
                    setResults([])
                    setError(null)
                  }}
                  className="px-3 py-2 rounded-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors text-sm"
                >
                  取消
                </button>
              </div>
            )}

            {status === 'completed' && (
              <div className="flex items-center gap-2">
                {failedCount > 0 && (
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600"
                  >
                    重试失败 ({failedCount})
                  </button>
                )}
                <span className="text-sm text-gray-500">
                  {successCount} 成功 / {failedCount} 失败
                </span>
                <button
                  onClick={() => {
                    setStatus('idle')
                    setResults([])
                    setPlatformProgress(new Map())
                    setCurrentSyncId(null)
                  }}
                  className="px-4 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600"
                >
                  完成
                </button>
              </div>
            )}

            <button
              onClick={handleClose}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="关闭"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* 平台选择栏 */}
        <div className="px-6 py-2 border-t bg-gray-50 flex items-center gap-2 overflow-x-auto">
          <span className="text-sm text-gray-500 flex-shrink-0">选择平台:</span>
          {/* 全选/全不选按钮 */}
          <div className="flex items-center gap-1 flex-shrink-0 mr-2">
            <button
              onClick={() => {
                const allIds = authenticatedPlatforms.map(p => p.id)
                setSelectedPlatforms(new Set(allIds))
                saveSelectedPlatforms(allIds)
              }}
              disabled={status === 'syncing'}
              className="px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 disabled:opacity-50"
            >
              全选
            </button>
            <button
              onClick={() => {
                setSelectedPlatforms(new Set())
                saveSelectedPlatforms([])
              }}
              disabled={status === 'syncing'}
              className="px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 disabled:opacity-50"
            >
              全不选
            </button>
          </div>
          {authenticatedPlatforms.map(platform => {
            const isSelected = selectedPlatforms.has(platform.id)
            const result = results.find(r => r.platform === platform.id)

            return (
              <button
                key={platform.id}
                onClick={() => togglePlatform(platform.id)}
                disabled={status === 'syncing'}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-all flex-shrink-0',
                  isSelected
                    ? 'bg-blue-100 text-blue-700 border-2 border-blue-300'
                    : 'bg-white text-gray-600 border border-gray-200 hover:border-gray-300',
                  status === 'syncing' && 'opacity-50 cursor-not-allowed'
                )}
              >
                <img src={platform.icon} alt="" className="w-4 h-4 rounded" />
                <span>{platform.name}</span>
                {result && (
                  result.success ? (
                    <Check className="w-3 h-3 text-green-500" />
                  ) : (
                    <X className="w-3 h-3 text-red-500" />
                  )
                )}
              </button>
            )
          })}
        </div>

        {/* 富文本工具栏 - 居中显示 */}
        <div className="px-6 py-3 bg-white border-t flex items-center justify-center gap-1 flex-wrap">
          <button onClick={handleBold} className="p-1.5 rounded hover:bg-gray-100" title="粗体">
            <Bold className="w-4 h-4" />
          </button>
          <button onClick={handleItalic} className="p-1.5 rounded hover:bg-gray-100" title="斜体">
            <Italic className="w-4 h-4" />
          </button>
          <button onClick={handleUnderline} className="p-1.5 rounded hover:bg-gray-100" title="下划线">
            <Underline className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <button onClick={handleHeading1} className="p-1.5 rounded hover:bg-gray-100 text-xs font-bold" title="标题1">
            H1
          </button>
          <button onClick={handleHeading2} className="p-1.5 rounded hover:bg-gray-100 text-xs font-bold" title="标题2">
            H2
          </button>
          <button onClick={handleHeading3} className="p-1.5 rounded hover:bg-gray-100 text-xs font-bold" title="标题3">
            H3
          </button>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <button onClick={handleBulletList} className="p-1.5 rounded hover:bg-gray-100" title="无序列表">
            <List className="w-4 h-4" />
          </button>
          <button onClick={handleNumberedList} className="p-1.5 rounded hover:bg-gray-100" title="有序列表">
            <ListOrdered className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <button onClick={handleAlignLeft} className="p-1.5 rounded hover:bg-gray-100" title="左对齐">
            <AlignLeft className="w-4 h-4" />
          </button>
          <button onClick={handleAlignCenter} className="p-1.5 rounded hover:bg-gray-100" title="居中">
            <AlignCenter className="w-4 h-4" />
          </button>
          <button onClick={handleAlignRight} className="p-1.5 rounded hover:bg-gray-100" title="右对齐">
            <AlignRight className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <button onClick={handleQuote} className="p-1.5 rounded hover:bg-gray-100" title="引用">
            <Quote className="w-4 h-4" />
          </button>
          <button onClick={handleCode} className="p-1.5 rounded hover:bg-gray-100" title="代码">
            <Code className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <button
            onClick={handleImportClick}
            disabled={isImporting || status === 'syncing'}
            className={cn(
              'px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors',
              status === 'syncing'
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
            )}
            title="导入 Word 或 Markdown 文档"
          >
            {isImporting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <FileUp className="w-3 h-3" />
            )}
            导入
          </button>
        </div>
      </header>

      {/* 频率限制警告 */}
      {rateLimitWarning && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 shadow-lg flex items-center gap-2 max-w-md">
            <span className="text-lg flex-shrink-0">⚠️</span>
            <p className="text-sm text-yellow-800 flex-1">{rateLimitWarning}</p>
            <button
              onClick={() => setRateLimitWarning(null)}
              className="text-yellow-600 hover:text-yellow-800 flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 文章内容区 */}
      <main className="pt-48 pb-16">
        <article className="w-full max-w-4xl mx-auto bg-white shadow-sm px-12 py-10" style={{ minHeight: 'calc(100vh - 7rem)' }}>
          {/* 封面图 */}
          {article.cover && (
            <img
              src={article.cover}
              alt=""
              className="w-full max-h-80 object-cover mb-8"
            />
          )}

          {/* 标题 - 可编辑 */}
          <h1
            ref={titleRef}
            contentEditable
            suppressContentEditableWarning
            className="text-3xl font-bold text-gray-900 mb-8 outline-none focus:bg-blue-50 rounded px-2 -mx-2 leading-tight"
          >
            {article.title}
          </h1>

          {/* 内容 - 可编辑 */}
          <div
            ref={contentRef}
            contentEditable
            suppressContentEditableWarning
            className="outline-none focus:bg-blue-50/50 rounded article-content"
            style={{
              fontSize: '16px',
              lineHeight: '1.8',
              color: '#333',
            }}
            dangerouslySetInnerHTML={{ __html: article.content }}
          />
          <style>{`
            .article-content p { margin-bottom: 1em; }
            .article-content h1 { font-size: 2em; font-weight: bold; margin: 1em 0 0.5em; }
            .article-content h2 { font-size: 1.5em; font-weight: bold; margin: 1em 0 0.5em; }
            .article-content h3 { font-size: 1.25em; font-weight: 600; margin: 0.8em 0 0.4em; }
            .article-content img { max-width: 100%; height: auto; margin: 1em 0; display: block; }
            .article-content pre { background: #f5f5f5; padding: 1em; border-radius: 6px; overflow-x: auto; margin: 1em 0; font-size: 14px; }
            .article-content code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
            .article-content pre code { background: none; padding: 0; }
            .article-content blockquote { border-left: 4px solid #ddd; padding-left: 1em; margin: 1em 0; color: #666; font-style: italic; }
            .article-content ul { list-style: disc; padding-left: 2em; margin: 1em 0; }
            .article-content ol { list-style: decimal; padding-left: 2em; margin: 1em 0; }
            .article-content li { margin-bottom: 0.5em; }
            .article-content a { color: #2563eb; text-decoration: underline; }
            .article-content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
            .article-content th, .article-content td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
            .article-content th { background: #f5f5f5; font-weight: 600; }
            .article-content hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
            .article-content strong { font-weight: 600; }
            .article-content em { font-style: italic; }
          `}</style>
        </article>
      </main>

      {/* 同步进度/结果浮窗 */}
      {(status === 'syncing' || results.length > 0) && (
        <div className="fixed bottom-4 right-4 bg-white rounded-lg shadow-lg border p-4 w-80 max-h-80 overflow-y-auto z-50">
          <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
            {status === 'syncing' && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
            {status === 'syncing' ? '同步中' : '同步结果'}
            <span className="text-sm font-normal text-gray-500">
              {results.length}/{selectedPlatforms.size}
            </span>
          </h3>
          <div className="space-y-2">
            {Array.from(selectedPlatforms).map(platformId => {
              const platform = platforms.find(p => p.id === platformId)
              const result = results.find(r => r.platform === platformId)
              const progress = platformProgress.get(platformId)

              // 获取阶段文本
              const getStageText = (p: PlatformProgress) => {
                switch (p.stage) {
                  case 'starting': return '准备中...'
                  case 'uploading_images':
                    return p.imageProgress
                      ? `上传图片 ${p.imageProgress.current}/${p.imageProgress.total}`
                      : '上传图片...'
                  case 'saving': return '保存文章...'
                  case 'completed': return '完成'
                  case 'failed': return p.error || '失败'
                  default: return '等待中'
                }
              }

              if (result) {
                // 已完成
                return (
                  <div key={platformId} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      {result.success ? (
                        <Check className="w-4 h-4 text-green-500" />
                      ) : (
                        <X className="w-4 h-4 text-red-500" />
                      )}
                      {platform?.name || platformId}
                    </span>
                    {result.success && result.postUrl && (
                      <a
                        href={result.postUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline flex items-center gap-1"
                      >
                        查看 <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {!result.success && result.error && (
                      <span className="text-red-500 truncate max-w-[120px]" title={result.error}>
                        {result.error}
                      </span>
                    )}
                  </div>
                )
              }

              if (progress) {
                // 进行中
                return (
                  <div key={platformId} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                      {platform?.name || platformId}
                    </span>
                    <span className="text-blue-600 text-xs">
                      {getStageText(progress)}
                    </span>
                  </div>
                )
              }

              // 等待中
              return (
                <div key={platformId} className="flex items-center justify-between text-sm text-gray-400">
                  <span className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full border border-gray-300" />
                    {platform?.name || platformId}
                  </span>
                  <span className="text-xs">等待中</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="fixed bottom-4 left-4 bg-red-50 border border-red-200 rounded-lg p-4 max-w-sm z-50">
          <p className="text-red-700 text-sm">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-2 text-red-500 hover:underline text-sm"
          >
            关闭
          </button>
        </div>
      )}
    </div>
  )
}
