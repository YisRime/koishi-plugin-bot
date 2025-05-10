import { Context, Schema } from 'koishi'
import { registerPlayer } from './tool/player'
import { registerInfo } from './server/info'
import { registerServer } from './server/server'
import { registerVer, regVerCheck, UpdTarget, cleanupVerCheck, ServerMaps } from './tool/ver'
import { initWebSocket, cleanupWebSocket, WsServerConfig, RconServerConfig } from './server/service'
import { registerCurseForge } from './resource/curseforge'
import { registerModrinth } from './resource/modrinth'
import { registerSearch } from './resource/search'
import { registerMcmod } from './resource/mcmod'
import { registerMcwiki } from './resource/mcwiki'

export const name = 'bot'
export const inject = {optional: ['puppeteer']}

export interface Config {
  noticeTargets: UpdTarget[]
  updInterval: number
  verEnabled: boolean
  playerEnabled: boolean
  infoEnabled: boolean
  serverApis?: Array<{ type: 'java' | 'bedrock'; url: string }>
  serverTemplate: string
  serverMaps: ServerMaps[]
  rconServers: RconServerConfig[]
  wsServers: WsServerConfig[]
  useForward: boolean
  useScreenshot: boolean
  curseforgeEnabled: boolean
  modrinthEnabled: boolean
  mcmodEnabled: boolean
  mcwikiEnabled: boolean
  curseforgeApiKey?: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    mcwikiEnabled: Schema.boolean().description('启用 Minecraft Wiki 查询').default(true),
    mcmodEnabled: Schema.boolean().description('启用 MCMOD 查询').default(true),
    modrinthEnabled: Schema.boolean().description('启用 Modrinth 查询').default(true),
    curseforgeEnabled: Schema.boolean().description('启用 CurseForge 查询').default(true)
  }).description('查询开关配置'),
  Schema.object({
    useForward: Schema.boolean().description('启用合并转发输出').default(true),
    useScreenshot: Schema.boolean().description('启用网页截图选项').default(true),
    curseforgeApiKey: Schema.string().description('CurseForge API 密钥').role('secret'),
  }).description('资源查询配置'),
  Schema.object({
    playerEnabled: Schema.boolean().description('启用玩家信息查询').default(true),
    verEnabled: Schema.boolean().description('启用最新版本查询').default(true),
    updInterval: Schema.number().description('更新检查间隔(分钟)').default(5).min(1).max(1440),
    noticeTargets: Schema.array(Schema.object({
      platform: Schema.string().description('平台 ID'),
      channelId: Schema.string().description('频道 ID'),
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
      url: Schema.string().description('API URL （使用 ${address} 指代地址）')
    })).description('服务器查询 API ').default([
      { type: 'java', url: 'https://api.mcstatus.io/v2/status/java/${address}' },
      { type: 'bedrock', url: 'https://api.mcstatus.io/v2/status/bedrock/${address}' },
      { type: 'java', url: 'https://api.mcsrvstat.us/2/${address}' },
      { type: 'bedrock', url: 'https://api.mcsrvstat.us/bedrock/2/${address}' },
      { type: 'java', url: 'https://api.imlazy.ink/mcapi?type=json&host=${address}' },
      { type: 'bedrock', url: 'https://api.imlazy.ink/mcapi?type=json&host=${address}&be=true' }
    ]).role('table'),
    serverTemplate: Schema.string().role('textarea')
    .description('服务器信息模板（使用[...]包含存在{...:x}指代的数据才会显示的内容，冒号后的数字代表显示数量）')
    .default('{icon}\n{name}\n{motd}\n{version} | {online}/{max} | {ping}ms\nIP:{ip}\nSRV:{srv}\n{edition} {gamemode} {software} {serverid} {eulablock}[\n在线玩家({playercount}):\n{playerlist:10}][\n插件列表({plugincount}):\n{pluginlist:10}][\n模组列表({modcount}):\n{modlist:10}]')
  }).description('服务器查询配置'),
  Schema.object({
    serverMaps: Schema.array(Schema.object({
      serverId: Schema.number().description('服务器 ID').required(),
      platform: Schema.string().description('平台 ID'),
      channelId: Schema.string().description('频道 ID'),
      serverAddress: Schema.string().description('服务器地址'),
    })).description('服务器映射群组').default([]).role('table'),
    rconServers: Schema.array(Schema.object({
      id: Schema.number().description('服务器 ID').required(),
      rconAddress: Schema.string().description('地址').default('localhost:25575'),
      rconPassword: Schema.string().description('密码').role('secret')
    })).description('RCON 配置').default([]).role('table'),
    wsServers: Schema.array(Schema.object({
      id: Schema.number().description('服务器 ID').required(),
      name: Schema.string().description('名称').default('Server'),
      websocketMode: Schema.union([
        Schema.const('client').description('客户端'),
        Schema.const('server').description('服务端')
      ]).description('模式').default('server'),
      websocketAddress: Schema.string().description('地址').default('localhost:8080'),
      websocketToken: Schema.string().description('密码').role('secret')
    })).description('WebSocket 配置').default([]).role('table')
  }).description('服务器连接配置')
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
  // 服务器连接
  if (config.rconServers.length > 0 || config.wsServers.length > 0) registerServer(mc, config)
  if (config.wsServers.length > 0) initWebSocket(ctx, config)
  // 资源查询
  if (config.modrinthEnabled) registerModrinth(ctx, mc, config)
  if (config.curseforgeEnabled && config.curseforgeApiKey) registerCurseForge(ctx, mc, config)
  if (config.mcmodEnabled) registerMcmod(ctx, mc, config)
  if (config.mcwikiEnabled) registerMcwiki(ctx, mc, config)
  // 统一搜索
  if (config.mcmodEnabled || config.mcwikiEnabled || config.modrinthEnabled
    || (config.curseforgeEnabled && config.curseforgeApiKey)) registerSearch(ctx, mc, config)
}

export function dispose() {
  cleanupWebSocket()
  cleanupVerCheck()
}