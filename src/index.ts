import { Context, Schema } from 'koishi'

export const name = 'daily-tools'
export const inject = ['database']
export interface Config {
  /** 特殊人品值对应的消息 */
  specialValues?: Record<number, string>
  /** 人品值区间对应的消息 */
  ranges?: Record<string, string>
  /** 特殊日期对应的消息 */
  specialDates?: Record<string, string>
  /** 睡眠命令模式 */
  sleepMode?: 'fixed' | 'until' | 'random'
  /** 固定时长禁言的时长（分钟） */
  sleepDuration?: number
  /** 指定解除禁言的时间点 (HH:mm) */
  sleepUntil?: string
  /** 随机禁言的最小时长（分钟） */
  sleepRandomMin?: number
  /** 随机禁言的最大时长（分钟） */
  sleepRandomMax?: number
}

export const Config: Schema<Config> = Schema.intersect([
  // 基础配置部分
  Schema.object({
    // 特殊人品值配置
    specialValues: Schema.dict(Schema.string())
      .default({
        0: 'jrrp.special.1',   // 最差
        50: 'jrrp.special.2',  // 中等
        100: 'jrrp.special.3'  // 最好
      }),

    // 人品值区间配置
    ranges: Schema.dict(Schema.string())
      .default({
        '0-9': 'jrrp.luck.1',    // 极度不幸
        '10-19': 'jrrp.luck.2',  // 非常不幸
        '20-39': 'jrrp.luck.3',  // 不太走运
        '40-49': 'jrrp.luck.4',  // 一般般
        '50-69': 'jrrp.luck.5',  // 还不错
        '70-89': 'jrrp.luck.6',  // 运气好
        '90-95': 'jrrp.luck.7',  // 非常好运
        '96-100': 'jrrp.luck.8'  // 极度好运
      }),

    // 特殊日期配置
    specialDates: Schema.dict(Schema.string())
      .default({
        '01-01': 'jrrp.dates.new_year',   // 新年
        '12-25': 'jrrp.dates.christmas'    // 圣诞
      }),

    // 睡眠模式选择
    sleepMode: Schema.union([
      Schema.const('fixed'),
      Schema.const('until'),
      Schema.const('random')
    ]).default('fixed'),
  }),

  // 睡眠模式相关配置
  Schema.union([
    // 固定时长模式
    Schema.object({
      sleepMode: Schema.const('fixed').required(),
      sleepDuration: Schema.number().default(480),
    }),

    // 指定时间模式
    Schema.object({
      sleepMode: Schema.const('until').required(),
      sleepUntil: Schema.string()
        .default('08:00'),
    }),

    // 随机时长模式
    Schema.object({
      sleepMode: Schema.const('random').required(),
      sleepRandomMin: Schema.number().default(360),
      sleepRandomMax: Schema.number().default(600),
    }),
  ]),
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
        const confirm = await session.send(session.text(config.specialDates[mmdd]) + '\n' + session.text('jrrp.prompt'))
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
      const baseSeed = `${userId}-${dateStr}-v2` // 添加版本标记避免与旧版冲突
      const baseRandom = seededRandom(baseSeed)
      // 使用日期权重对基础随机值进行调整
      const weightedRandom = (baseRandom + dateWeight) / 2
      const rp = normalDistribution(weightedRandom)

      // 修复特殊值消息处理
      let message = session.text('jrrp.result', [rp, nickname])
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
  ctx.command('sleep', '精致睡眠')
    .alias('jzsm')
    .action(async ({ session }) => {
      if (!session.guildId) {
        return session.text('commands.sleep.guild_only')
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
          return session.text('commands.sleep.invalid_mode')
      }

      try {
        await session.bot.muteGuildMember(session.guildId, session.userId, duration * 60 * 1000)
        return session.text('commands.sleep.success', [duration])
      } catch (error) {
        ctx.logger('sleep').warn(error)
        return session.text('commands.sleep.failed')
      }
    })
}
