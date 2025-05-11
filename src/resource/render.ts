import { Context, Session, h } from 'koishi'
import { Config } from '../index'

// 添加图片元素转换函数，将 h.image 元素转换为 OneBot 可接受的格式
function convertImageForOneBot(item) {
  if (typeof item === 'object' && item?.type === 'img') {
    // 将 h.image 转换为纯文本形式的 CQ 码
    return `[CQ:image,file=${item.attrs?.src || ''}]`
  }
  return item
}

export async function renderOutput(
  session: Session,
  content: any[],  // 只接受数组形式
  url: string = null,
  ctx: Context,
  config: Config,
  screenshot: boolean = false
) {
  if (!content || content.length === 0) return ''

  // 处理截图
  if (config.useScreenshot && screenshot && url) {
    try {
      const image = await generateScreenshot(ctx, url)
      if (image) return h.image(image, 'image/jpeg')
    } catch (e) {
      ctx.logger.error('截图失败:', e)
    }
  }

  // 检查是否为 OneBot 平台
  const isOneBot = session.platform === 'onebot'

  // 只有 OneBot 平台才使用合并转发
  if (config.useForward && isOneBot) {
    try {
      // 创建多个消息节点，每个元素一个节点，并转换图片格式
      const messages = content.map(item => {
        // 处理可能的图片元素
        const processedContent = convertImageForOneBot(item)

        return {
          type: 'node',
          data: {
            name: 'MC Tools',
            uin: session.selfId,
            content: processedContent
          }
        }
      })

      const isGroup = session.guildId || (session.subtype === 'group')
      const target = isGroup ? (session.guildId || session.channelId) : session.channelId
      const method = isGroup ? 'sendGroupForwardMsg' : 'sendPrivateForwardMsg'

      // 尝试使用合并转发
      try {
        await session.bot.internal[method](target, messages)
        return ''
      } catch (forwardError) {
        // 如果合并转发失败，回退到直接发送
        ctx.logger.error('合并转发失败，回退到直接发送:', forwardError)
        for (const item of content) {
          await session.send(item)
        }
        return ''
      }
    } catch (error) {
      ctx.logger.error('消息处理失败:', error)
    }
  } else {
    // 非 OneBot 平台或不使用转发功能，直接发送消息
    try {
      // 依次发送每个内容元素
      for (const item of content) {
        await session.send(item)
      }
      return ''
    } catch (error) {
      ctx.logger.error('消息发送失败:', error)
    }
  }

  // 如果上述方法都失败，直接返回内容
  return content
}

// 优化截图函数
async function generateScreenshot(ctx: Context, url: string) {
  const puppeteer = ctx.puppeteer
  if (!puppeteer) return null

  const browser = await puppeteer.browser
  const context = await browser.createBrowserContext()
  const page = await context.newPage()

  try {
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

    // 计算适合的高度
    const bodyHeight = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 800))

    // 调整视口
    if (bodyHeight > 900) {
      await page.setViewport({
        width: 1280,
        height: Math.min(bodyHeight, 8000),
        deviceScaleFactor: 1
      })
    }

    return await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true })
  } finally {
    await context.close()
  }
}
