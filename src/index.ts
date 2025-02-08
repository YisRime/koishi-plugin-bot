import { Context, Schema } from 'koishi'
import * as cron from 'koishi-plugin-cron'

export const name = 'daily-tools'
export const inject = ['database', 'cron']
export interface Config {
  specialMessages?: Record<number, string>        // 之前specialValues
  rangeMessages?: Record<string, string>            // 之前ranges
  holidayMessages?: Record<string, string>          // 之前specialDates
  sleep?: {
    mode: 'static'                                  // 之前 'fixed'
    duration: number
  } | {
    mode: 'until'
    until: string
  } | {
    mode: 'random'
    min: number
    max: number
  }
  autoLikeList?: string[]
  autoLikeTime?: string
  choice?: 'mod' | 'normal' | 'lcg'   // 重命名算法选项
  notifyAccount?: string  // 添加点赞通知账户配置
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    sleep: Schema.union([
      Schema.object({
        mode: Schema.const('static').required(),   // 之前 'fixed'
        duration: Schema.number().default(480),
      }).description('sleep.mode.static').default({ mode: 'static', duration: 480 }),
      Schema.object({
        mode: Schema.const('until').required(),
        until: Schema.string().default('08:00'),
      }).description('sleep.mode.until'),
      Schema.object({
        mode: Schema.const('random').required(),
        min: Schema.number().default(360),
        max: Schema.number().default(600),
      }).description('sleep.mode.random'),
    ]),
  }).description('精致睡眠').collapse(),
  Schema.object({
    autoLikeList: Schema.array(String)
      .default([])
      .role('textarea'),
    autoLikeTime: Schema.string().default('08:00'),
  }).description('自动点赞配置').collapse(),
  Schema.object({
    rangeMessages: Schema.dict(Schema.string())      // 之前 ranges
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
    specialMessages: Schema.dict(Schema.string())    // 之前 specialValues
      .default({
        0: 'jrrp.messages.special.1',
        50: 'jrrp.messages.special.2',
        100: 'jrrp.messages.special.3'
      }),
    holidayMessages: Schema.dict(Schema.string())      // 之前 specialDates
      .default({
        '01-01': 'jrrp.messages.date.1',
        '12-25': 'jrrp.messages.date.2'
      })
  }).description('jrrp配置').collapse(),
  // 修改算法选项的 Schema
  Schema.object({
    choice: Schema.union(['mod', 'normal', 'lcg'])
      .role('radio')
      .default('mod')
  }).description('jrrp算法选择').collapse(),
  Schema.object({
    notifyAccount: Schema.string().role('textarea').description('notifyAccount').default(''),
  }).description('点赞结果通知配置').collapse(),
]).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
})

export async function apply(ctx: Context, config: Config) {
  // 载入国际化文本
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  // 注册今日人品命令
  ctx.command('jrrp', 'jrrp.description')
    // 注册 -d 选项，说明为“指定日期”
    .option('d', '指定日期', { type: 'string' })
    .action(async ({ session, options }) => {
      // 处理 -d 选项，支持 "YYYY-MM-DD" 或 "MM-DD" 格式
      let targetDate = new Date();
      if (options?.d) {
        const dateStr = String(options.d);
        const fullDateMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (fullDateMatch) {
          targetDate = new Date(dateStr);
        } else {
          const parts = dateStr.split('-');
          if (parts.length === 2) {
            const month = Number(parts[0]);
            const day = Number(parts[1]);
            if (!isNaN(month) && !isNaN(day)) {
              const currentYear = targetDate.getFullYear();
              targetDate = new Date(currentYear, month - 1, day);
            }
          }
        }
      }
      // 使用 "YYYY-MM-DD" 格式
      const year = targetDate.getFullYear();
      const monthStr = String(targetDate.getMonth() + 1).padStart(2, '0');
      const dayStr = String(targetDate.getDate()).padStart(2, '0');
      const currentDateStr = `${year}-${monthStr}-${dayStr}`;
      const monthDay = `${monthStr}-${dayStr}`;

      // 修改：检查是否是特殊日期，提示用户10s内回复任意内容确认继续
      if (config.holidayMessages?.[monthDay]) {
        await session.send(session.text('jrrp.messages.prompt'));
        const response = await session.prompt(10000);
        if (!response) {
          return session.text('jrrp.messages.cancel');
        }
      }

      // 获取用户昵称
      const userNickname = session.username || 'User'

      // 使用更好的哈希算法和随机数生成
      function hashCode(str: string): number {
        let hash = 5381
        for (let i = 0; i < str.length; i++) {
          hash = ((hash << 5) + hash) + str.charCodeAt(i)
          hash = hash >>> 0 // 保持为32位无符号整数
        }
        return hash
      }

      let luckScore: number
      const userDateSeed = `${session.userId}-${currentDateStr}`
      // 修改 switch-case 中的算法名称
      switch (config.choice || 'mod') {
        case 'mod': {
          const modLuck = Math.abs(hashCode(userDateSeed)) % 101
          luckScore = modLuck
          break
        }
        case 'normal': {
          function normalRandom(seed: string): number {
            const hash = hashCode(seed)
            const randomFactor = Math.sin(hash) * 10000
            return randomFactor - Math.floor(randomFactor)
          }
          function toNormalLuck(random: number): number {
            const u1 = random
            const u2 = normalRandom(random.toString())
            const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
            return Math.min(100, Math.max(0, Math.round(z * 15 + 50)))
          }
          const dateWeight = (targetDate.getDay() + 1) / 7
          const baseRandom = normalRandom(userDateSeed)
          const weightedRandom = (baseRandom + dateWeight) / 2
          const normalLuck = toNormalLuck(weightedRandom)
          luckScore = normalLuck
          break
        }
        case 'lcg': {
          const lcgSeed = hashCode(userDateSeed)
          const lcgValue = (lcgSeed * 9301 + 49297) % 233280
          const lcgRandom = lcgValue / 233280
          const lcgLuck = Math.floor(lcgRandom * 101)
          luckScore = lcgLuck
          break
        }
        default:
          luckScore = Math.abs(hashCode(userDateSeed)) % 101
      }

      // 修复消息路径
      let message = session.text('jrrp.messages.result', [luckScore, userNickname])
      if (config.specialMessages && luckScore in config.specialMessages) {   // 修改key为specialMessages
        message += session.text(config.specialMessages[luckScore])
      } else if (config.rangeMessages) {                  // 修改key为rangeMessages
        // 遍历所有范围配置
        for (const [range, msg] of Object.entries(config.rangeMessages)) {
          const [min, max] = range.split('-').map(Number)
          if (!isNaN(min) && !isNaN(max) && luckScore >= min && luckScore <= max) {
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

      const sleep = config.sleep || { mode: 'static', duration: 480 }  // 修改默认 mode 为 static
      switch (sleep.mode) {
        case 'static':                            // 修改 case 'fixed' 为 'static'
          duration = Math.max(1, sleep.duration)
          break
        case 'until':
          const [hours, minutes] = sleep.until.split(':').map(Number)
          const endTime = new Date(now)
          endTime.setHours(hours, minutes, 0, 0)
          if (endTime <= now) {
            endTime.setDate(endTime.getDate() + 1)
          }
          duration = Math.max(1, Math.floor((endTime.getTime() - now.getTime()) / 60000))
          break
        case 'random':
          const min = Math.max(1, sleep.min)
          const max = Math.max(min, sleep.max)
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
      let successfulLikes = 0
      try {
        for (let i = 0; i < 5; i++) {
          await session.bot.internal.sendLike(session.userId, 10)
          successfulLikes += 1
        }
        return session.text('zanwo.messages.success')
      } catch (_e) {
        if (successfulLikes > 0) return session.text('zanwo.messages.success')
        return session.text('zanwo.messages.failure')
      }
    })

  // 添加自动点赞功能
  if (config.autoLikeList?.length > 0) {
    const [hour, minute] = config.autoLikeTime.split(':').map(Number)

    // 注册定时任务
    ctx.cron(`0 ${minute} ${hour} * * *`, async () => {
      const results = []

      for (const userId of config.autoLikeList) {
        try {
          // 每个用户尝试点赞5轮
          for (let i = 0; i < 5; i++) {
            await ctx.bots.first?.internal.sendLike(userId, 10)
          }
          results.push(`用户 ${userId} 点赞成功`)
        } catch (e) {
          ctx.logger.warn(`为用户 ${userId} 自动点赞失败: ${e.message}`)
          results.push(`用户 ${userId} 点赞失败: ${e.message}`)
        }
      }

      // 如果配置了通知账户，发送点赞结果
      if (config.notifyAccount) {
        const resultMessage = results.join('\n')
        await ctx.bots.first?.sendPrivateMessage(config.notifyAccount, resultMessage)
      }
    })
  }
}
