import { Context, Schema, segment, h } from 'koishi'  // 添加h导入
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { formatPlayerInfo } from './formatter'
import { formatPlayerInfoToHtml, renderToImage } from './renderer'

export const name = 'bot'
export const inject = {
  optional: ['puppeteer'] // 标记puppeteer为可选服务
}

export interface Config {
  bindingsFile?: string
  enableImageRendering?: boolean
}

export const Config: Schema<Config> = Schema.object({
  bindingsFile: Schema.string().default('ddnet_bindings.json').description('存储用户绑定信息的 JSON 文件名'),
  enableImageRendering: Schema.boolean().default(true).description('是否启用图片渲染功能')
})

// 简化的绑定数据类型，使用对象而非数组
interface BindingsData {
  [userId: string]: string  // userId -> nickname 映射
}

export async function apply(ctx: Context, config: Config) {
  // JSON 文件路径
  const bindingsFilePath = path.resolve(ctx.baseDir, config.bindingsFile || 'ddnet_bindings.json')

  // 检查是否支持图片渲染
  const hasRendering = config.enableImageRendering && ctx.puppeteer != null
  if (config.enableImageRendering && !ctx.puppeteer) {
    ctx.logger.warn('未检测到puppeteer服务，图片渲染功能将不可用')
  }

  // 加载绑定数据
  function loadBindings(): BindingsData {
    try {
      if (fs.existsSync(bindingsFilePath)) {
        const data = fs.readFileSync(bindingsFilePath, 'utf8')
        return JSON.parse(data) as BindingsData
      }
    } catch (error) {
      ctx.logger.error(`Failed to load bindings file: ${error}`)
    }
    return {}  // 返回空对象，而不是空数组
  }

  // 保存绑定数据
  function saveBindings(data: BindingsData): void {
    try {
      const dirPath = path.dirname(bindingsFilePath)
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
      fs.writeFileSync(bindingsFilePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (error) {
      ctx.logger.error(`Failed to save bindings file: ${error}`)
    }
  }

  // 获取绑定昵称 - 简化版本
  function getBoundNickname(userId: string): string | null {
    const data = loadBindings()
    return data[userId] || null
  }

  // 绑定昵称 - 简化版本
  function bindNickname(userId: string, nickname: string): void {
    const data = loadBindings()
    data[userId] = nickname
    saveBindings(data)
  }

  // 解除绑定 - 简化版本
  function unbindNickname(userId: string): boolean {
    const data = loadBindings()
    if (userId in data) {
      delete data[userId]
      saveBindings(data)
      return true
    }
    return false
  }

  // 查询玩家数据的核心函数
  async function queryPlayer(playerName: string): Promise<any> {
    const url = `https://ddnet.org/players/?json2=${encodeURIComponent(playerName)}`
    const response = await axios.get(url)
    const data = response.data

    if (!data || !data.player) {
      throw new Error(`未找到玩家 ${playerName} 的信息`)
    }

    // 检查查询的玩家名是否与返回的玩家名匹配（不区分大小写）
    if (data.player.toLowerCase() !== playerName.toLowerCase()) {
      throw new Error(`未找到玩家 ${playerName} 的信息，API 返回的是 ${data.player} 的信息`)
    }

    return data
  }

  // 处理图片渲染请求
  async function handleImageRequest(data: any, session: any): Promise<h> {
    await session.send(`正在为您生成 ${data.player} 的信息图，请稍候...`)

    // 将数据转换为HTML，并渲染为图片
    const html = formatPlayerInfoToHtml(data)
    const imageBuffer = await renderToImage(html, ctx)

    // 使用h.image发送图片
    return h.image(imageBuffer, 'image/png')
  }

  // 添加 DDNet 玩家查询命令组
  const cmd = ctx.command('ddrnet', 'DDNet 玩家信息查询')
    .action(async () => {
      return '请使用子命令：\n- ddrnet <玩家名> - 查询指定玩家信息\n- ddrnet.bind <玩家名> - 绑定玩家昵称\n- ddrnet.unbind - 解除绑定'
    })

  // 查询命令
  cmd.subcommand('.query <player:string>', '查询 DDNet 玩家信息')
    .option('image', '-i 以图片形式显示结果')
    .alias('')  // 允许直接使用 ddrnet <玩家名> 进行查询
    .action(async ({ session, options }, player) => {
      // 如果没有提供玩家名，尝试使用绑定的昵称
      if (!player) {
        if (!session?.userId) {
          return '请输入要查询的玩家名称或先绑定您的 DDNet 玩家名'
        }

        const boundNickname = getBoundNickname(session.userId)
        if (!boundNickname) {
          return '您尚未绑定 DDNet 玩家名，请使用 ddrnet.bind <玩家名> 进行绑定，或直接指定要查询的玩家名'
        }
        player = boundNickname
      }

      try {
        // 查询玩家数据
        const data = await queryPlayer(player)

        // 检查是否需要渲染图片
        const useImage = options.image && hasRendering

        if (useImage) {
          try {
            return await handleImageRequest(data, session)
          } catch (error) {
            ctx.logger.error('生成图片失败:', error)
            // 图片渲染失败时回退到文本模式
            await session.send('图片生成失败，将以文本形式显示数据...')
            return formatPlayerInfo(data)
          }
        } else {
          // 返回文本格式
          return formatPlayerInfo(data)
        }
      } catch (error) {
        ctx.logger.error('查询失败:', error)
        return typeof error === 'object' && error.message ? error.message : '查询失败，请稍后再试'
      }
    })

  // 绑定命令
  cmd.subcommand('.bind <player:string>', '绑定 DDNet 玩家名称')
    .action(async ({ session }, player) => {
      if (!player) {
        return '请输入要绑定的玩家名称'
      }

      if (!session?.userId) {
        return '无法识别您的用户信息，绑定失败'
      }

      try {
        // 验证玩家是否存在
        const url = `https://ddnet.org/players/?json2=${encodeURIComponent(player)}`
        const response = await axios.get(url)
        const data = response.data

        if (!data || !data.player) {
          return `未找到玩家 ${player}，绑定失败`
        }

        // 使用 API 返回的准确玩家名进行绑定
        const exactPlayerName = data.player

        // 保存绑定信息
        bindNickname(session.userId, exactPlayerName)

        return `成功将您的账号与 DDNet 玩家 ${exactPlayerName} 绑定`
      } catch (error) {
        return '绑定失败，请稍后再试'
      }
    })

  // 解除绑定命令
  cmd.subcommand('.unbind', '解除 DDNet 玩家名称绑定')
    .action(async ({ session }) => {
      if (!session?.userId) {
        return '无法识别您的用户信息，解绑失败'
      }

      const boundNickname = getBoundNickname(session.userId)
      if (!boundNickname) {
        return '您尚未绑定 DDNet 玩家名'
      }

      if (unbindNickname(session.userId)) {
        return `已成功解除与玩家 ${boundNickname} 的绑定`
      } else {
        return '解绑失败，请稍后再试'
      }
    })

  // 图片查询命令别名 - 修复参数传递
  cmd.subcommand('.image <player:string>', '以图片形式查询 DDNet 玩家信息')
    .alias('.img')
    .action(async ({ session }, player) => {
      try {
        // 如果没有提供玩家名，尝试使用绑定的昵称
        if (!player && session?.userId) {
          const boundNickname = getBoundNickname(session.userId)
          if (boundNickname) {
            player = boundNickname
          }
        }

        if (!player) {
          return '请输入要查询的玩家名称或先绑定您的 DDNet 玩家名'
        }

        // 检查是否支持图片渲染
        if (!hasRendering) {
          return '抱歉，图片渲染功能不可用，请安装puppeteer服务'
        }

        // 查询玩家数据
        const data = await queryPlayer(player)

        // 直接调用图片渲染处理
        return await handleImageRequest(data, session)
      } catch (error) {
        ctx.logger.error('图片查询失败:', error)
        return typeof error === 'object' && error.message ? error.message : '查询失败，请稍后再试'
      }
    })
}
