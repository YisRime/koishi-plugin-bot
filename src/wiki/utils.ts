import { Context, Session, segment } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'

export type OutputMode = 'text' | 'fwd' | 'shot'

// 内容类型枚举
export enum ContentType {
  TEXT = 'text',
  FULL_EXTRACT = 'full_extract'
}

// 表示内容的接口
export interface Content {
  type: ContentType;
  value: string;
}

// 表示单个词条的详细内容
export interface Result {
  title: string;
  url: string;
  contents: Content[];  // 使用内容数组
  source: string;   // 来源：'wiki' 或 'mcmod'
  apiExtract?: string; // 可选的API摘要
}

// 表示搜索结果列表中的单项
export interface SearchResultItem {
  title: string;
  url: string;
  excerpt: string;   // 摘要内容
  source: string;    // 来源：'wiki' 或 'mcmod'
  category?: string; // 可选的分类信息
}

// 表示搜索结果列表
export interface SearchResults {
  query: string;
  queryUrl: string;
  total: number;
  items: SearchResultItem[]; // 使用专门的搜索结果项
}

/**
 * 通用HTTP请求函数，处理重试和错误
 */
export async function safeRequest(ctx: Context, url: string, params = {}, options = {}): Promise<any> {
  const maxRetries = 2
  const requestOptions = {
    timeout: 15000,
    ...options,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
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

  try {
    ctx.logger.info(`开始爬取页面内容: ${url}`)
    const page = await ctx.puppeteer.page()

    // 设置请求超时和页面加载超时
    await page.setDefaultNavigationTimeout(20000)

    // 设置用户代理，模拟正常浏览器
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 加载页面
    await page.goto(url, { waitUntil: 'networkidle2' })

    let content: string | null = null

    // 如果提供了自定义提取器函数，则使用它
    if (extractorFn) {
      content = await extractorFn(page)
    } else {
      // 默认的通用提取逻辑
      content = await page.evaluate(() => {
        const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('body')
        return article ? article.textContent : null
      })
    }

    await page.close()

    if (content && content.length > 0) {
      ctx.logger.info(`页面内容爬取成功，长度: ${content.length}字符`)
      return content
    }

    ctx.logger.warn('页面内容爬取成功，但未获取到有效内容')
    return null
  } catch (error) {
    ctx.logger.error(`爬取页面内容失败: ${error.message}`)
    return null
  }
}

/**
 * 从Result中获取内容
 */
function getContent(result: Result): string {
  const fullContent = result.contents.find(c => c.type === ContentType.FULL_EXTRACT);
  const textContent = result.contents.find(c => c.type === ContentType.TEXT);

  return fullContent?.value || textContent?.value || result.apiExtract || '暂无简介';
}

/**
 * 处理并输出搜索结果
 */
export async function render(ctx: Context, session: Session, result: Result | null, mode: OutputMode = 'fwd'): Promise<any> {
  if (!result) return '未找到相关词条'

  ctx.logger.info(`渲染 "${result.title}" (模式: ${mode})`)

  // 获取内容
  let extract = getContent(result);

  // 如果没有内容，尝试爬取
  if (!extract) {
    ctx.logger.info(`尝试获取完整内容: ${result.url}`)
    const fullContent = await fetchPageContent(ctx, result.url)

    if (fullContent) {
      result.contents.push({
        type: ContentType.FULL_EXTRACT,
        value: fullContent
      });
      extract = fullContent;
    }
  }

  try {
    // 按优先级尝试不同渲染模式
    if (mode === 'shot') {
      const output = await renderShot(ctx, result)
      if (output) return output;
      mode = 'fwd'
      ctx.logger.info('截图失败，回退到合并转发')
    }

    if (mode === 'fwd') {
      const output = await renderFwd(ctx, session, result)
      if (output !== null) return output;
      mode = 'text'
      ctx.logger.info('合并转发失败，回退到文本')
    }

    // 默认使用文本模式
    return await renderText(ctx, session, result)
  } catch (error) {
    ctx.logger.error(`渲染失败: ${error.message}`)
    return `${result.title}\n\n查看更多: ${result.url}`
  }
}

/**
 * 智能分割文本 - 无字数限制
 */
function smartTextSplit(text: string): string[] {
  if (!text) return [text]

  // 按自然段落分割
  const paragraphs = text.split(/\n\n+/)

  // 如果段落很少，直接返回
  if (paragraphs.length <= 5) return [text]

  // 否则按更合理的方式组织段落
  const segments = []
  let currentSegment = ''

  paragraphs.forEach(paragraph => {
    if (currentSegment.length + paragraph.length > 4000) { // 预防极端情况的极限
      segments.push(currentSegment)
      currentSegment = paragraph
    } else {
      currentSegment += (currentSegment ? '\n\n' : '') + paragraph
    }
  })

  if (currentSegment) {
    segments.push(currentSegment)
  }

  return segments.length ? segments : [text]
}

/**
 * 文本输出模式
 */
export async function renderText(ctx: Context, session: Session, result: Result): Promise<string | string[]> {
  const extract = getContent(result);
  const segments = smartTextSplit(extract)
  const messages = [`${result.title}\n\n${segments[0]}`]

  // 中间段落
  for (let i = 1; i < segments.length - 1; i++) {
    messages.push(segments[i])
  }

  // 最后部分加上URL
  if (segments.length > 1) {
    messages.push(`${segments[segments.length - 1]}\n\n查看更多: ${result.url}`)
  } else {
    messages[0] += `\n\n查看更多: ${result.url}`
  }

  try {
    // 分段发送
    for (let i = 0; i < messages.length - 1; i++) {
      await session.send(messages[i])
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return messages[messages.length - 1]
  } catch (error) {
    ctx.logger.error(`分段消息发送失败: ${error.message}`)
    return messages[0]
  }
}

/**
 * 合并转发输出模式
 */
export async function renderFwd(ctx: Context, session: Session, result: Result): Promise<any> {
  if (session.platform !== 'onebot') return null;

  const onebot = session.bot
  if (!onebot) return null

  try {
    const srcName = result.source === 'wiki' ? 'Minecraft Wiki' : 'MC百科'
    const extract = getContent(result);
    const segments = smartTextSplit(extract);

    // 构造合并转发消息节点
    const fwdMsgs = [
      { type: 'node', data: { name: srcName, uin: session.selfId || '10000', content: result.title } },
      ...segments.map(text => ({
        type: 'node',
        data: { name: srcName, uin: session.selfId || '10000', content: text }
      })),
      { type: 'node', data: { name: srcName, uin: session.selfId || '10000', content: `查看更多: ${result.url}` } }
    ]

    // 根据会话类型发送
    if (session.guildId) {
      await onebot.internal.sendGroupForwardMsg(session.guildId, fwdMsgs)
    } else if (session.userId) {
      await onebot.internal.sendPrivateForwardMsg(session.userId, fwdMsgs)
    } else {
      return null
    }

    return ''
  } catch (error) {
    ctx.logger.error(`合并转发失败: ${error.message}`)
    return null
  }
}

/**
 * 网页截图输出模式
 */
export async function renderShot(ctx: Context, result: Result): Promise<any> {
  if (!ctx.puppeteer) return null;

  try {
    const page = await ctx.puppeteer.page()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1.5 })

    ctx.logger.info(`开始加载页面: ${result.url}`)
    await page.goto(result.url, { waitUntil: 'networkidle0' })

    // 选择内容区域
    const contentSelector = result.source === 'wiki' ? '#content' : '#app'
    await page.waitForSelector(contentSelector, { timeout: 8000 })

    // 优化页面显示
    await page.evaluate((source) => {
      // 移除不需要的元素
      const removeSelectors = source === 'wiki'
        ? ['#mw-navigation', '#footer', '.noprint', '#siteNotice', '.printfooter', '#catlinks']
        : ['#header', '#footer', '.links', '.ad-box', '.declare']

      removeSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })

      // 添加自定义样式
      document.head.insertAdjacentHTML('beforeend', `
        <style>
          body { max-width: 1200px; margin: 0 auto; padding: 1em; }
          #content { padding: 1em; background: #fff; }
          h1, h2 { margin-top: 0.5em !important; }
        </style>
      `)
    }, result.source)

    // 获取内容区域并截图
    const rect = await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const {x, y, width, height} = element.getBoundingClientRect()
      return {x, y, width, height}
    }, contentSelector)

    if (!rect) throw new Error('无法获取内容区域尺寸')

    const shot = await page.screenshot({
      type: 'png',
      clip: {
        x: rect.x,
        y: rect.y,
        width: Math.min(rect.width, 1200),
        height: Math.min(rect.height, 15000)
      }
    })

    await page.close()
    return [segment.image(shot, 'image/png'), `查看更多: ${result.url}`]
  } catch (error) {
    ctx.logger.error(`截图失败: ${error.message}`)
    return null
  }
}

/**
 * 解析输出模式
 */
export function parseMode(options, config?: { outputMode?: OutputMode }): OutputMode {
  if (!options.visual) return config?.outputMode || 'fwd'

  const modeMap = {
    't': 'text', 'text': 'text',
    's': 'shot', 'shot': 'shot', 'screenshot': 'shot',
    'f': 'fwd', 'fwd': 'fwd', 'forward': 'fwd'
  }

  return modeMap[options.visual.toLowerCase()] || config?.outputMode || 'fwd'
}

/**
 * 渲染搜索结果列表
 */
export async function renderList(
  session: Session,
  searchResults: SearchResults,
  mode: OutputMode = 'text',
  options: { showExcerpt?: boolean } = { showExcerpt: true }
): Promise<any> {
  if (!searchResults?.items?.length) return '未找到相关词条'

  // 过滤掉无效链接的结果
  const validResults = searchResults.items.filter(item => item.url && item.title)
  if (!validResults.length) return '未找到有效的搜索结果'

  const logger = session.app.logger;
  const sourceName = validResults[0].source.toUpperCase();
  logger?.info(`[${sourceName}] 生成搜索结果列表，共 ${validResults.length} 项`);

  // 生成列表文本
  const listText = validResults.map((item, i) => {
    const displayTitle = item.title.trim() || '未命名词条'

    // 提取分类信息
    let categoryInfo = ''
    if (item.category) {
      categoryInfo = `[${item.category}] `
    }

    // 基础格式
    let itemText = `${i + 1}. ${categoryInfo}${displayTitle}\n   ${item.url}`

    // 添加摘要
    if (options.showExcerpt && item.excerpt) {
      const cleanExcerpt = item.excerpt.split('\n\n')[0].substring(0, 100) + (item.excerpt.length > 100 ? '...' : '');
      itemText += `\n   ${cleanExcerpt}`
    }

    return itemText
  }).join('\n\n')

  const sourceName2 = validResults[0].source === 'wiki' ? 'Minecraft Wiki' : 'MC百科'
  const promptText = `找到 ${searchResults.total || validResults.length} 条相关词条，请回复数字选择查看详情：`

  // 发送函数
  const sendList = async () => {
    await session.send(promptText)
    await session.send(listText)
  }

  // 选择显示方式
  if (mode === 'fwd' && session.platform === 'onebot') {
    try {
      const fwdMsgs = [
        { type: 'node', data: { name: `${sourceName2}搜索`, uin: session.selfId || '10000', content: promptText } },
        { type: 'node', data: { name: `${sourceName2}搜索`, uin: session.selfId || '10000', content: listText } }
      ]

      const onebot = session.bot
      if (onebot) {
        if (session.guildId) {
          await onebot.internal.sendGroupForwardMsg(session.guildId, fwdMsgs)
        } else if (session.userId) {
          await onebot.internal.sendPrivateForwardMsg(session.userId, fwdMsgs)
        } else {
          await sendList()
        }
      } else {
        await sendList()
      }
    } catch (error) {
      logger?.warn(`[${sourceName}] 合并转发失败: ${error.message}`)
      await sendList()
    }
  } else {
    await sendList()
  }

  // 等待用户选择
  try {
    const response = await session.prompt(30 * 1000)
    const selection = parseInt(response)

    if (isNaN(selection) || selection < 1 || selection > validResults.length) {
      return '选择无效，已取消查询'
    }

    // 获取用户选择的结果
    const selectedItem = validResults[selection - 1]
    const source = selectedItem.source

    // 根据源获取详细内容
    try {
      const app = session.app
      let result: Result | null = null

      // 直接调用对应函数获取详情
      if (source === 'wiki') {
        // 动态导入避免循环依赖
        const wikiModule = await import('./wiki')
        if (!wikiModule.getWikiDetail) {
          throw new Error('Wiki详情获取函数未定义')
        }
        result = await wikiModule.getWikiDetail(app, selectedItem.title, selectedItem.url)
      }
      else if (source === 'mcmod') {
        // 动态导入避免循环依赖
        const mcmodModule = await import('./mcmod')
        if (!mcmodModule.getMcmodDetail) {
          throw new Error('MC百科详情获取函数未定义')
        }
        result = await mcmodModule.getMcmodDetail(app, selectedItem.title, selectedItem.url)
      }
      else {
        throw new Error(`不支持的内容源：${source}`)
      }

      if (!result) {
        throw new Error(`获取${source === 'wiki' ? 'Wiki' : 'MC百科'}详情失败`)
      }

      return render(app, session, result, mode)
    } catch (error) {
      session.app.logger?.error(`[Detail] 获取详情失败: ${error.message}`)
      return `获取详情失败: ${error.message}`
    }
  } catch {
    return '查询已超时或被取消'
  }
}

/**
 * 清理提取的文本内容 - 通用版本
 */
export function cleanText(text: string): string {
  return text
    // 替换HTML实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // 替换连续的空白字符为单个空格
    .replace(/\s+/g, ' ')
    .trim()
}
