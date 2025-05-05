import { Context, Command } from 'koishi'
import { render, parseMode, renderList, safeRequest, cleanText, Result, SearchResults } from './utils'
import { Config } from '../index'

/**
 * MCMod百科特有的文本清理函数
 */
function cleanMcmodText(text: string): string {
  return cleanText(text
    .replace(/\[\w+:[^]]*\]/g, '')
    .replace(/\[h\d=.*?\]/g, '')
    .replace(/\[.*?\]/g, '')
  )
}

/**
 * 规范化MCMOD链接
 */
function normalizeUrl(url: string): string {
  if (!url) return ''

  // 添加https前缀并确保使用HTTPS
  if (!url.startsWith('http')) url = 'https://' + url
  else if (url.startsWith('http:')) url = url.replace('http:', 'https:')

  // 过滤无效链接
  return url.includes('/class/category/') ? '' : url
}

/**
 * 从HTML中提取搜索结果
 */
async function parseMcmodResults(ctx: Context, query: string): Promise<{ results: Result[], total: number }> {
  const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&filter=0&site=1`
  ctx.logger.info(`[MCMod] 搜索: "${query}"`)
  ctx.logger.debug(`[MCMod] 请求链接: ${searchUrl}`)

  try {
    const html = await safeRequest(ctx, searchUrl, {}, { responseType: 'text' })

    // 提取总结果数
    const totalMatch = html.match(/找到约\s*(\d+)\s*条结果/i)
    const total = totalMatch ? parseInt(totalMatch[1]) : 0

    // 提取所有结果项
    const results: Result[] = []
    const resultRegex = /<div class="result-item">([\s\S]*?)<\/div>\s*<\/div>/g

    let match
    while ((match = resultRegex.exec(html)) !== null && results.length < 20) {
      const itemHtml = match[1]

      // 提取标题和URL
      const headMatch = itemHtml.match(/<div class="head">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!headMatch) continue

      const url = normalizeUrl(headMatch[1])
      if (!url) continue

      const title = cleanMcmodText(headMatch[2].replace(/<[^>]*>/g, ''))

      // 提取正文内容
      const bodyMatch = itemHtml.match(/<div class="body">([\s\S]*?)<\/div>/i)
      const bodyHtml = bodyMatch ? bodyMatch[1] : ''
      const extract = cleanMcmodText(bodyHtml.replace(/<em>(.*?)<\/em>/g, '$1').replace(/<[^>]*>/g, ''))

      results.push({ title, url, extract, source: 'mcmod' })
    }

    ctx.logger.info(`[MCMod] 搜索成功，找到 ${results.length} 条结果`)
    if (results.length > 0) {
      ctx.logger.debug(`[MCMod] 第一条结果: ${results[0].title} - ${results[0].url}`)
      const excerpt = results[0].extract.substring(0, 100) + '...'
      ctx.logger.debug(`[MCMod] 内容概览: ${excerpt}`)
    }

    return { results, total }
  } catch (error) {
    ctx.logger.error(`[MCMod] 搜索失败: ${error.message}`)
    return { results: [], total: 0 }
  }
}

// 搜索MCMOD百科并返回第一个结果
export async function searchMcmod(ctx: Context, query: string): Promise<Result | null> {
  const { results } = await parseMcmodResults(ctx, query)
  return results.length > 0 ? results[0] : null
}

// 搜索MCMOD百科并返回多个结果
export async function searchMcmodList(ctx: Context, query: string): Promise<SearchResults> {
  const { results, total } = await parseMcmodResults(ctx, query)
  return { query, total, results }
}

// 注册MCMOD搜索命令
export function registerMod(ctx: Context, mc: Command, config?: Config) {
  // 主命令：查询单个结果
  const mod = mc.subcommand('.mod <query:text>', '查询MC百科词条')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要查询的内容'
      const result = await searchMcmod(ctx, query)
      return render(ctx, session, result, parseMode(options, config))
    })

  // 子命令：搜索多个结果
  mod.subcommand('.search <query:text>', '搜索MC百科显示多个结果')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要搜索的内容'
      const searchResults = await searchMcmodList(ctx, query)
      return searchResults.results.length === 0
        ? '未找到相关百科词条'
        : renderList(session, searchResults, parseMode(options, config))
    })
}
