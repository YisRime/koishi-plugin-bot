import { Context, Command } from 'koishi'
import { render, parseMode, renderList, safeRequest, fetchPageContent, Result, SearchResults, ContentType, SearchResultItem } from './utils'
import { Config } from '../index'

// 定义常量
const API_ENDPOINT = 'https://zh.minecraft.wiki/api.php'
const BASE_URL = 'https://zh.minecraft.wiki/w/'

/**
 * 提取Wiki页面详细内容
 */
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

// 基础Wiki API请求函数
async function wikiRequest(ctx: Context, query: string): Promise<{items: SearchResultItem[], total: number, queryUrl: string}> {
  const searchUrl = `${API_ENDPOINT}?action=query&list=search&srsearch=${encodeURIComponent(query)}`
  ctx.logger.info(`[Wiki] 搜索: "${query}"`)

  try {
    const res = await safeRequest(ctx, API_ENDPOINT, {
      action: 'query',
      list: 'search',
      srsearch: query,
      format: 'json',
      utf8: 1
    })

    const searchResults = res?.query?.search || []
    const total = res?.query?.searchinfo?.totalhits || 0

    if (!searchResults.length) {
      ctx.logger.info(`[Wiki] 未找到结果`)
      return { items: [], total: 0, queryUrl: searchUrl }
    }

    // 转换搜索结果
    const items: SearchResultItem[] = searchResults.map(hit => ({
      title: hit.title,
      url: `${BASE_URL}${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      excerpt: hit.snippet?.replace(/<\/?span[^>]*>/g, '').replace(/<\/?searchmatch>/g, '') || '',
      source: 'wiki'
    }))

    ctx.logger.info(`[Wiki] 搜索成功，找到 ${items.length} 条结果`)
    return { items, total, queryUrl: searchUrl }
  } catch (error) {
    ctx.logger.error(`[Wiki] 搜索失败: ${error.message}`)
    return { items: [], total: 0, queryUrl: searchUrl }
  }
}

// 搜索Minecraft维基并返回结果
export async function searchWiki(ctx: Context, query: string): Promise<Result | null> {
  const { items } = await wikiRequest(ctx, query)

  if (items.length > 0) {
    return await getWikiDetail(ctx, items[0].title, items[0].url)
  }

  return null
}

// 获取Wiki词条详细内容
export async function getWikiDetail(ctx: Context, title: string, url?: string): Promise<Result | null> {
  try {
    ctx.logger.info(`[Wiki] 获取词条详情: ${title}`)

    // 如果没有提供URL，则构建URL
    if (!url) {
      url = `${BASE_URL}${encodeURIComponent(title.replace(/ /g, '_'))}`
    }

    // 先获取API摘要
    const pageRes = await safeRequest(ctx, API_ENDPOINT, {
      action: 'query',
      prop: 'extracts',
      explaintext: true,
      titles: title,
      format: 'json',
      utf8: 1,
      exlimit: 1
    })

    let apiExtract = ''
    if (pageRes?.query?.pages) {
      const pages = pageRes.query.pages
      const pageId = Object.keys(pages)[0]
      apiExtract = pages[pageId]?.extract || '暂无内容'
    }

    // 创建结果对象
    const result: Result = {
      title,
      url,
      contents: [{
        type: ContentType.TEXT,
        value: apiExtract
      }],
      source: 'wiki',
      apiExtract
    }

    // 获取完整内容
    try {
      const fullContent = await fetchPageContent(ctx, url, extractWikiContent)
      if (fullContent) {
        result.contents.push({
          type: ContentType.FULL_EXTRACT,
          value: fullContent
        })
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

// 搜索Minecraft维基并返回多个结果
export async function searchWikiList(ctx: Context, query: string): Promise<SearchResults> {
  const { items, total, queryUrl } = await wikiRequest(ctx, query)
  return { query, queryUrl, total, items }
}

// 注册wiki搜索命令
export function registerWiki(ctx: Context, mc: Command, config?: Config) {
  // 提供方法给其他模块调用
  ctx.provide('wiki_getDetail', (title: string, url?: string) => getWikiDetail(ctx, title, url))

  // 主命令：查询单个结果
  const wiki = mc.subcommand('.wiki <query:text>', '查询Minecraft Wiki词条')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要查询的内容'
      const result = await searchWiki(ctx, query)
      return render(ctx, session, result, parseMode(options, config))
    })

  // 子命令：搜索多个结果
  wiki.subcommand('.search <query:text>', '搜索Minecraft Wiki显示多个结果')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .option('excerpt', '-e', { fallback: true })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要搜索的内容'
      const searchResults = await searchWikiList(ctx, query)
      if (searchResults.items.length === 0) return '未找到相关Wiki词条'

      return renderList(
        session,
        searchResults,
        parseMode(options, config),
        { showExcerpt: options.excerpt !== false }
      )
    })
}
