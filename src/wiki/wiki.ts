import { Context, Command } from 'koishi'
import { render, parseMode, renderList, safeRequest, fetchPageContent, Result, SearchResults } from './utils'
import { Config } from '../index'

// 定义常量
const API_ENDPOINT = 'https://zh.minecraft.wiki/api.php'
const BASE_URL = 'https://zh.minecraft.wiki/w/'

/**
 * 提取Wiki页面详细内容
 */
export async function extractWikiContent(page): Promise<string | null> {
  try {
    // 等待内容加载
    await page.waitForSelector('.mw-parser-output', { timeout: 10000 })

    // 使用评估来提取并格式化内容
    const content = await page.evaluate(() => {
      // 页面主要内容容器
      const contentElement = document.querySelector('.mw-parser-output')
      if (!contentElement) return null

      // 提取标题
      const title = document.querySelector('.mw-page-title-main')?.textContent || document.querySelector('h1')?.textContent || ''

      // 构建结果内容，以标题开始
      let result = title ? `《${title}》\n\n` : ''

      // 获取所有段落和标题
      const elements = Array.from(contentElement.children)

      // 处理每个元素
      for (const element of elements) {
        // 跳过目录、导航箱、信息框等不需要的元素
        if (element.classList.contains('toc') ||
            element.classList.contains('navbox') ||
            element.classList.contains('infobox') ||
            element.classList.contains('noprint') ||
            element.id === 'toc') {
          continue
        }

        // 处理不同类型的元素
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
            // 去除参考文献标记 [1], [2] 等
            const cleanText = paragraphText.replace(/\[\d+\]/g, '')
            result += `\n${cleanText}`
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
        // 处理表格(简化为文本)
        else if (tagName === 'table') {
          const caption = element.querySelector('caption')?.textContent?.trim()
          if (caption) {
            result += `\n\n【表格：${caption}】`
          } else {
            result += '\n\n【表格内容】'
          }
          // 这里可以进一步处理表格内容，但为简化起见，我们只添加表格标题
        }
      }

      // 清理多余空行和空格
      return result
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })

    return content
  } catch (error) {
    console.error('提取Wiki内容失败:', error)
    return null
  }
}

// 基础Wiki API请求函数
async function wikiRequest(ctx: Context, query: string, getExtract = false): Promise<any> {
  ctx.logger.info(`[Wiki] 搜索: "${query}"`)
  ctx.logger.info(`[Wiki] 请求链接: ${API_ENDPOINT}?action=query&list=search&srsearch=${encodeURIComponent(query)}`)

  try {
    // 搜索请求
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
      return { results: [], total }
    }

    // 转换搜索结果
    const results = searchResults.map(hit => {
      const title = hit.title
      const url = `${BASE_URL}${encodeURIComponent(title.replace(/ /g, '_'))}`
      ctx.logger.info(`[Wiki] 生成链接: ${url} (标题: ${title})`)
      const snippet = hit.snippet?.replace(/<\/?span[^>]*>/g, '').replace(/<\/?searchmatch>/g, '') || ''
      return { title, url, extract: snippet, source: 'wiki' }
    })

    ctx.logger.info(`[Wiki] 搜索成功，找到 ${results.length} 条结果`)
    if (results.length > 0) {
      ctx.logger.info(`[Wiki] 第一条结果: ${results[0].title} - ${results[0].url}`)
    }

    // 如果需要获取第一个结果的详细内容，只获取API摘要，完整内容由render函数统一处理
    if (getExtract && results.length > 0) {
      try {
        const pageTitle = results[0].title
        ctx.logger.info(`[Wiki] 获取API摘要: ${pageTitle}`)

        // 通过API获取摘要
        const pageRes = await safeRequest(ctx, API_ENDPOINT, {
          action: 'query',
          prop: 'extracts',
          explaintext: true,
          titles: pageTitle,
          format: 'json',
          utf8: 1,
          exlimit: 1
        })

        if (pageRes?.query?.pages) {
          const pages = pageRes.query.pages
          const pageId = Object.keys(pages)[0]
          results[0].extract = pages[pageId]?.extract || '暂无内容'
          const excerpt = results[0].extract.substring(0, 100) + '...'
          ctx.logger.info(`[Wiki] API摘要获取成功: ${excerpt}`)
        }
      } catch (error) {
        ctx.logger.warn(`[Wiki] 获取API摘要失败: ${error.message}`)
      }
    }

    return { results, total }
  } catch (error) {
    ctx.logger.error(`[Wiki] 搜索失败: ${error.message}`)
    return { results: [], total: 0 }
  }
}

// 搜索Minecraft维基并返回结果
export async function searchWiki(ctx: Context, query: string): Promise<Result | null> {
  const { results } = await wikiRequest(ctx, query, true)

  // 如果有结果但没有完整内容，尝试获取
  if (results.length > 0 && !results[0].fullContent) {
    try {
      const fullContent = await fetchPageContent(ctx, results[0].url, extractWikiContent)
      if (fullContent) {
        results[0].extract = fullContent
        results[0].fullContent = true
        ctx.logger.info(`[Wiki] 已获取Wiki完整内容，长度: ${fullContent.length}字符`)
      }
    } catch (error) {
      ctx.logger.warn(`[Wiki] 获取完整内容失败: ${error.message}`)
    }
  }

  return results.length > 0 ? results[0] : null
}

// 搜索Minecraft维基并返回多个结果
export async function searchWikiList(ctx: Context, query: string): Promise<SearchResults> {
  const { results, total } = await wikiRequest(ctx, query)
  return { query, total, results }
}

// 注册wiki搜索命令
export function registerWiki(ctx: Context, mc: Command, config?: Config) {
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
      if (searchResults.results.length === 0) return '未找到相关Wiki词条'

      // 使用更新后的 renderList，支持摘要显示选项
      return renderList(
        session,
        searchResults,
        parseMode(options, config),
        { showExcerpt: options.excerpt !== false }
      )
    })
}
