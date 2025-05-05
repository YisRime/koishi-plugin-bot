import { Context, Session, segment } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'

export type OutputMode = 'text' | 'fwd' | 'shot'

// 表示单个词条的详细内容
export interface Result {
  title: string
  url: string
  extract?: string
  source: string
}

// 表示搜索结果列表
export interface SearchResults {
  query: string
  total: number
  results: Result[]
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
      // 记录响应概览
      if (typeof response === 'object') {
        ctx.logger.info(`响应数据: ${JSON.stringify(response).substring(0, 100)}...`)
      } else if (typeof response === 'string') {
        ctx.logger.info(`响应长度: ${response.length}字节, 前100字符: ${response.substring(0, 100)}...`)
      }
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
 * 处理并输出搜索结果
 */
export async function render(ctx: Context, session: Session, result: Result | null, mode: OutputMode = 'fwd'): Promise<any> {
  if (!result) return '未找到相关词条'

  ctx.logger.info(`渲染 "${result.title}" (模式: ${mode})`)
  ctx.logger.info(`渲染链接: ${result.url}`)

  // 记录链接来源
  if (result.source === 'wiki') {
    ctx.logger.info(`[Wiki] 使用链接: ${result.url}`)
  } else if (result.source === 'mcmod') {
    ctx.logger.info(`[MCMod] 使用链接: ${result.url}`)
  }

  if (result.extract) {
    const excerpt = result.extract.substring(0, 100) + (result.extract.length > 100 ? '...' : '')
    ctx.logger.info(`内容概览: ${excerpt}`)
  }

  try {
    // 按优先级尝试不同渲染模式
    if (mode === 'shot') {
      ctx.logger.info(`尝试截图模式获取: ${result.url}`)
      const output = await renderShot(ctx, result)
      if (output) {
        ctx.logger.info('截图渲染成功')
        return output
      }
      mode = 'fwd'
      ctx.logger.info('截图失败，回退到合并转发')
    }

    if (mode === 'fwd') {
      const output = await renderFwd(ctx, session, result)
      if (output !== null) {
        ctx.logger.info('合并转发渲染成功')
        return output
      }
      mode = 'text'
      ctx.logger.info('合并转发失败，回退到文本')
    }

    // 默认使用文本模式
    const output = await renderText(ctx, session, result)
    ctx.logger.info(`文本渲染完成`)
    return output
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
  const extract = result.extract || '暂无简介'
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
  if (session.platform !== 'onebot') {
    ctx.logger.info(`非OneBot平台(${session.platform})，不支持合并转发`)
    return null
  }

  const onebot = session.bot
  if (!onebot) return null

  try {
    const srcName = result.source === 'wiki' ? 'Minecraft Wiki' : 'MC百科'
    const segments = smartTextSplit(result.extract || '暂无简介')

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
  if (!ctx.puppeteer) {
    ctx.logger.warn('截图服务不可用')
    return null
  }

  try {
    const page = await ctx.puppeteer.page()
    // 设置高清截图
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1.5 })

    // 加载页面
    ctx.logger.info(`开始加载页面: ${result.url}`)
    ctx.logger.info(`[${result.source.toUpperCase()}] 请求截图: ${result.url}`)
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
  mode: OutputMode = 'text'
): Promise<any> {
  if (!searchResults?.results?.length) return '未找到相关词条'

  // 过滤掉无效链接的结果
  const validResults = searchResults.results.filter(result => result.url && result.title);

  if (session.app.logger && validResults.length > 0) {
    const logger = session.app.logger
    logger.info(`[${validResults[0].source.toUpperCase()}] 生成搜索结果列表，共 ${validResults.length} 项`)
    validResults.forEach((result, i) => {
      logger.info(`[${result.source.toUpperCase()}] 列表项 ${i+1}: ${result.title} - ${result.url}`)
    })
  }

  if (!validResults.length) return '未找到有效的搜索结果'

  // 生成所有结果的列表，优化显示格式
  const listText = validResults.map((result, i) => {
    // 确保标题和URL都正确显示，如果标题为空则显示"未命名"
    const displayTitle = result.title.trim() || '未命名词条';
    return `${i + 1}. ${displayTitle}\n   ${result.url}`;
  }).join('\n\n')

  const promptText = `找到 ${searchResults.total || validResults.length} 条相关词条，请回复数字选择查看详情：`

  // 发送结果列表
  const sendList = async () => {
    await session.send(promptText)
    await session.send(listText)
  }

  // 根据平台和模式选择显示方式
  if (mode === 'fwd' && session.platform === 'onebot') {
    try {
      const fwdMsgs = [
        { type: 'node', data: { name: '搜索结果', uin: session.selfId || '10000', content: promptText } },
        { type: 'node', data: { name: '搜索结果', uin: session.selfId || '10000', content: listText } }
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

    // 直接返回选择的结果链接
    const selectedResult = validResults[selection - 1]
    return `${selectedResult.title}\n${selectedResult.url}`
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
