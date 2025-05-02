import { Context, Schema } from 'koishi'
import { registerVer, regVerCheck, UpdateTarget } from './ver'
import { registerPlayer } from './player'

export const name = 'bot'
export const inject = {optional: ['puppeteer']}

export interface Config {
  noticeTargets: UpdateTarget[]
  updInterval: number
  verEnabled: boolean
  playerEnabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  playerEnabled: Schema.boolean().description('启用玩家信息查询').default(true),
  verEnabled: Schema.boolean().description('启用最新版本查询').default(true),
  updInterval: Schema.number().description('更新检查间隔(分钟)').default(5).min(1).max(1440),
  noticeTargets: Schema.array(Schema.object({
    platform: Schema.string().description('平台ID'),
    channelId: Schema.string().description('频道ID'),
    type: Schema.union([
      Schema.const('release').description('仅正式版'),
      Schema.const('snapshot').description('仅快照版'),
      Schema.const('both').description('所有版本')
    ]).description('推送类型').default('both')
  })).description('版本更新推送目标').role('table')
})

export function apply(ctx: Context, config: Config) {
  const mc = ctx.command('mc', 'Minecraft 工具')
  // 最新版本查询
  config.verEnabled !== false && registerVer(ctx, mc)
  config.noticeTargets?.length && regVerCheck(ctx, config)
  // 玩家信息查询
  config.playerEnabled !== false && registerPlayer(ctx, mc)
}