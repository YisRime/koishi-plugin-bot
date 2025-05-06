import { Context, Session } from 'koishi'

export async function renderOutput(session: Session, content: string, mode: string, ctx: Context) {
  // 首先尝试请求的模式
  try {
    const result = await tryRender(session, content, mode, ctx)
    if (result) return result
  } catch (error) {
    ctx.logger.error('渲染失败 - 模式 %s:', mode, error)
  }

  // 如果失败，尝试回退到纯文本
  if (mode !== 'text') {
    ctx.logger.warn('渲染模式 %s 失败，回退到纯文本模式', mode)
    return content
  }

  return content
}

async function tryRender(session: Session, content: string, mode: string, ctx: Context) {
  switch (mode) {
    case 'text':
      return content

    case 'fwd':
      try {
        // 创建转发消息
        const parts = content.split('\n\n').filter(part => part.trim());

        // 构建符合 OneBot 标准的转发消息节点
        const messages = parts.map(part => ({
          type: 'node',
          data: {
            name: session.username || '用户',
            uin: session.userId,
            content: part.trim()
          }
        }));

        // 根据会话类型决定调用哪个 API
        if (session.guildId || (session.subtype === 'group')) {
          // 群聊消息
          const groupId = session.guildId || session.channelId;
          return await session.bot.internal.sendGroupForwardMsg({
            group_id: groupId,
            messages
          });
        } else {
          // 私聊消息
          return await session.bot.internal.sendPrivateForwardMsg({
            user_id: session.channelId,
            messages
          });
        }
      } catch (error) {
        ctx.logger.error('创建转发消息失败:', error)
        return null
      }

    case 'shot':
      // 需要 puppeteer 服务
      const puppeteer = ctx.puppeteer
      if (!puppeteer) {
        ctx.logger.warn('截图需要 puppeteer 服务，但未找到该服务')
        return null
      }

      try {
        const html = `
          <html>
            <head>
              <style>
                body {
                  font-family: sans-serif;
                  padding: 20px;
                  max-width: 800px;
                  margin: 0 auto;
                  line-height: 1.5;
                  color: #333;
                  background-color: #fff;
                }
                h1 {
                  border-bottom: 1px solid #eee;
                  padding-bottom: 10px;
                }
                a {
                  color: #0366d6;
                  text-decoration: none;
                }
              </style>
            </head>
            <body>
              ${content.replace(/\n/g, '<br>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')}
            </body>
          </html>
        `

        // 创建浏览器上下文和页面
        const browser = await puppeteer.browser
        const context = await browser.createBrowserContext()
        const page = await context.newPage()

        try {
          // 配置页面设置
          await Promise.all([
            page.setRequestInterception(true),
            page.setCacheEnabled(true),
            page.setJavaScriptEnabled(false)
          ])

          // 配置请求拦截
          page.on('request', request => {
            const resourceType = request.resourceType()
            if (['media', 'font', 'manifest', 'script'].includes(resourceType)) {
              request.abort()
            } else {
              request.continue()
            }
          })

          // 设置内容并等待加载
          await page.setContent(html, { waitUntil: 'networkidle0', timeout: 5000 })

          // 确定截图区域
          const clipData = await page.evaluate(() => {
            const body = document.body
            const bodyRect = body.getBoundingClientRect()
            return {
              x: 0,
              y: 0,
              width: 800,
              height: Math.ceil(bodyRect.height)
            }
          })

          // 设置视口并截图
          await page.setViewport({
            width: clipData.width,
            height: clipData.height,
            deviceScaleFactor: 1.5, // 稍微提高分辨率
            isMobile: false
          })

          const screenshot = await page.screenshot({
            type: 'jpeg',
            quality: 85,
            fullPage: true,
            omitBackground: true,
            optimizeForSpeed: true
          })

          return { type: 'image', data: screenshot }
        } finally {
          // 确保资源释放
          await context.close()
        }
      } catch (error) {
        ctx.logger.error('生成截图失败:', error)
        return null
      }

    default:
      ctx.logger.warn('未知的渲染模式: %s', mode)
      return content
  }
}
