import { Context, Session } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'

export type OutputMode = 'text' | 'fwd' | 'shot'

// 内容源标识符
export type ContentSource = 'wiki' | 'mcmod' | 'curseforge' | 'modrinth'

// 内容源配置接口
export interface SourceConfig {
  name: string;         // 显示名称
  icon?: string;        // 可选的图标
  baseUrl?: string;     // 基础URL
}

// 内容源映射表
export const CONTENT_SOURCES: Record<ContentSource, SourceConfig> = {
  wiki: {
    name: 'Minecraft Wiki',
    baseUrl: 'https://zh.minecraft.wiki/w/'
  },
  mcmod: {
    name: 'MC百科',
    baseUrl: 'https://www.mcmod.cn/class/'
  },
  curseforge: {
    name: 'CurseForge',
    baseUrl: 'https://www.curseforge.com/minecraft/mc-mods/'
  },
  modrinth: {
    name: 'Modrinth',
    baseUrl: 'https://modrinth.com/mod/'
  }
}

// 表示单个词条的详细内容
export interface Result {
  title: string;
  url: string;
  content: string;  // 简化为单个字符串内容
  source: ContentSource;   // 内容来源
}

// 表示搜索结果列表中的单项
export interface SearchResultItem {
  title: string;
  url: string;
  excerpt: string;   // 摘要内容
  source: ContentSource;    // 来源
  category?: string; // 可选的分类信息
}

// 表示搜索结果列表
export interface SearchResults {
  query: string;
  queryUrl: string;
  total: number;
  items: SearchResultItem[];
}

// 内容类型标识
export type ContentType = 'detail' | 'list';

// 统一的内容接口
export interface ContentResult {
  type: ContentType;
  title: string;
  source: ContentSource;
  content: Result | SearchResults;
  options?: {
    mode?: OutputMode;
    showExcerpt?: boolean;
  };
}

/**
 * 统一的内容发送函数
 */
export async function sendContent(session: Session, contentResult: ContentResult): Promise<any> {
  const ctx = session.app
  const { type, content, options } = contentResult
  const mode = options?.mode || 'fwd'
  const source = contentResult.source
  const sourceConfig = CONTENT_SOURCES[source] || { name: source }

  try {
    if (type === 'detail') {
      const result = content as Result
      ctx.logger.info(`渲染详细内容 "${result.title}" (来源: ${sourceConfig.name}, 模式: ${mode})`)
      return await renderDetail(session, result, mode)
    } else {
      const results = content as SearchResults
      ctx.logger.info(`渲染搜索结果列表，共 ${results.items.length} 项 (来源: ${sourceConfig.name}, 模式: ${mode})`)
      return await renderList(session, results, mode, { showExcerpt: options?.showExcerpt !== false })
    }
  } catch (error) {
    ctx.logger.error(`渲染内容失败: ${error.message}`)
    if (type === 'detail') {
      const result = content as Result
      return `${result.title}\n\n查看更多: ${result.url}`
    }
    return '内容渲染失败，请重试'
  }
}

/**
 * 处理并输出词条详情
 */
export async function renderDetail(session: Session, result: Result | null, mode: OutputMode = 'fwd'): Promise<any> {
  if (!result) return '未找到相关词条'

  const ctx = session.app
  const content = result.content || '暂无简介';
  const sourceConfig = CONTENT_SOURCES[result.source] || { name: result.source }

  try {
    // 按优先级尝试不同渲染模式
    if (mode === 'shot') {
      // 内联 renderShot 函数
      const output = await (async () => {
        if (!ctx.puppeteer) return null;

        try {
          const page = await ctx.puppeteer.page()
          await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1.5 })

          ctx.logger.info(`开始加载页面: ${result.url}`)
          await page.goto(result.url, { waitUntil: 'networkidle0' })

          // 根据内容源确定选择器
          let contentSelector: string
          switch (result.source) {
            case 'wiki':
              contentSelector = '#content'
              break
            case 'mcmod':
              contentSelector = '#app'
              break
            case 'curseforge':
              contentSelector = '.container'
              break
            case 'modrinth':
              contentSelector = '.container'
              break
            default:
              contentSelector = 'body'
          }

          await page.waitForSelector(contentSelector, { timeout: 8000 })

          // 优化页面显示 - 根据内容源确定要移除的元素
          await page.evaluate((source) => {
            // 定义每个源要移除的选择器
            const sourceSelectors = {
              wiki: ['#mw-navigation', '#footer', '.noprint', '#siteNotice', '.printfooter', '#catlinks'],
              mcmod: ['#header', '#footer', '.links', '.ad-box', '.declare'],
              curseforge: ['#navigation', '.footer', '.ad-container'],
              modrinth: ['nav', 'footer', '.sidebar']
            }

            // 获取当前源的选择器或使用通用选择器
            const removeSelectors = sourceSelectors[source] || ['nav', 'footer', '.ads']

            removeSelectors.forEach(selector => {
              document.querySelectorAll(selector).forEach(el => el.remove())
            })

            // 添加自定义样式
            document.head.insertAdjacentHTML('beforeend', `
              <style>
                body { max-width: 1200px; margin: 0 auto; padding: 1em; }
                #content, #app, .container { padding: 1em; background: #fff; }
                h1, h2 { margin-top: 0.5em !重要; }
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
          return [`[图片内容请查看原链接]`, `查看更多: ${result.url}`]
        } catch (error) {
          ctx.logger.error(`截图失败: ${error.message}`)
          return null
        }
      })()

      if (output) return output;
      mode = 'fwd'
      ctx.logger.info('截图失败，回退到合并转发')
    }

    if (mode === 'fwd') {
      // 内联部分 renderFwd 函数
      const output = await (async () => {
        if (session.platform !== 'onebot') return null;

        const onebot = session.bot
        if (!onebot) return null

        try {
          // 智能分割文本辅助函数
          const segments = splitContentIntoSegments(content);
          const srcName = sourceConfig.name;

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
      })()

      if (output !== null) return output;
      mode = 'text'
      ctx.logger.info('合并转发失败，回退到文本')
    }

    // 文本输出模式
    const segments = splitContentIntoSegments(content);
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
  } catch (error) {
    ctx.logger.error(`渲染失败: ${error.message}`)
    return `${result.title}\n\n查看更多: ${result.url}`
  }
}

/**
 * 智能分割内容为合适的片段
 */
function splitContentIntoSegments(content: string): string[] {
  if (!content) return [content];

  // 按自然段落分割
  const paragraphs = content.split(/\n\n+/);

  // 如果段落很少，直接返回
  if (paragraphs.length <= 5) return [content];

  // 否则按更合理的方式组织段落
  const segments: string[] = [];
  let currentSegment = '';

  paragraphs.forEach(paragraph => {
    if (currentSegment.length + paragraph.length > 4000) { // 预防极端情况的极限
      segments.push(currentSegment);
      currentSegment = paragraph;
    } else {
      currentSegment += (currentSegment ? '\n\n' : '') + paragraph;
    }
  });

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments.length ? segments : [content];
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
  const ctx = session.app

  // 过滤掉无效链接的结果
  const validResults = searchResults.items.filter(item => item.url && item.title)
  if (!validResults.length) return '未找到有效的搜索结果'

  // 获取源信息
  const firstSource = validResults[0].source
  const sourceConfig = CONTENT_SOURCES[firstSource] || { name: firstSource }

  ctx.logger.info(`[${sourceConfig.name}] 生成搜索结果列表，共 ${validResults.length} 项`);

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
        { type: 'node', data: { name: `${sourceConfig.name}搜索`, uin: session.selfId || '10000', content: promptText } },
        { type: 'node', data: { name: `${sourceConfig.name}搜索`, uin: session.selfId || '10000', content: listText } }
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
      ctx.logger.warn(`[${sourceConfig.name}] 合并转发失败: ${error.message}`)
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
      let result: Result | null = null

      // 动态导入并调用对应模块的详情获取函数
      switch (source) {
        case 'wiki':
          const wikiModule = await import('./wiki')
          result = await wikiModule.getWikiDetail(ctx, selectedItem.title, selectedItem.url)
          break
        case 'mcmod':
          const mcmodModule = await import('./mcmod')
          result = await mcmodModule.getMcmodDetail(ctx, selectedItem.title, selectedItem.url)
          break
        // 未来可以在这里添加更多源的处理
        default:
          throw new Error(`不支持的内容源：${source}`)
      }

      if (!result) {
        throw new Error(`获取${CONTENT_SOURCES[source]?.name || source}详情失败`)
      }

      return sendContent(session, {
        type: 'detail',
        title: result.title,
        source: result.source,
        content: result,
        options: { mode }
      })
    } catch (error) {
      ctx.logger?.error(`[Detail] 获取详情失败: ${error.message}`)
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

/**
 * 内容源特定的文本清理函数
 */
export function cleanSourceText(text: string, source: ContentSource): string {
  // 基础清理
  let cleaned = cleanText(text);

  // 源特定的清理
  switch(source) {
    case 'mcmod':
      cleaned = cleaned
        .replace(/\[\w+:[^]]*\]/g, '')
        .replace(/\[h\d=.*?\]/g, '')
        .replace(/\[.*?\]/g, '');
      break;
    case 'wiki':
      cleaned = cleaned
        .replace(/\[\d+\]/g, '')
        .replace(/\[\w+\]/g, '');
      break;
    // 添加新源的特定清理规则
  }

  return cleaned;
}