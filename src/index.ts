import { Context, Schema } from 'koishi'
import * as cron from 'koishi-plugin-cron'

export const name = 'daily-tools'
export const inject = {
  required: ['database'],
  optional: ['cron']
}

// 每日人品配置组
export interface JrrpConfig {
  specialValues?: Record<number, string>
  ranges?: Record<string, string>
  specialDates?: Record<string, string>
}

// 睡眠配置组
export interface SleepConfig {
  sleepMode?: 'fixed' | 'until' | 'random'
  sleepDuration?: number
  sleepUntil?: string
  sleepRandomMin?: number
  sleepRandomMax?: number
}

// 自动点赞配置组
export interface AutoLikeConfig {
  autoLikeList?: string[]
  autoLikeTime?: string
}

export interface Config extends JrrpConfig, SleepConfig, AutoLikeConfig {}

// 定义配置Schema
const jrrpConfig = Schema.object({
  specialValues: Schema.dict(Schema.string())
    .default({
      0: 'jrrp.messages.special.1',
      50: 'jrrp.messages.special.2',
      100: 'jrrp.messages.special.3'
    }),
  ranges: Schema.dict(Schema.string())
    .default({
      '0-9': 'jrrp.messages.range.1',
      '10-19': 'jrrp.messages.range.2',
      '20-39': 'jrrp.messages.range.3',
      '40-49': 'jrrp.messages.range.4',
      '50-69': 'jrrp.messages.range.5',
      '70-89': 'jrrp.messages.range.6',
      '90-95': 'jrrp.messages.range.7',
      '96-100': 'jrrp.messages.range.8'
    }),
  specialDates: Schema.dict(Schema.string())
    .default({
      '01-01': 'jrrp.messages.date.1',
      '12-25': 'jrrp.messages.date.2'
    }),
}).description('_config.jrrp.$desc')

const sleepConfig = Schema.intersect([
  Schema.object({
    sleepMode: Schema.union([
      Schema.const('fixed'),
      Schema.const('until'),
      Schema.const('random')
    ]).default('fixed'),
  }),
  Schema.union([
    Schema.object({
      sleepMode: Schema.const('fixed').required(),
      sleepDuration: Schema.number().default(480),
    }),
    Schema.object({
      sleepMode: Schema.const('until').required(),
      sleepUntil: Schema.string().default('08:00'),
    }),
    Schema.object({
      sleepMode: Schema.const('random').required(),
      sleepRandomMin: Schema.number().default(360),
      sleepRandomMax: Schema.number().default(600),
    }),
  ]),
]).description('_config.sleep.$desc')

const autoLikeConfig = Schema.object({
  autoLikeList: Schema.array(String)
    .default([])
    .role('textarea'),
  autoLikeTime: Schema.string()
    .default('08:00')
}).description('_config.autoLike.$desc')

export const Config = Schema.intersect([
  jrrpConfig,
  sleepConfig,
  autoLikeConfig
]).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
})

export async function apply(ctx: Context, config: Config) {
  // 载入国际化文本
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))
  ctx.i18n.define('en-US', require('./locales/en-US'))

  // 注册今日人品命令
  ctx.command('jrrp', 'jrrp.description')
    .action(async ({ session }) => {
      const userId = session.userId
      const date = new Date()
      const dateStr = date.toLocaleDateString()
      const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

      // 检查是否是特殊日期
      if (config.specialDates?.[mmdd]) {
        const response = await session.prompt()
        if (!response || !['是', 'y', 'Y', 'yes'].includes(response.trim())) {
          return session.text('jrrp.cancel')
        }
      }

      // 获取用户昵称
      const nickname = session.username || 'User'

      // 使用更好的哈希算法和随机数生成
      function hashCode(str: string): number {
        let hash = 5381
        for (let i = 0; i < str.length; i++) {
          hash = ((hash << 5) + hash) + str.charCodeAt(i)
          hash = hash >>> 0 // 保持为32位无符号整数
        }
        return hash
      }

      // 生成0-1之间的伪随机数
      function seededRandom(seed: string): number {
        const hash = hashCode(seed)
        // 使用多个哈希值来增加随机性
        const x = Math.sin(hash) * 10000
        return x - Math.floor(x)
      }

      // 正态分布转换（Box-Muller变换）
      function normalDistribution(random: number): number {
        const u1 = random
        const u2 = seededRandom(random.toString())
        const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
        // 将正态分布映射到0-100范围，均值50，标准差15
        return Math.min(100, Math.max(0, Math.round(z * 15 + 50)))
      }

      // 生成最终的人品值
      const dateWeight = (date.getDay() + 1) / 7 // 根据星期几添加权重
      const baseSeed = `${userId}-${dateStr}` // 添加版本标记避免与旧版冲突
      const baseRandom = seededRandom(baseSeed)
      // 使用日期权重对基础随机值进行调整
      const weightedRandom = (baseRandom + dateWeight) / 2
      const rp = normalDistribution(weightedRandom)

      // 修复消息路径
      let message = session.text('jrrp.messages.result', [rp, nickname])
      if (config.specialValues && rp in config.specialValues) {
        message += session.text(config.specialValues[rp])
      } else if (config.ranges) {
        // 遍历所有范围配置
        for (const [range, msg] of Object.entries(config.ranges)) {
          const [min, max] = range.split('-').map(Number)
          if (!isNaN(min) && !isNaN(max) && rp >= min && rp <= max) {
            message += session.text(msg)
            break
          }
        }
      }
      return message
    })

  // 注册精致睡眠命令
  ctx.command('sleep', 'sleep.description')
    .alias('jzsm')
    .action(async ({ session }) => {
      if (!session.guildId) {
        return session.text('sleep.messages.guild_only')
      }

      let duration: number
      const now = new Date()

      switch (config.sleepMode) {
        case 'fixed':
          duration = Math.max(1, config.sleepDuration)
          break
        case 'until':
          const [hours, minutes] = (config.sleepUntil).split(':').map(Number)
          const endTime = new Date(now)
          endTime.setHours(hours, minutes, 0, 0)
          if (endTime <= now) {
            endTime.setDate(endTime.getDate() + 1)
          }
          duration = Math.max(1, Math.floor((endTime.getTime() - now.getTime()) / 60000))
          break
        case 'random':
          const min = Math.max(1, config.sleepRandomMin)
          const max = Math.max(min, config.sleepRandomMax)
          duration = Math.floor(Math.random() * (max - min + 1) + min)
          break
        default:
          return session.text('sleep.messages.invalid_mode')
      }

      try {
        await session.bot.muteGuildMember(session.guildId, session.userId, duration * 60 * 1000)
        return session.text('sleep.messages.success', [duration])
      } catch (error) {
        ctx.logger('sleep').warn(error)
        return session.text('sleep.messages.failed')
      }
    })

  // 注册赞我命令
  ctx.command('zanwo', 'zanwo.description')
    .alias('赞我')
    .action(async ({ session }) => {
      let num = 0
      try {
        for (let i = 0; i < 5; i++) {
          await session.bot.internal.sendLike(session.userId, 10)
          num += 1
        }
        return session.text('zanwo.messages.success')
      } catch (_e) {
        if (num > 0) return session.text('zanwo.messages.success')
        return session.text('zanwo.messages.failure')
      }
    })

  // 添加自动点赞功能
  if (ctx.cron && config.autoLikeList?.length > 0) {
    const [hour, minute] = config.autoLikeTime.split(':').map(Number)

    // 注册定时任务
    ctx.cron(`0 ${minute} ${hour} * * *`, async () => {

      for (const userId of config.autoLikeList) {
        try {
          // 每个用户尝试点赞5轮
          for (let i = 0; i < 5; i++) {
            await ctx.bots.first?.internal.sendLike(userId, 10)
          }
        } catch (e) {
          ctx.logger.warn(`为用户 ${userId} 自动点赞失败: ${e.message}`)
        }
        // 添加短暂延迟避免请求过快
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    })
  }
}
