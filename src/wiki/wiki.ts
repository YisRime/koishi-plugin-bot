import { Context, Command } from 'koishi'
import { sendContent, parseMode, Result, SearchResults, ContentSource } from './utils'
import { requestWikiSearch, requestWikiExtract, fetchPageContent } from './api'
import { Config } from '../index'

const WIKI_BASE_URL = 'https://zh.minecraft.wiki/w/'

// 搜索并获取Wiki词条详情（单条）
export async function searchWiki(ctx: Context, query: string): Promise<Result | null> {
  const { items } = await requestWikiSearch(ctx, query)
  return items.length ? getWikiDetail(ctx, items[0].title, items[0].url) : null
}

// 获取Wiki词条详细内容
export async function getWikiDetail(ctx: Context, title: string, url?: string): Promise<Result | null> {
  try {
    ctx.logger.info(`[Wiki] 获取词条详情: ${title}`)
    url = url || `${WIKI_BASE_URL}${encodeURIComponent(title.replace(/ /g, '_'))}`
    const apiExtract = await requestWikiExtract(ctx, title)

    // 创建基本结果对象
    const result: Result = {
      title,
      url,
      content: apiExtract || '暂无简介',
      source: 'wiki'
    }

    try {
      // 尝试获取完整内容
      const fullContent = await fetchPageContent(ctx, url, extractWikiContent)
      if (fullContent) {
        result.content = fullContent
        ctx.logger.info(`[Wiki] 已获取Wiki完整内容，长度: ${fullContent.length}字符`)
      }
    } catch (error) {
      ctx.logger.warn(`[Wiki] 获取完整内容失败: ${error.message}`)
    }

    return result
  } catch (error) {
    ctx.logger.error(`[Wiki] 获取词条详情失败: ${error.message}`)
    return null
  }
}

// 提取Wiki页面详细内容
export async function extractWikiContent(page): Promise<string | null> {
  try {
    await page.waitForSelector('.mw-parser-output', { timeout: 10000 })

    return await page.evaluate(() => {
      const contentElement = document.querySelector('.mw-parser-output')
      if (!contentElement) return null

      const title = document.querySelector('.mw-page-title-main')?.textContent || document.querySelector('h1')?.textContent || ''
      let result = title ? `《${title}》\n\n` : ''

      // 处理元素
      const elements = Array.from(contentElement.children)

      // 需要跳过的元素类名
      const skipClasses = ['toc', 'navbox', 'infobox', 'noprint']

      for (const element of elements) {
        if (skipClasses.some(cls => element.classList.contains(cls)) || element.id === 'toc') {
          continue
        }

        const tagName = element.tagName.toLowerCase()

        // 处理标题
        if (tagName.match(/^h[2-6]$/)) {
          const headingText = element.textContent?.replace(/\[\w+\]/g, '').trim() || ''
          if (headingText) {
            result += `\n\n【${headingText}】\n`
          }
        }
        // 处理段落
        else if (tagName === 'p') {
          const paragraphText = element.textContent?.trim() || ''
          if (paragraphText) {
            result += `\n${paragraphText.replace(/\[\d+\]/g, '')}`
          }
        }
        // 处理列表
        else if (tagName === 'ul' || tagName === 'ol') {
          const listItems = Array.from(element.querySelectorAll('li'))
          for (const item of listItems) {
            const itemText = item.textContent?.trim().replace(/\[\d+\]/g, '') || ''
            if (itemText) {
              result += `\n• ${itemText}`
            }
          }
        }
        // 处理表格
        else if (tagName === 'table') {
          const caption = element.querySelector('caption')?.textContent?.trim()
          result += caption ? `\n\n【表格：${caption}】` : '\n\n【表格内容】'
        }
      }

      return result.replace(/\n{3,}/g, '\n\n').trim()
    })
  } catch (error) {
    console.error('提取Wiki内容失败:', error)
    return null
  }
}

// 搜索Wiki并返回多个结果
export async function searchWikiList(ctx: Context, query: string): Promise<SearchResults> {
  const result = await requestWikiSearch(ctx, query)
  return {
    ...result,
    query,
  }
}

// 注册wiki搜索命令
export function registerWiki(ctx: Context, mc: Command, config?: Config) {
  const wiki = mc.subcommand('.wiki <query:text>', '查询Minecraft Wiki词条')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要查询的内容'

      const result = await searchWiki(ctx, query)
      if (!result) return '未找到相关Wiki词条'

      return sendContent(session, {
        type: 'detail',
        title: result.title,
        source: result.source,
        content: result,
        options: { mode: parseMode(options, config) }
      })
    })

  wiki.subcommand('.search <query:text>', '搜索Minecraft Wiki显示多个结果')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .option('excerpt', '-e', { fallback: true })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要搜索的内容'

      const searchResults = await searchWikiList(ctx, query)
      if (!searchResults.items.length) return '未找到相关Wiki词条'

      return sendContent(session, {
        type: 'list',
        title: `Wiki搜索：${query}`,
        source: 'wiki' as ContentSource,
        content: searchResults,
        options: {
          mode: parseMode(options, config),
          showExcerpt: options.excerpt !== false
        }
      })
    })
}
