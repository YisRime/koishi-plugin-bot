import { Context, Session, h } from 'koishi'
import { Config } from '../index'

export async function renderOutput(
  session: Session,
  content: string,
  url: string = null,
  ctx: Context,
  config: Config,
  screenshot: boolean = false
) {
  if (!content) return ''

  // 处理截图
  if (config.useScreenshot && screenshot && url) {
    try {
      const image = await generateScreenshot(ctx, url)
      if (image) return h.image(image, 'image/jpeg')
    } catch (e) {
      ctx.logger.error('截图失败:', e)
    }
  }

  // 转发消息
  if (config.useForward) {
    try {
      const parts = content.split('\n\n').filter(p => p.trim())
      const messages = parts.map(part => ({
        type: 'node',
        data: { name: 'MC Tools', uin: session.selfId, content: part.trim() }
      }))

      const isGroup = session.guildId || (session.subtype === 'group')
      const target = isGroup ? (session.guildId || session.channelId) : session.channelId
      const method = isGroup ? 'sendGroupForwardMsg' : 'sendPrivateForwardMsg'

      await session.bot.internal[method](target, messages)
      return ''
    } catch (error) {
      ctx.logger.error('转发消息失败:', error)
    }
  }

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
