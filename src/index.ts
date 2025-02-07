import { Context, Schema } from 'koishi'

export const name = 'daily-tools'
export const inject = ['database']
export interface Config {
  specialValues?: Record<number, string>
  ranges?: { min: number, max: number, message: string }[]
  specialDates?: { date: string, message: string }[]
  sleepMode?: 1 | 2 | 3
  sleepDuration?: number  // 模式1的禁言时长（分钟）
  sleepUntil?: string    // 模式2的固定时间点 (HH:mm)
  sleepRandomMin?: number // 模式3的最小禁言时长（分钟）
  sleepRandomMax?: number // 模式3的最大禁言时长（分钟）
}

export const Config: Schema<Config> = Schema.object({
  specialValues: Schema.dict(Schema.string()).description('specialValues.description').default({
    0: 'jrrp.special.1',
    50: 'jrrp.special.2',
    100: 'jrrp.special.3'
  }),
  ranges: Schema.array(Schema.object({
    min: Schema.number().description('ranges.min'),
    max: Schema.number().description('ranges.max'),
    message: Schema.string().description('ranges.message'),
  })).description('ranges.description').default([
    { min: 0, max: 9, message: 'jrrp.luck.range1' },
    { min: 10, max: 19, message: 'jrrp.luck.range2' },
    { min: 20, max: 39, message: 'jrrp.luck.range3' },
    { min: 40, max: 49, message: 'jrrp.luck.range4' },
    { min: 50, max: 69, message: 'jrrp.luck.range5' },
    { min: 70, max: 89, message: 'jrrp.luck.range6' },
    { min: 90, max: 95, message: 'jrrp.luck.range7' },
    { min: 96, max: 100, message: 'jrrp.luck.range8' },
  ]),
  specialDates: Schema.array(Schema.object({
    date: Schema.string().description('specialDates.date'),
    message: Schema.string().description('specialDates.message'),
  })).description('specialDates.description').default([
    { date: '01-01', message: 'jrrp.dates.new_year' },
    { date: '12-25', message: 'jrrp.dates.christmas' },
  ]),
  sleepMode: Schema.union([
    Schema.const(1).description('固定时长禁言'),
    Schema.const(2).description('禁言到固定时间'),
    Schema.const(3).description('随机时长禁言')
  ]).description('睡眠命令模式').default(1),
  sleepDuration: Schema.number().description('固定禁言时长(分钟)').default(30),
  sleepUntil: Schema.string().description('固定禁言结束时间(HH:mm)').default('06:00'),
  sleepRandomMin: Schema.number().description('随机禁言最小时长(分钟)').default(10),
  sleepRandomMax: Schema.number().description('随机禁言最大时长(分钟)').default(60),
}).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
})

export async function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))
  ctx.i18n.define('en-US', require('./locales/en-US'))

  ctx.command('jrrp', 'jrrp.description')
    .action(async ({ session }) => {
      const userId = session.userId
      const date = new Date()
      const dateStr = date.toLocaleDateString()
      const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

      // 检查是否是特殊日期
      const specialDate = config.specialDates?.find(sd => sd.date === mmdd)
      if (specialDate) {
        const confirm = await session.send(session.text(specialDate.message) + '\n' + session.text('jrrp.prompt'))
        const response = await session.prompt()
        if (!response || !['是', 'y', 'Y', 'yes'].includes(response.trim())) {
          return session.text('jrrp.cancel')
        }
      }

      // 获取用户昵称
      const user = await ctx.database.getUser('id', userId)
      const nickname = user?.name || 'User'

      // 使用用户ID和日期生成随机数
      const seed = `${userId}-${dateStr}`
      const hash = Array.from(seed).reduce((acc, char) => {
        return (acc * 31 + char.charCodeAt(0)) >>> 0
      }, 0)
      const rp = hash % 101 // 生成0-100的人品值

      // 修复特殊值消息处理
      let message = session.text('jrrp.result', [rp, nickname])
      if (config.specialValues && rp in config.specialValues) {
        message += '\n' + session.text(config.specialValues[rp])
      } else {
        for (const range of config.ranges) {
          if (rp >= range.min && rp <= range.max) {
            message += '\n' + session.text(range.message)
            break
          }
        }
      }
      return message
    })

  ctx.command('sleep', '精致睡眠')
    .alias('jzsm')
    .action(async ({ session }) => {
      if (!session.channelId || !session.guildId) {
        return session.text('commands.sleep.no_permission')
      }

      let duration: number
      const now = new Date()

      switch (config.sleepMode) {
        case 1:
          duration = Math.max(1, config.sleepDuration || 30)
          break
        case 2:
          const [hours, minutes] = (config.sleepUntil || '06:00').split(':').map(Number)
          const endTime = new Date(now)
          endTime.setHours(hours, minutes, 0, 0)
          if (endTime <= now) {
            endTime.setDate(endTime.getDate() + 1)
          }
          duration = Math.max(1, Math.floor((endTime.getTime() - now.getTime()) / 60000))
          break
        case 3:
          const min = Math.max(1, config.sleepRandomMin || 10)
          const max = Math.max(min, config.sleepRandomMax || 60)
          duration = Math.floor(Math.random() * (max - min + 1) + min)
          break
        default:
          return session.text('commands.sleep.invalid_mode')
      }

      try {
        const member = await session.bot.internal.getGuildMember?.(session.guildId, session.userId)
        if (!member?.mute) return session.text('commands.sleep.no_permission')
        await member.mute(duration * 60)
        return session.text('commands.sleep.success', [duration])
      } catch (error) {
        ctx.logger('sleep').warn(error)
        return session.text('commands.sleep.failed')
      }
    })
}
