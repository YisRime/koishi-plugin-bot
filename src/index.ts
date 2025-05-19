import { Context, Schema } from 'koishi'

export const name = 'bot'
export const inject = {required: ['database']}

/**
 * 插件配置接口
 */
export interface Config {
  switchMode: 'manual' | number
  initSwitch: boolean
  enabledPlatforms: string[]
  showChannelDetails: boolean
  balanceMode: 'manual' | number
  balanceStrategy: 'channels' | 'bots'
  excludeChannels: string[]
}

export const Config: Schema<Config> = Schema.object({
  switchMode: Schema.union([
    Schema.const('manual').description('手动'),
    Schema.number().min(0).step(1).default(30).description('超时切换(秒)'),
  ]).default(5).description('受理人切换模式'),
  initSwitch: Schema.boolean().default(false).description('初始化时切换不可用受理人'),
  showChannelDetails: Schema.boolean().default(false).description('显示详细频道信息'),
  enabledPlatforms: Schema.array(String).default(['onebot']).description('启用平台（留空表示所有）').role(`table`),
  balanceMode: Schema.union([
    Schema.const('manual').description('禁用'),
    Schema.number().min(1).step(60).default(600).description('定时轮换(秒)'),
  ]).default('manual').description('负载均衡模式'),
  balanceStrategy: Schema.union([
    Schema.const('channels').description('轮换频道'),
    Schema.const('bots').description('轮换机器人'),
  ]).default('channels').description('负载均衡策略'),
  excludeChannels: Schema.array(String).default([]).description('负载均衡例外频道').role('table')
})

/**
 * 插件主函数
 * @param ctx Koishi上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('bot')
  const activeBots = new Map<string, Set<string>>()
  const isAutoMode = config.switchMode !== 'manual'
  const timeout = isAutoMode ? Number(config.switchMode) * 1000 : 0
  const isPlatformEnabled = platform => !config.enabledPlatforms.length || config.enabledPlatforms.includes(platform)
  let balanceTimer: NodeJS.Timeout = null
  const isBalanceEnabled = config.balanceMode !== 'manual'
  const balanceInterval = isBalanceEnabled ? Number(config.balanceMode) : 0
  const activeBotIndices = new Map<string, number>()

  /**
   * 检查机器人是否在线
   * @param status 机器人状态
   * @returns 机器人是否在线
   */
  const isBotOnline = (status: any): boolean =>
    typeof status === 'number' ? [1, 2].includes(status) :
    typeof status === 'object' && status ? Boolean(status.ONLINE) : status === 'ONLINE'

  /**
   * 记录频道日志
   * @param prefix 日志前缀
   * @param platform 平台名称
   * @param channels 频道列表
   */
  const logChannels = (prefix, platform, channels) => {
    logger.info(`${prefix}，平台: ${platform}，频道: ${config.showChannelDetails
      ? channels.map(c => c.id).join(', ')
      : `${channels.length} 个`}`)
  }

  /**
   * 更新活跃机器人列表
   * @param bot 机器人实例
   * @param isActive 是否活跃
   * @returns 更新后的平台机器人集合
   */
  const updateActiveBot = (bot, isActive) => {
    const platformBots = activeBots.get(bot.platform) || new Set()
    const prevStatus = platformBots.has(bot.selfId)
    if (isActive) platformBots.add(bot.selfId)
    else platformBots.delete(bot.selfId)
    if (prevStatus !== isActive) logger.info(`机器人 ${bot.platform}:${bot.selfId} 状态更新为: ${isActive ? '在线' : '离线'}`)
    activeBots.set(bot.platform, platformBots)
    return platformBots
  }

  /**
   * 检查是否为例外频道
   * @param channel 频道信息
   * @returns 是否为例外频道
   */
  const isExcludedChannel = (channel) =>
    config.excludeChannels.includes(`${channel.platform}:${channel.id}`) ||
    config.excludeChannels.includes(channel.id)

  /**
   * 切换受理人
   * @param activeIds 活跃机器人ID列表
   * @param channels 需要切换的频道列表
   */
  async function switchHandler(activeIds: string[], channels = []) {
    if (!activeIds.length || !channels.length) return
    const filteredChannels = channels.filter(channel => !isExcludedChannel(channel))
    if (!filteredChannels.length) return
    try {
      await Promise.all(filteredChannels.map(channel =>
        ctx.database.setChannel(channel.platform, channel.id, { assignee: activeIds[0] })))
      logChannels('成功切换受理人', filteredChannels[0]?.platform, filteredChannels)
    } catch (e) {
      logger.error(`修改受理人失败: ${e.message}`)
    }
  }

  /**
   * 检查并切换受理人
   * @param bot 机器人实例
   */
  async function checkAndSwitchAssignee(bot) {
    if (!isPlatformEnabled(bot.platform)) return
    const affectedChannels = await ctx.database.get('channel', { platform: bot.platform, assignee: bot.selfId })
    if (!affectedChannels.length || !isAutoMode) return
    const activeBotsArray = [...(activeBots.get(bot.platform) || new Set())]
    if (activeBotsArray.length < 2) return
    logChannels(`受理人 ${bot.selfId} 状态变化，需要切换频道`, bot.platform, affectedChannels)
    timeout > 0
      ? setTimeout(() => switchHandler(activeBotsArray, affectedChannels), timeout)
      : switchHandler(activeBotsArray, affectedChannels)
  }

  /**
   * 获取按平台分组的有效频道
   * @returns 按平台分组的频道Map
   */
  async function getChannelsByPlatform() {
    const channelsByPlatform = new Map<string, any[]>()
    // 按平台分组，过滤掉例外频道
    const allChannels = await ctx.database.get('channel', {})
    allChannels
      .filter(c => c.assignee && !isExcludedChannel(c))
      .forEach(channel => {
        if (!isPlatformEnabled(channel.platform)) return
        if (!channelsByPlatform.has(channel.platform))
          channelsByPlatform.set(channel.platform, [])
        channelsByPlatform.get(channel.platform).push(channel)
      })
    return channelsByPlatform
  }

  /**
   * 执行负载均衡
   */
  async function performLoadBalancing() {
    logger.info(`执行${config.balanceStrategy === 'channels' ? '频道' : '机器人'}轮换负载均衡...`)
    const channelsByPlatform = await getChannelsByPlatform()
    for (const [platform, channels] of channelsByPlatform.entries()) {
      const activePlatformBots = [...(activeBots.get(platform) || new Set())]
      if (activePlatformBots.length < 2) continue
      if (config.balanceStrategy === 'channels') {
        // 频道轮换策略
        const shuffledChannels = [...channels].sort(() => Math.random() - 0.5)
        for (let i = 0; i < shuffledChannels.length; i++) {
          const botIndex = i % activePlatformBots.length
          const assignee = activePlatformBots[botIndex]
          await ctx.database.setChannel(shuffledChannels[i].platform, shuffledChannels[i].id, { assignee })
        }
        logChannels(`已对平台 ${platform} 的频道执行轮换分配`, platform, channels)
      } else {
        // 机器人轮换策略
        let currentIndex = activeBotIndices.get(platform) ?? 0
        currentIndex = (currentIndex + 1) % activePlatformBots.length
        activeBotIndices.set(platform, currentIndex)
        const selectedBot = activePlatformBots[currentIndex]
        await Promise.all(channels.map(channel => ctx.database.setChannel(channel.platform, channel.id, { assignee: selectedBot })))
        logger.info(`平台 ${platform} 切换为使用机器人 ${selectedBot}，影响 ${channels.length} 个频道`)
      }
    }
  }

  /**
   * 初始化活跃机器人列表和配置负载均衡
   */
  ctx.on('ready', async () => {
    logger.info('初始化活跃机器人列表...')
    ctx.bots.forEach(bot => updateActiveBot(bot, isBotOnline(bot.status || { ONLINE: !bot.error })))
    // 初始化切换
    if (isAutoMode && config.initSwitch) {
      const channelsByPlatform = await getChannelsByPlatform()
      for (const [platform, channels] of channelsByPlatform.entries()) {
        const activeBotsArray = [...(activeBots.get(platform) || new Set())]
        if (activeBotsArray.length < 2) continue
        logChannels(`平台 ${platform} 有 ${activeBotsArray.length} 个活跃机器人`, platform, channels)
        const unavailableChannels = channels.filter(channel => !activeBotsArray.includes(channel.assignee))
        if (unavailableChannels.length) {
          logChannels(`平台 ${platform} 有受理人不可用`, platform, unavailableChannels)
          switchHandler(activeBotsArray, unavailableChannels)
        }
      }
    }
    // 启动负载均衡定时器
    if (isBalanceEnabled && balanceInterval > 0) {
      logger.info(`启动负载均衡定时器，策略: ${config.balanceStrategy}，间隔: ${balanceInterval}秒`)
      if (balanceTimer) clearInterval(balanceTimer)
      balanceTimer = setInterval(performLoadBalancing, balanceInterval * 1000)
    }
  })

  // 监听机器人状态
  if (isAutoMode) {
    ctx.on('bot-status-updated', (bot) => {
      const isOnline = isBotOnline(bot.status)
      logger.info(`机器人状态更新: ${bot.platform}:${bot.selfId} 状态=${JSON.stringify(bot.status)}，解析为${isOnline ? '在线' : '离线'}`)
      const platformBots = updateActiveBot(bot, isOnline)
      if (!isOnline && platformBots.size && platformBots.has(bot.selfId))
        checkAndSwitchAssignee(bot)
    })
  }

  /**
   * 处理插件销毁事件，清理资源
   */
  ctx.on('dispose', () => {
    if (balanceTimer) {
      clearInterval(balanceTimer)
      balanceTimer = null
    }
  })
}