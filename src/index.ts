import { Context, Schema } from 'koishi'
import { registerVer, regVerCheck, UpdateTarget } from './ver'
import { registerPlayer } from './player'
import { registerInfo } from './info'

export const name = 'bot'
export const inject = {optional: ['puppeteer']}

export interface Config {
  noticeTargets: UpdateTarget[]
  updInterval: number
  verEnabled: boolean
  playerEnabled: boolean
  infoEnabled: boolean
  serverApis?: Array<{ type: 'java' | 'bedrock'; url: string }>
  serverTemplate?: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
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
  }).description('版本&玩家查询配置'),
  Schema.object({
    infoEnabled: Schema.boolean().description('启用服务器查询').default(true),
    serverApis: Schema.array(Schema.object({
      type: Schema.union([
        Schema.const('java').description('Java版'),
        Schema.const('bedrock').description('基岩版')
      ]).description('API 类型'),
      url: Schema.string().description('API URL （使用 ${address} 代替实际地址）')
    })).description('服务器查询 API ').default([
      { type: 'java', url: 'https://api.mcstatus.io/v2/status/java/${address}' },
      { type: 'bedrock', url: 'https://api.mcstatus.io/v2/status/bedrock/${address}' },
      { type: 'java', url: 'https://api.mcsrvstat.us/2/${address}' },
      { type: 'bedrock', url: 'https://api.mcsrvstat.us/bedrock/2/${address}' }
    ]).role('table'),
    serverTemplate: Schema.string().role('textarea')
    .description('服务器信息模板（使用{...}替换数据，[...]包围条件性显示内容）')
    .default('{icon}\n{name}\n{motd}\n{version} | {online}/{max} | {ping}ms\nIP: {ip}\nSRV: {srv}\n{edition} {gamemode} {software} {serverid} {eulablock}[\n在线玩家({playercount}):\n{playerlist:10}][\n插件列表({plugincount}):\n{pluginlist:10}][\n模组列表({modcount}):\n{modlist:10}]')
  }).description('服务器查询配置')
])

export function apply(ctx: Context, config: Config) {
  const mc = ctx.command('mc', 'Minecraft 工具')
  // 最新版本查询
  config.verEnabled !== false && registerVer(ctx, mc)
  config.noticeTargets?.length && regVerCheck(ctx, config)
  // 玩家信息查询
  config.playerEnabled !== false && registerPlayer(ctx, mc)
  // 服务器信息查询
  config.infoEnabled !== false && config.serverApis?.length && registerInfo(ctx, mc, config)
}