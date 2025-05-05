import { Context, Command } from 'koishi'
import { render, parseMode, renderList, safeRequest, Result, SearchResults } from './utils'
import { Config } from '../index'

// 定义常量
const API_ENDPOINT = 'https://zh.minecraft.wiki/api.php'
const BASE_URL = 'https://zh.minecraft.wiki/w/'

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

    // 如果需要获取第一个结果的详细内容
    if (getExtract && results.length > 0) {
      try {
        const pageTitle = results[0].title
        ctx.logger.info(`[Wiki] 获取详细内容: ${pageTitle}`)

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
          ctx.logger.info(`[Wiki] 内容概览: ${excerpt}`)
        }
      } catch (error) {
        ctx.logger.warn(`[Wiki] 获取内容失败: ${error.message}`)
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
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要搜索的内容'
      const searchResults = await searchWikiList(ctx, query)
      return searchResults.results.length === 0
        ? '未找到相关Wiki词条'
        : renderList(session, searchResults, parseMode(options, config))
    })
}
