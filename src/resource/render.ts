import { Context, Session, h } from 'koishi'
import { Config } from '../index'

// 优化渲染输出函数
export async function renderOutput(
  session: Session,
  content: string,
  url: string = null,
  ctx: Context,
  config: Config,
  forceScreenshot: boolean = false
) {
  // 如果启用了截图功能并且有请求获取截图
  if (config.useScreenshot && forceScreenshot && url) {
    try {
      const screenshot = await generateScreenshot(ctx, url);
      if (screenshot) {
        return h.image(screenshot, 'image/jpeg');
      }
    } catch (error) {
      ctx.logger.error('截图失败:', error);
    }
  }

  // 处理转发消息
  if (config.useForward) {
    try {
      await sendForwardMessage(session, content);
      return '';
    } catch (error) {
      ctx.logger.error('创建转发消息失败:', error);
    }
  }

  // 回退到纯文本
  return content;
}

// 发送合并转发消息
async function sendForwardMessage(session: Session, content: string) {
  // 分割内容
  const parts = content.split('\n\n').filter(part => part.trim());

  // 构建消息节点
  const messages = parts.map(part => ({
    type: 'node',
    data: {
      name: `MC Tools`,
      uin: session.selfId,
      content: part.trim()
    }
  }));

  // 根据会话类型发送
  const isGroup = session.guildId || (session.subtype === 'group')
  const target = isGroup ? (session.guildId || session.channelId) : session.channelId
  await session.bot.internal[isGroup ? 'sendGroupForwardMsg' : 'sendPrivateForwardMsg'](target, messages);
}

// 截图函数
async function generateScreenshot(ctx: Context, url: string) {
  const puppeteer = ctx.puppeteer
  if (!puppeteer) {
    ctx.logger.warn('截图功能需要 puppeteer 服务，但未找到该服务')
    return null
  }

  try {
    const browser = await puppeteer.browser
    const context = await browser.createBrowserContext()
    const page = await context.newPage()

    try {
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
      await page.waitForSelector('body', { timeout: 5000 })

      const bodyHeight = await page.evaluate(() =>
        Math.max(
          document.body.scrollHeight, document.body.offsetHeight,
          document.documentElement.clientHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight
        )
      )

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
  } catch (error) {
    ctx.logger.error('生成截图失败:', error)
    return null
  }
}
