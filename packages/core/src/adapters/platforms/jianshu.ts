/**
 * 简书适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Jianshu')

interface JianshuNotebook {
  id: number
  name: string
}

export class JianshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'jianshu',
    name: '简书',
    icon: 'https://www.jianshu.com/favicon.ico',
    homepage: 'https://www.jianshu.com',
    capabilities: ['article', 'draft', 'image_upload', 'categories'],
  }

  /** 预处理配置: 简书使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private defaultNotebookId: number | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://www.jianshu.com/settings/basic.json', {
        method: 'GET',
        credentials: 'include',
      })

      const data = await response.json() as {
        data?: {
          nickname?: string
          avatar?: string
        }
      }

      if (data.data?.nickname) {
        return {
          isAuthenticated: true,
          username: data.data.nickname,
          avatar: data.data.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取文集列表（分类）
   */
  async getNotebooks(): Promise<JianshuNotebook[]> {
    const response = await this.runtime.fetch('https://www.jianshu.com/author/notebooks', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      },
    })

    return response.json() as Promise<JianshuNotebook[]>
  }

  /**
   * 获取默认文集 ID
   */
  private async getDefaultNotebookId(): Promise<number> {
    if (this.defaultNotebookId) {
      return this.defaultNotebookId
    }

    const notebooks = await this.getNotebooks()
    if (notebooks.length === 0) {
      throw new Error('没有可用的文集')
    }

    // 使用第一个文集作为默认
    this.defaultNotebookId = notebooks[0].id
    return this.defaultNotebookId
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting publish...')

      // 1. 获取文集 ID
      const notebookId = await this.getDefaultNotebookId()

      // 2. 创建文章草稿
      const createResponse = await this.runtime.fetch('https://www.jianshu.com/author/notes', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          at_bottom: false,
          notebook_id: notebookId,
          title: article.title,
        }),
      })

      const createData = await createResponse.json() as { id?: number }

      if (!createData.id) {
        throw new Error('创建草稿失败')
      }

      const draftId = createData.id
      logger.debug('Draft created:', draftId)

      // Use pre-processed HTML content directly
      let content = article.html || ''

      // Jianshu-specific: remove empty paragraphs, remove trailing br
      content = content.replace(/<p>\s*<\/p>/gi, '')
      content = content.replace(/<br\s*\/?>\s*$/gi, '')

      // Process images
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['jianshu.com', 'jianshuapi.com', 'upload-images.jianshu.io'],
          onProgress: options?.onImageProgress,
        }
      )

      // 7. 更新草稿内容
      const updateResponse = await this.runtime.fetch(
        `https://www.jianshu.com/author/notes/${draftId}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: article.title,
            content: content,
          }),
        }
      )

      const updateData = await updateResponse.json() as { id?: number }

      if (!updateData.id) {
        throw new Error('更新草稿失败')
      }

      logger.debug('Draft updated')

      const draftUrl = `https://www.jianshu.com/writer#/notebooks/${notebookId}/notes/${draftId}`

      return this.createResult(true, {
        postId: String(draftId),
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  /**
   * 获取图片上传凭证
   */
  private async getUploadToken(): Promise<{ token: string; url: string }> {
    const response = await this.runtime.fetch('https://www.jianshu.com/upload_images/token.json', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      },
    })

    return response.json() as Promise<{ token: string; url: string }>
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.uploadImageBinaryInternal(file)
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      // 1. 下载图片
      const imageResponse = await fetch(src)
      if (!imageResponse.ok) {
        throw new Error('图片下载失败')
      }
      const imageBlob = await imageResponse.blob()

      // 2. 上传图片
      const url = await this.uploadImageBinaryInternal(imageBlob)
      return { url }
    } catch (error) {
      logger.warn('Failed to upload image:', src, error)
      return { url: src } // 失败时返回原 URL
    }
  }

  /**
   * 上传图片 (二进制方式) - 内部使用
   */
  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    // 1. 获取上传凭证
    const { token, url: uploadUrl } = await this.getUploadToken()

    // 2. 生成文件名
    const ext = file.type.split('/')[1] || 'png'
    const filename = `${Date.now()}.${ext}`

    // 3. 上传到七牛云
    const formData = new FormData()
    formData.append('file', file, filename)
    formData.append('token', token)

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    })

    const data = await response.json() as { url?: string; key?: string }

    if (data.url) {
      return data.url
    }

    // 七牛返回的是 key，需要拼接完整 URL
    if (data.key) {
      return `https://upload-images.jianshu.io/upload_images/${data.key}`
    }

    throw new Error('图片上传失败')
  }
}
