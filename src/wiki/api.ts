import { Context } from 'koishi'
import { SearchResultItem, ContentSource, CONTENT_SOURCES } from './utils'

// API端点
const WIKI_API_ENDPOINT = 'https://zh.minecraft.wiki/api.php'
const WIKI_BASE_URL = 'https://zh.minecraft.wiki/w/'
const MCMOD_SEARCH_URL = 'https://search.mcmod.cn/s'

// 添加新API端点（将来使用）
const CURSEFORGE_API_ENDPOINT = 'https://api.curseforge.com/v1'
const MODRINTH_API_ENDPOINT = 'https://api.modrinth.com/v2'

// 通用请求头
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

// 请求头扩展配置
const SOURCE_HEADERS = {
  curseforge: {
    'x-api-key': '${CURSEFORGE_API_KEY}'
  }
}

/**
 * 通用HTTP请求函数，处理重试和错误
 */
export async function safeRequest(ctx: Context, url: string, params = {}, options = {}, source?: ContentSource): Promise<any> {
  const maxRetries = 2

  // 添加源特定的请求头
  const headers = { ...DEFAULT_HEADERS }
  if (source && SOURCE_HEADERS[source]) {
    Object.assign(headers, SOURCE_HEADERS[source])
  }

  const requestOptions = {
    timeout: 15000,
    ...options,
    headers,
    params
  }

  // 记录完整URL
  const queryParams = new URLSearchParams(params as Record<string, string>).toString()
  const fullUrl = queryParams ? `${url}?${queryParams}` : url
  ctx.logger.info(`发起请求: ${fullUrl}`)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ctx.http.get(url, requestOptions)
      ctx.logger.info(`请求成功，响应数据大小: ${
        typeof response === 'object' ? JSON.stringify(response).length : response.length
      } 字节`)
      return response
    } catch (error) {
      ctx.logger.warn(`请求失败(${attempt}/${maxRetries}): ${error.message}`)
      if (error.response?.data) return error.response.data
      if (attempt === maxRetries) throw error
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

/**
 * 通用网页内容爬取函数
 */
export async function fetchPageContent(
  ctx: Context,
  url: string,
  extractorFn?: (page: any) => Promise<string | null>
): Promise<string | null> {
  if (!ctx.puppeteer) {
    ctx.logger.warn('爬取页面内容需要puppeteer服务')
    return null
  }

  let page = null

  try {
    ctx.logger.info(`开始爬取页面内容: ${url}`)
    page = await ctx.puppeteer.page()

    // 设置请求超时和页面加载超时
    await page.setDefaultNavigationTimeout(20000)
    await page.setUserAgent(DEFAULT_HEADERS['User-Agent'])

    // 加载页面
    await page.goto(url, { waitUntil: 'networkidle2' })

    // 使用提供的提取器函数或默认提取逻辑
    const content = extractorFn ?
      await extractorFn(page) :
      await page.evaluate(() => {
        const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('body')
        return article ? article.textContent : null
      })

    if (content && content.length > 0) {
      ctx.logger.info(`页面内容爬取成功，长度: ${content.length}字符`)
      return content
    }

    ctx.logger.warn('页面内容爬取成功，但未获取到有效内容')
    return null
  } catch (error) {
    ctx.logger.error(`爬取页面内容失败: ${error.message}`)
    return null
  } finally {
    if (page) await page.close()
  }
}

/**
 * 请求Minecraft Wiki API
 */
export async function requestWikiSearch(ctx: Context, query: string): Promise<{items: SearchResultItem[], total: number, queryUrl: string}> {
  const searchUrl = `${WIKI_API_ENDPOINT}?action=query&list=search&srsearch=${encodeURIComponent(query)}`
  ctx.logger.info(`[Wiki] 搜索: "${query}"`)

  try {
    const res = await safeRequest(ctx, WIKI_API_ENDPOINT, {
      action: 'query',
      list: 'search',
      srsearch: query,
      format: 'json',
      utf8: 1
    }, {}, 'wiki')

    const searchResults = res?.query?.search || []
    const total = res?.query?.searchinfo?.totalhits || 0

    if (!searchResults.length) {
      ctx.logger.info(`[Wiki] 未找到结果`)
      return { items: [], total: 0, queryUrl: searchUrl }
    }

    // 转换搜索结果
    const items: SearchResultItem[] = searchResults.map(hit => ({
      title: hit.title,
      url: `${WIKI_BASE_URL}${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
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

/**
 * 请求Wiki API获取词条摘要
 */
export async function requestWikiExtract(ctx: Context, title: string): Promise<string> {
  try {
    const pageRes = await safeRequest(ctx, WIKI_API_ENDPOINT, {
      action: 'query',
      prop: 'extracts',
      explaintext: true,
      titles: title,
      format: 'json',
      utf8: 1,
      exlimit: 1
    })

    if (pageRes?.query?.pages) {
      const pages = pageRes.query.pages
      const pageId = Object.keys(pages)[0]
      return pages[pageId]?.extract || '暂无内容'
    }

    return '暂无内容'
  } catch (error) {
    ctx.logger.error(`[Wiki] 获取词条摘要失败: ${error.message}`)
    return '获取摘要失败'
  }
}

/**
 * 请求MC百科搜索
 */
export async function requestMcmodSearch(ctx: Context, query: string): Promise<string> {
  const searchUrl = `${MCMOD_SEARCH_URL}?key=${encodeURIComponent(query)}&filter=0&site=1`
  ctx.logger.info(`[MCMod] 搜索: "${query}" - 请求链接: ${searchUrl}`)

  try {
    return await safeRequest(ctx, searchUrl, {}, { responseType: 'text' }, 'mcmod')
  } catch (error) {
    ctx.logger.error(`[MCMod] 搜索失败: ${error.message}`)
    throw error
  }
}

/**
 * 将来用于Curseforge搜索的API函数
 */
export async function requestCurseforgeSearch(ctx: Context, query: string): Promise<any> {
  ctx.logger.info(`[Curseforge] 搜索: "${query}"`)
  // 实现将在未来添加
  throw new Error('Curseforge API尚未实现')
}

/**
 * 将来用于Modrinth搜索的API函数
 */
export async function requestModrinthSearch(ctx: Context, query: string): Promise<any> {
  ctx.logger.info(`[Modrinth] 搜索: "${query}"`)
  // 实现将在未来添加
  throw new Error('Modrinth API尚未实现')
}
