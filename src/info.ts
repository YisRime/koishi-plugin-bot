import { Context, h } from 'koishi'
import { Config } from './index'

interface ServerStatus {
  online: boolean
  host: string
  port: number
  ip_address?: string | null
  eula_blocked?: boolean
  retrieved_at?: number
  version?: { name_clean?: string, name?: string | null }
  players: { online: number | null, max: number | null, list?: string[] }
  motd?: string
  icon?: string | null
  mods?: { name: string, version?: string }[]
  software?: string | null
  plugins?: { name: string, version?: string | null }[]
  srv_record?: { host: string, port: number } | null
  gamemode?: string | null
  server_id?: string | null
  edition?: 'MCPE' | 'MCEE' | null
  error?: string
}

/**
 * 解析并验证 Minecraft 服务器地址
 */
function validateServerAddress(input: string): string {
  // 检查禁止的本地/内网地址
  const lowerAddr = input.toLowerCase();
  const forbiddenAddresses = ['localhost', '127.0.0.', '0.0.0.0', '::1', '::'];
  if (forbiddenAddresses.some(addr => lowerAddr.includes(addr)) ||
      /^fe80:|^f[cd]|^ff/.test(lowerAddr)) {
    throw new Error('无效地址');
  }
  // 解析端口
  let port: number | undefined;
  if (input.includes(':')) {
    const portMatch = input.match(/\]:(\d+)$/) || input.match(/:(\d+)$/);
    if (portMatch) {
      port = parseInt(portMatch[1], 10);
      if (port < 1 || port > 65535) throw new Error('无效端口');
    }
  }
  // 验证IPv4地址
  if (/^(\d{1,3}\.){3}\d{1,3}/.test(input)) {
    const ipPart = input.split(':')[0];
    const octets = ipPart.split('.').map(Number);
    // 检查内网和特殊IP地址
    const isInvalid =
      octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] > 223 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254);
    if (isInvalid) throw new Error('无效地址');
  }
  return input;
}

/**
 * 获取 Minecraft 服务器状态
 */
async function fetchServerStatus(server: string, forceType: 'java' | 'bedrock', config?: Config): Promise<ServerStatus> {
  try {
    const address = validateServerAddress(server);
    const serverType = forceType || 'java';
    const defaultPort = serverType === 'java' ? 25565 : 19132;
    const host = address.split(':')[0], port = parseInt(address.split(':')[1]) || defaultPort;
    const apiEndpoints = config?.serverApis?.filter(api => api.type === serverType)?.map(api => api.url) || [];
    const errors = [];
    for (const apiUrl of apiEndpoints) {
      try {
        const requestUrl = apiUrl.replace('${address}', address);
        const response = await fetch(requestUrl, {
          headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
          method: 'GET'
        });
        if (response.ok) return normalizeApiResponse(await response.json(), address, serverType);
        errors.push(`${requestUrl} 请求失败: ${response.status}`);
      } catch (error) {
        errors.push(`${apiUrl.replace('${address}', address)} 连接错误: ${error.message}`);
      }
    }
    return { online: false, host, port, players: { online: null, max: null }, error: `请求失败: ${errors.join('; ')}` };
  } catch (error) {
    return {
      online: false, host: server, port: forceType === 'bedrock' ? 19132 : 25565,
      players: { online: null, max: null }, error: `地址验证失败: ${error.message}`
    };
  }
}

/**
 * 标准化 API 响应格式，自动猜测可能的格式
 */
function normalizeApiResponse(data: any, address: string, serverType: 'java' | 'bedrock'): ServerStatus {
  // 检查服务器是否在线
  if (data.online === false || (data.status === 'error' && !data.players)) {
    return {
      online: false,
      host: data.hostname || data.host || data.ip || address.split(':')[0],
      port: data.port || parseInt(address.split(':')[1]) || (serverType === 'java' ? 25565 : 19132),
      players: { online: null, max: null },
      error: data.error || data.description
    };
  }
  // 统一处理各种 API 格式
  return {
    online: true,
    host: data.hostname || data.host || data.server || address.split(':')[0],
    port: data.port || parseInt(address.split(':')[1]) || (serverType === 'java' ? 25565 : 19132),
    ip_address: data.ip_address || data.ip,
    eula_blocked: data.eula_blocked || data.blocked,
    retrieved_at: data.debug?.cachetime ? data.debug.cachetime * 1000 :
                 data.retrieved_at || data.timestamp || data.query_time || Date.now(),
    version: {
      name_clean: data.version?.name_clean || data.version || data.server?.version || data.server_version,
      name: data.version?.name || data.protocol?.name || data.version?.protocol_name
    },
    players: {
      online: data.players?.online ?? data.players?.now ?? data.players_online ?? data.online_players ?? 0,
      max: data.players?.max ?? data.max_players ?? 0,
      list: Array.isArray(data.players?.list)
        ? data.players.list.map(p => typeof p === 'string' ? p : p.name || p.name_clean || p.id)
        : (data.players?.sample?.map(p => p.name) || data.player_list)
    },
    motd: data.motd?.clean?.[0] || (Array.isArray(data.motd?.clean) ? data.motd.clean[0] : null) ||
          data.motd?.raw?.[0] || data.motd || data.description?.text || data.description || data.server_motd,
    icon: data.icon || data.favicon,
    mods: (data.mods && (Array.isArray(data.mods)
           ? data.mods.map(m => typeof m === 'string' ? { name: m } : m)
           : Object.entries(data.mods).map(([k, v]) => ({ name: k, version: v }))))
           || data.modinfo?.modList?.map(m => ({ name: m.modid, version: m.version }))
           || data.modlist,
    software: data.software || data.server?.name || data.server_software,
    plugins: (data.plugins && (Array.isArray(data.plugins)
              ? data.plugins.map(p => typeof p === 'string' ? { name: p } : p)
              : Object.entries(data.plugins).map(([k, v]) => ({ name: k, version: v }))))
              || data.plugin_list,
    srv_record: data.srv_record || data.srv,
    gamemode: data.gamemode || data.game_type,
    server_id: data.server_id || data.serverid || data.uuid,
    edition: data.edition
  };
}

/**
 * 格式化服务器状态信息
 */
function formatServerStatus(status: ServerStatus, config: Config) {
  if (!status.online) return status.error || '服务器离线 - 连接失败';
  // 格式化函数
  const formatList = (items?: any[], limit?: number) => {
    if (!items?.length) return '';
    const show = limit ?? items.length;
    return items.slice(0, show)
      .map(i => i.version ? `${i.name}-${i.version}` : i.name)
      .join(', ') + (show < items.length ? '...' : '');
  };
  // 各部分内容生成器
  const parts = {
    name: () => `${status.host}:${status.port}`,
    ip: () => status.ip_address,
    srv: () => status.srv_record ? `${status.srv_record.host}:${status.srv_record.port}` : '',
    icon: () => status.icon?.startsWith('data:image/png;base64,') ? h.image(status.icon).toString() : '',
    motd: () => status.motd,
    version: () => status.version?.name_clean || '未知',
    playersonline: () => `${status.players.online ?? 0}`,
    playersmax: () => `${status.players.max ?? 0}`,
    playercount: () => `${status.players.online ?? 0}/${status.players.max ?? 0}`,
    pingms: () => status.retrieved_at ? `${Date.now() - status.retrieved_at}` : '',
    software: () => status.software,
    edition: () => status.edition ? { MCPE: '基岩版', MCEE: '教育版' }[status.edition] || status.edition : '',
    gamemode: () => status.gamemode,
    eulablock: () => status.eula_blocked ? '已被封禁' : '',
    serverid: () => status.server_id,
    playerlist: (limit?: number) => formatList(status.players.list, limit),
    playerscount: () => `${status.players.list?.length || 0}`,
    pluginslist: (limit?: number) => formatList(status.plugins, limit),
    pluginscount: () => `${status.plugins?.length || 0}`,
    modslist: (limit?: number) => formatList(status.mods, limit),
    modscount: () => `${status.mods?.length || 0}`
  };
  // 使用模板格式化输出
  const template = config.serverTemplate || `${status.host}:${status.port} - ${status.version?.name_clean || '未知'}`;
  // 替换占位符并清理结果
  return template.match(/\{([^{}]+)\}/g)?.reduce((result, placeholder) => {
    const [name, limitStr] = placeholder.slice(1, -1).split(':');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const text = parts[name]?.(limit);
    return !text
      ? result.replace(new RegExp(`\\s*${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '')
      : result.replace(placeholder, text);
  }, template)
  .trim();
}

/**
 * 注册服务器信息命令
 */
export function registerInfo(ctx: Context, parent: any, config: Config) {
  const mcinfo = parent.subcommand('.info <server>', '查询 Minecraft 服务器信息')
    .usage(`mc.info <地址[:端口]> - 查询 Java 服务器\nmc.info.be <地址[:端口]> - 查询 Bedrock 服务器`)
    .action(async ({}, server) => {
      try {
        const status = await fetchServerStatus(server, 'java', config);
        return formatServerStatus(status, config);
      } catch (error) {
        return error.message;
      }
    });
  mcinfo.subcommand('.be <server>', '查询 Bedrock 服务器')
    .action(async ({}, server) => {
      try {
        const status = await fetchServerStatus(server, 'bedrock', config);
        return formatServerStatus(status, config);
      } catch (error) {
        return error.message;
      }
    });
}