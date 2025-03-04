import { Context, Schema } from 'koishi'

export const name = 'statistical-ranking'
export const inject = { required: ['database'] }

// 配置定义
export interface Config {
  enableLegacyImport?: boolean
}

export const Config: Schema<Config> = Schema.object({
  enableLegacyImport: Schema.boolean().default(false).description('启用统计数据导入')
})

// 类型定义
declare module 'koishi' {
  interface Tables {
    'analytics.stat': StatRecord
    'analytics.command': LegacyCommandRecord
    binding: BindingRecord
  }
}

interface StatRecord {
  type: 'command' | 'message'
  platform: string
  channelId: string
  userId: string
  command?: string
  count: number
  lastTime: Date
}

interface LegacyCommandRecord {
  name: string
  userId: string
  channelId: string
  platform?: string
  date: number
  hour: number
  count: number
}

interface BindingRecord {
  pid: string
  platform: string
  aid: number
  bid: number
}

// 工具函数
const utils = {
  async getName(session: any, id: string, type: 'user' | 'guild'): Promise<string> {
    try {
      if (type === 'user') {
        const info = await session.bot.getGuildMember?.(session.channelId, id)
        return info?.nickname || info?.username || id
      } else {
        const guilds = await session.bot.getGuildList()
        const guild = (Array.isArray(guilds) ? guilds : [guilds])
          .find(g => g.id === id)
        return guild?.name || id
      }
    } catch {
      return id
    }
  },

  formatCount(count: number): string {
    return count.toString().padStart(6, ' ')
  },

  formatCommand(command: string): string {
    return command.padEnd(15, ' ')
  },

  formatTimeAgo(date: Date): string {
    if (isNaN(date.getTime())) {
      return '未知时间'
    }

    const now = Date.now()
    if (date.getTime() > now) {
      date = new Date()
    }

    const diff = Math.max(0, now - date.getTime())
    if (diff < 300000) return '一会前'

    const units = [
      { div: 31536000000, unit: '年' },
      { div: 2592000000, unit: '月' },
      { div: 86400000, unit: '天' },
      { div: 3600000, unit: '小时' },
      { div: 60000, unit: '分钟' }
    ]

    const parts = []
    let remaining = diff

    for (const { div, unit } of units) {
      const val = Math.floor(remaining / div)
      if (val > 0) {
        parts.push(`${val} ${unit}`)
        remaining %= div
        if (parts.length === 2) break
      }
    }

    return parts.length ? parts.join(' ') + '前' : '一会前'
  }
}

// 数据库操作
const database = {
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      type: 'string',
      platform: 'string',
      channelId: 'string',
      userId: 'string',
      command: 'string',
      count: 'unsigned',
      lastTime: 'timestamp',
    }, {
      primary: ['type', 'platform', 'channelId', 'userId', 'command'],
    })
  },

  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    if (!data.type || !data.platform || !data.channelId || !data.userId) {
      ctx.logger.warn('saveRecord: missing required fields', data)
      return
    }

    const query = {
      type: data.type,
      platform: data.platform,
      channelId: data.channelId,
      userId: data.userId,
      command: data.type === 'command' ? data.command || '' : '',
    }

    try {
      const existing = await ctx.database.get('analytics.stat', query)
      if (existing.length) {
        await ctx.database.set('analytics.stat', query, {
          count: existing[0].count + 1,
          lastTime: new Date(),
        })
      } else {
        await ctx.database.create('analytics.stat', {
          ...query,
          count: 1,
          lastTime: new Date(),
        })
      }
    } catch (e) {
      ctx.logger.error('Failed to save stat record:', e)
    }
  },

  async importLegacyData(ctx: Context, session?: any, overwrite = false) {
    const hasLegacyTable = Object.keys(ctx.database.tables).includes('analytics.command')
    if (!hasLegacyTable) {
      throw new Error('未找到历史数据')
    }

    const legacyCommands = await ctx.database.get('analytics.command', {})
    session.send(`发现 ${legacyCommands.length} 条历史命令记录`)

    if (overwrite) {
      await ctx.database.remove('analytics.stat', { type: 'command' })
    }

    const bindings = await ctx.database.get('binding', {})
    const userIdMap = new Map<string, string>()
    for (const binding of bindings) {
      const key = `${binding.platform}:${binding.aid}`
      if (binding.pid) userIdMap.set(key, binding.pid)
    }

    let importedCount = 0

    for (const cmd of legacyCommands) {
      const platform = cmd.platform || ''
      const key = `${platform}:${cmd.userId}`
      const realUserId = userIdMap.get(key) || cmd.userId
      const command = cmd.name || ''

      const query = {
        type: 'command' as const,
        platform,
        channelId: cmd.channelId,
        userId: realUserId,
        command,
      }

      try {
        if (!overwrite) {
          const existing = await ctx.database.get('analytics.stat', query)
          if (existing.length) {
            const timestamp = cmd.date * 86400000 + cmd.hour * 3600000
            const validTime = new Date(timestamp)
            const now = Date.now()
            const importTime = isNaN(validTime.getTime()) || validTime.getTime() > now
              ? new Date()
              : validTime

            await ctx.database.set('analytics.stat', query, {
              count: existing[0].count + (cmd.count || 1),
              lastTime: new Date(Math.max(
                existing[0].lastTime.getTime(),
                importTime.getTime()
              ))
            })
            importedCount++
            continue
          }
        }

        const timestamp = cmd.date * 86400000 + cmd.hour * 3600000
        const validTime = new Date(timestamp)
        const now = Date.now()
        const lastTime = isNaN(validTime.getTime()) || validTime.getTime() > now
          ? new Date()
          : validTime

        await ctx.database.create('analytics.stat', {
          ...query,
          count: cmd.count || 1,
          lastTime
        })
        importedCount++
      } catch (e) {
        ctx.logger.error('Failed to import record:', e, query)
      }

    }
  },

  async clearStats(ctx: Context, options: {
    type?: 'command' | 'message'
    userId?: string
    platform?: string
    channelId?: string
    command?: string
  }) {
    const query: any = {}
    for (const [key, value] of Object.entries(options)) {
      if (value) query[key] = value
    }
    const result = await ctx.database.remove('analytics.stat', query)
    return Number(result ?? 0)
  }
}

export async function apply(ctx: Context, config: Config) {
  database.initialize(ctx)

  ctx.on('command/before-execute', ({session, command}) =>
    database.saveRecord(ctx, {
      type: 'command',
      platform: session.platform,
      channelId: session.channelId,
      userId: session.userId,
      command: command.name
    }))

  ctx.on('message', (session) =>
    database.saveRecord(ctx, {
      type: 'message',
      platform: session.platform,
      channelId: session.channelId,
      userId: session.userId
    }))

  const stat = ctx.command('stat', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('group', '-g [group:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({options}) => {
      const query: any = { type: 'command' }
      if (options.user) query.userId = options.user
      if (options.group) query.channelId = options.group
      if (options.platform) query.platform = options.platform
      if (options.command) query.command = options.command

      const records = await ctx.database.get('analytics.stat', query)
      if (!records.length) return '未找到相关记录'

      const conditions = []
      if (options.user) conditions.push(`用户 ${options.user}`)
      if (options.group) conditions.push(`群组 ${options.group}`)
      if (options.platform) conditions.push(`平台 ${options.platform}`)
      if (options.command) conditions.push(`命令 ${options.command}`)
      const title = conditions.length
        ? `${conditions.join(' ')} 命令统计 ——`
        : '全局命令统计 ——'

      // 修改统计逻辑，将子命令合并到主命令
      const stats = records.reduce((map, record) => {
        // 提取主命令名称（去掉子命令部分）
        const mainCommand = record.command.split('.')[0]
        const curr = map.get(mainCommand) || { count: 0, lastTime: record.lastTime }
        curr.count += record.count
        if (record.lastTime > curr.lastTime) curr.lastTime = record.lastTime
        map.set(mainCommand, curr)
        return map
      }, new Map())

      const lines = Array.from(stats.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .map(([key, {count, lastTime}]) =>
          `${utils.formatCommand(key)}${utils.formatCount(count)} 次  ${utils.formatTimeAgo(lastTime).padEnd(20, ' ')}`)

      return title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.clear', '清除统计数据')
    .option('type', '-t <type:string> 指定清除类型', { authority: 3 })
    .option('user', '-u [user:string] 指定用户')
    .option('platform', '-p [platform:string] 指定平台')
    .option('group', '-g [group:string] 指定群组')
    .option('command', '-c [command:string] 指定命令')
    .action(async ({ options }) => {
      const type = options.type as 'command' | 'message'
      if (type && !['command', 'message'].includes(type)) {
        return '无效类型'
      }

      await database.clearStats(ctx, {
        type,
        userId: options.user,
        platform: options.platform,
        channelId: options.group,
        command: options.command
      })

      const conditions = []
      if (type) conditions.push(type === 'command' ? '命令' : '消息')
      if (options.user) conditions.push(`用户 ${options.user}`)
      if (options.platform) conditions.push(`平台 ${options.platform}`)
      if (options.group) conditions.push(`群组 ${options.group}`)
      if (options.command) conditions.push(`命令 ${options.command}`)

      return conditions.length
        ? `已删除${conditions.join('、')}的统计记录`
        : '已删除所有统计记录'
    })

  if (config.enableLegacyImport) {
    stat.subcommand('.import', '导入历史统计数据')
      .option('force', '-f 覆盖现有数据')
      .action(async ({ session, options }) => {
        try {
          await database.importLegacyData(ctx, session, options.force)
          return '导入完成'
        } catch (e) {
          return `导入失败：${e.message}`
        }
      })
  }

  stat.subcommand('.user', '查看发言统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('group', '-g [group:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .action(async ({session, options}) => {
      const query: any = { type: 'message' }
      if (options.user) query.userId = options.user
      if (options.group) query.channelId = options.group
      if (options.platform) query.platform = options.platform

      const records = await ctx.database.get('analytics.stat', query)
      if (!records.length) return '未找到相关记录'

      const conditions = []
      if (options.user) conditions.push(`用户 ${options.user}`)
      if (options.group) conditions.push(`群组 ${options.group}`)
      if (options.platform) conditions.push(`平台 ${options.platform}`)
      const title = conditions.length
        ? `${conditions.join(' ')} 发言统计 ——`
        : '全局发言统计 ——'

      const stats = records.reduce((map, record) => {
        const key = record.userId
        const curr = map.get(key) || { count: 0, lastTime: record.lastTime }
        curr.count += record.count
        if (record.lastTime > curr.lastTime) curr.lastTime = record.lastTime
        map.set(key, curr)
        return map
      }, new Map())

      const lines = await Promise.all(Array.from(stats.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .map(async ([key, {count, lastTime}]) =>
          `${await utils.getName(session, key, 'user')}: ${count}条（${utils.formatTimeAgo(lastTime)}）`))

      return title + '\n' + lines.join('\n')
    })
}
