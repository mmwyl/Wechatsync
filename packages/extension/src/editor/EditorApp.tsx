import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Loader2, FileUp, Bold, Italic, Underline, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, Quote, Code, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SyncDialog } from '@/components/sync-dialog'
import type { Platform, SyncResult, PlatformProgress } from '@/components/sync-dialog/types'
import { createLogger } from '../lib/logger'
import { parseDocument, FILE_ACCEPT, type ParsedDocument } from '../lib/document-importer'
import { htmlToMarkdownNative } from '@wechatsync/core'
import { preprocessForPlatform, type PreprocessResult } from '../lib/content-processor'
import { storeLargePayload } from '../lib/large-message'
const logger = createLogger('Editor')

interface Article {
  title: string
  content: string
  cover?: string
  url?: string
  extractor?: string
}

type SyncStatus = 'idle' | 'syncing' | 'completed'

const SELECTED_PLATFORMS_KEY = 'selectedPlatforms'

function saveSelectedPlatforms(platformIds: string[]) {
  chrome.storage.local.set({ [SELECTED_PLATFORMS_KEY]: platformIds }).catch((e) => {
    logger.error('Failed to save selected platforms:', e)
  })
}

export function EditorApp() {
  const [article, setArticle] = useState<Article | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [results, setResults] = useState<SyncResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [platformProgress, setPlatformProgress] = useState<Map<string, PlatformProgress>>(new Map())
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSyncIdRef = useRef<string | null>(null)
  const [showSyncDialog, setShowSyncDialog] = useState(false)

  useEffect(() => {
    currentSyncIdRef.current = currentSyncId
  }, [currentSyncId])

  const titleRef = useRef<HTMLHeadingElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // 富文本工具栏命令
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

  // 从 storage 加载文章数据（从 popup 导入文档打开新标签页时使用）
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

          // 清除 storage，避免下次重复加载
          await chrome.storage.local.remove(['pendingArticle'])
        }

        if (storage.editorPlatforms) {
          logger.info('Loading platforms from storage:', storage.editorPlatforms.length)
          const filtered = storage.editorPlatforms.filter((p: any) => p.id !== 'zip-download')
          setPlatforms(filtered.map((p: any) => ({
            id: p.id,
            name: p.name,
            icon: p.icon,
            isAuthenticated: p.isAuthenticated,
            username: p.username,
          })))

          // 从 storage 恢复已选中的平台
          const storedSelection = await chrome.storage.local.get(SELECTED_PLATFORMS_KEY)
          const storedPlatforms = storedSelection[SELECTED_PLATFORMS_KEY] as string[] | undefined
          const authenticated = filtered.filter((p: any) => p.isAuthenticated)
          const authenticatedIds = authenticated.map((p: any) => p.id)

          if (storedPlatforms && storedPlatforms.length > 0) {
            const authenticatedSet = new Set(authenticatedIds)
            const selected = storedPlatforms.filter(id => authenticatedSet.has(id))
            setSelectedPlatforms(selected.length > 0 ? selected : authenticatedIds)
          } else {
            setSelectedPlatforms(authenticatedIds)
          }

          await chrome.storage.local.remove(['editorPlatforms'])
        }
      } catch (error) {
        logger.error('Failed to load from storage:', error)
      }
    }

    loadFromStorage()
  }, [])

  // 监听来自 background 的消息（新标签页模式下同步进度通信）
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

  // Receive messages from parent window
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data

        if (data.syncId) {
          if (!currentSyncIdRef.current) {
            setCurrentSyncId(data.syncId)
          } else if (data.syncId !== currentSyncIdRef.current) {
            logger.debug('Ignoring message with different syncId:', data.syncId, 'current:', currentSyncIdRef.current)
            return
          }
        }

        logger.debug('Received message:', data)

        if (data.type === 'ARTICLE_DATA') {
          setArticle(data.article)
          if (contentRef.current && data.article.content) {
            contentRef.current.innerHTML = data.article.content
          }
        } else if (data.type === 'PLATFORMS_DATA') {
          const filteredPlatforms = (data.platforms || []).filter((p: Platform) => p.id !== 'zip-download')
          setPlatforms(filteredPlatforms)
          if (data.selectedPlatformIds && data.selectedPlatformIds.length > 0) {
            const filteredSelected = data.selectedPlatformIds.filter((id: string) => id !== 'zip-download')
            setSelectedPlatforms(filteredSelected)
            saveSelectedPlatforms(filteredSelected)
          } else {
            chrome.storage.local.get(SELECTED_PLATFORMS_KEY).then((result) => {
              const storedPlatforms = result[SELECTED_PLATFORMS_KEY] as string[] | undefined
              const authenticated = filteredPlatforms.filter((p: Platform) => p.isAuthenticated)
              const authenticatedIds = authenticated.map((p: Platform) => p.id)
              const authenticatedSet = new Set(authenticatedIds)

              const selected = storedPlatforms
                ? storedPlatforms.filter(id => authenticatedSet.has(id))
                : []
              setSelectedPlatforms(selected)
            }).catch((e) => {
              logger.error('Failed to load selected platforms:', e)
              setSelectedPlatforms([])
            })
          }
        } else if (data.type === 'SYNC_PROGRESS') {
          if (data.result) {
            setResults(prev => {
              const next = [...prev, data.result]
              // Auto-transition to completed when all platforms are done
              // (handles case where editor stays open throughout sync)
              return next
            })
          }
        } else if (data.type === 'SYNC_DETAIL_PROGRESS') {
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
          if (data.rateLimitWarning) {
            setRateLimitWarning(data.rateLimitWarning)
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
    window.parent.postMessage(JSON.stringify({ type: 'EDITOR_READY' }), '*')
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Auto-detect completion from results
  useEffect(() => {
    if (status === 'syncing' && results.length > 0 && results.length >= selectedPlatforms.length) {
      setStatus('completed')
    }
  }, [results.length, selectedPlatforms.length, status])

  // 判断是否在 iframe 中运行（iframe 模式 vs 独立标签页模式）
  const isInIframe = window.parent !== window

  const handleClose = useCallback(() => {
    if (isInIframe) {
      window.parent.postMessage(JSON.stringify({ type: 'CLOSE_EDITOR' }), '*')
    } else {
      // 独立标签页模式：直接关闭标签页
      window.close()
    }
  }, [isInIframe])

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

  // Get edited article content
  const getEditedArticle = useCallback(() => {
    if (!article) return null
    return {
      ...article,
      title: titleRef.current?.innerText || article.title,
      content: contentRef.current?.innerHTML || article.content,
    }
  }, [article])

  // ── SyncDialog action handlers ──

  const handleTogglePlatform = (id: string) => {
    setSelectedPlatforms(prev => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      const next = Array.from(set)
      saveSelectedPlatforms(next)
      return next
    })
  }

  const handleSelectAll = () => {
    const allIds = platforms.filter(p => p.isAuthenticated).map(p => p.id)
    setSelectedPlatforms(allIds)
    saveSelectedPlatforms(allIds)
  }

  const handleDeselectAll = () => {
    setSelectedPlatforms([])
    saveSelectedPlatforms([])
  }


  const handleStartSync = async () => {
    const editedArticle = getEditedArticle()
    if (!editedArticle || selectedPlatforms.length === 0) return

    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)
    setStatus('syncing')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())

    if (isInIframe) {
      // iframe 模式：通过 postMessage 与 content script 通信
      window.parent.postMessage(JSON.stringify({
        type: 'START_SYNC',
        article: editedArticle,
        platforms: selectedPlatforms,
        syncId,
      }), '*')
    } else {
      // 独立标签页模式：直接通过 runtime.sendMessage 与 background 通信
      try {
        const rawHtml = editedArticle.content || ''
        const platformsArr = [...selectedPlatforms]

        // 获取各平台预处理配置
        const configResponse = await chrome.runtime.sendMessage({
          type: 'GET_PREPROCESS_CONFIGS',
          platforms: platformsArr,
        })
        const configs = configResponse?.configs || {}

        // 为各平台做本地预处理
        const platformContents: Record<string, PreprocessResult> = {}
        for (const platformId of platformsArr) {
          const config = configs[platformId]
          if (config) {
            platformContents[platformId] = await preprocessForPlatform(rawHtml, config)
          } else {
            // 无预处理配置，直接使用原始 HTML
            platformContents[platformId] = {
              html: rawHtml,
              markdown: htmlToMarkdownNative(rawHtml),
            }
          }
        }

        const fullArticle = {
          ...editedArticle,
          html: rawHtml,
          markdown: htmlToMarkdownNative(rawHtml),
          platformContents,
        }

        // 大数据通过 storage 中转，避免 runtime.sendMessage 的 64MiB 限制
        const storageKey = await storeLargePayload(syncId, {
          article: fullArticle,
          platforms: platformsArr,
          syncId,
        })

        await chrome.runtime.sendMessage({
          type: 'SYNC_ARTICLE_FROM_EDITOR',
          payload: { storageKey, syncId },
        })
      } catch (error) {
        logger.error('Sync error:', error)
        setError('同步失败: ' + (error instanceof Error ? error.message : '未知错误'))
        setStatus('idle')
      }
    }
  }

  const handleRetryFailed = async () => {
    const failedPlatforms = results.filter(r => !r.success).map(r => r.platform)
    if (failedPlatforms.length === 0) return

    const editedArticle = getEditedArticle()
    if (!editedArticle) return

    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)
    setStatus('syncing')
    setResults(prev => prev.filter(r => r.success))
    setPlatformProgress(new Map())

    if (isInIframe) {
      window.parent.postMessage(JSON.stringify({
        type: 'START_SYNC',
        article: editedArticle,
        platforms: failedPlatforms,
        syncId,
      }), '*')
    } else {
      try {
        const rawHtml = editedArticle.content || ''

        const configResponse = await chrome.runtime.sendMessage({
          type: 'GET_PREPROCESS_CONFIGS',
          platforms: failedPlatforms,
        })
        const configs = configResponse?.configs || {}

        const platformContents: Record<string, PreprocessResult> = {}
        for (const platformId of failedPlatforms) {
          const config = configs[platformId]
          if (config) {
            platformContents[platformId] = await preprocessForPlatform(rawHtml, config)
          } else {
            // 无预处理配置，直接使用原始 HTML
            platformContents[platformId] = {
              html: rawHtml,
              markdown: htmlToMarkdownNative(rawHtml),
            }
          }
        }

        const fullArticle = {
          ...editedArticle,
          html: rawHtml,
          markdown: htmlToMarkdownNative(rawHtml),
          platformContents,
        }

        const storageKey = await storeLargePayload(syncId, {
          article: fullArticle,
          platforms: failedPlatforms,
          syncId,
        })

        await chrome.runtime.sendMessage({
          type: 'SYNC_ARTICLE_FROM_EDITOR',
          payload: { storageKey, syncId },
        })
      } catch (error) {
        logger.error('Retry sync error:', error)
        setError('重试失败: ' + (error instanceof Error ? error.message : '未知错误'))
        setStatus('idle')
      }
    }
  }

  const handleReset = () => {
    setStatus('idle')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())
    setCurrentSyncId(null)
    setShowSyncDialog(false)
  }

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

  const authenticatedCount = platforms.filter(p => p.isAuthenticated).length

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toolbar */}
      <header className="fixed top-0 left-0 right-0 bg-white border-b shadow-sm z-50">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 flex-shrink-0">
            <img src={chrome.runtime.getURL('assets/icon-48.png')} alt="Logo" className="w-6 h-6" />
            <span className="font-medium text-gray-700 whitespace-nowrap">同步助手</span>
          </div>

          {/* 平台选择 chips */}
          <div className="flex-1 mx-4 flex items-center gap-1.5 overflow-x-auto">
            {authenticatedCount > 0 && (
              // 导入/编辑后顶部提供快速批量选择，保持与 backup 分支的一致交互
              <div className="flex items-center gap-1 flex-shrink-0 mr-1">
                <button
                  onClick={handleSelectAll}
                  disabled={status === 'syncing'}
                  className="px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 disabled:opacity-50 whitespace-nowrap"
                >
                  全选
                </button>
                <button
                  onClick={handleDeselectAll}
                  disabled={status === 'syncing' || selectedPlatforms.length === 0}
                  className="px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 disabled:opacity-50 whitespace-nowrap"
                  title="全不选"
                >
                  全不选
                </button>
              </div>
            )}

            {platforms.filter(p => p.isAuthenticated).map(platform => {
              const isSelected = selectedPlatforms.includes(platform.id)
              return (
                <button
                  key={platform.id}
                  onClick={() => handleTogglePlatform(platform.id)}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all whitespace-nowrap border',
                    isSelected
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                  )}
                >
                  {platform.icon && (
                    <img src={platform.icon} alt="" className="w-3.5 h-3.5 rounded-sm" />
                  )}
                  {platform.name}
                  {isSelected && <Check className="w-3 h-3" />}
                </button>
              )
            })}

            {platforms.filter(p => p.isAuthenticated).length === 0 && (
              <span className="text-xs text-gray-400 whitespace-nowrap">暂无已登录平台</span>
            )}
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
            <button
              onClick={handleImportClick}
              disabled={isImporting || status === 'syncing'}
              className={cn(
                'px-3 py-2 rounded-lg text-sm flex items-center gap-1 transition-colors',
                (isImporting || status === 'syncing')
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
              )}
              title="导入 Word 或 Markdown 文档"
            >
              {isImporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileUp className="w-4 h-4" />
              )}
              导入
            </button>

            <button
              onClick={() => setShowSyncDialog(true)}
              className={cn(
                'px-4 py-2 rounded-lg font-medium transition-colors',
                authenticatedCount > 0
                  ? 'bg-blue-500 text-white hover:bg-blue-600'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              )}
              disabled={authenticatedCount === 0}
            >
              同步{selectedPlatforms.length > 0 ? ` (${selectedPlatforms.length})` : ''}
            </button>

            <button
              onClick={handleClose}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="关闭"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* 富文本工具栏 */}
        <div className="px-6 py-2 bg-white border-t flex items-center justify-center gap-1 flex-wrap">
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
        </div>
      </header>

      {/* Rate limit warning */}
      {rateLimitWarning && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60] animate-in fade-in slide-in-from-top-2 duration-200">
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

      {/* Article content area */}
      <main className="pt-32 pb-16">
        <article className="w-full max-w-4xl mx-auto bg-white shadow-sm px-12 py-10" style={{ minHeight: 'calc(100vh - 8rem)' }}>
          {article.cover && (
            <img
              src={article.cover}
              alt=""
              className="w-full max-h-80 object-cover mb-8"
            />
          )}

          <h1
            ref={titleRef}
            contentEditable
            suppressContentEditableWarning
            className="text-3xl font-bold text-gray-900 mb-8 outline-none border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-blue-50 rounded px-2 -mx-2 leading-tight transition-colors"
          >
            {article.title}
          </h1>

          <div
            ref={contentRef}
            contentEditable
            suppressContentEditableWarning
            className="outline-none border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-blue-50/50 rounded transition-colors article-content"
            style={{ fontSize: '16px', lineHeight: '1.8', color: '#333' }}
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

      {/* Sync Dialog overlay */}
      {showSyncDialog && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              if (status === 'idle') setShowSyncDialog(false)
            }}
          />
          {/* Dialog */}
          <div className="relative bg-white rounded-xl shadow-2xl w-[400px] max-h-[520px] overflow-hidden">
            {/* Dialog header */}
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-gray-900">文章同步</span>
              <button
                onClick={() => {
                  if (status !== 'syncing') {
                    handleReset()
                  }
                }}
                className="p-1 rounded hover:bg-gray-100 transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            <SyncDialog
              article={article}
              platforms={platforms}
              status={status === 'idle' ? 'idle' : status === 'syncing' ? 'syncing' : 'completed'}
              selectedPlatforms={selectedPlatforms}
              results={results}
              platformProgress={platformProgress}
              error={error}
              onTogglePlatform={handleTogglePlatform}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
              onStartSync={handleStartSync}
              onRetryFailed={handleRetryFailed}
              onReset={handleReset}
              onCancel={handleReset}
              className="max-h-[460px]"
            />
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && !showSyncDialog && (
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
