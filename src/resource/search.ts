import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { searchModrinthProjects, getModrinthProject } from './modrinth'
import { searchCurseForgeProjects, getCurseForgeProject } from './curseforge'
import { searchMcmodProjects, getMcmodProject } from './mcmod'
import { searchMcwikiPages, getMcwikiPage } from './mcwiki'

/**
 * 支持的平台配置，包含各平台的搜索、详情获取和数据转换方法
 * @type {Object}
 */
const PLATFORMS = {
  modrinth: {
    name: 'Modrinth',
    /**
     * 搜索Modrinth项目
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {any} options - 搜索选项
     * @returns {Promise<Array>} 搜索结果列表
     */
    search: (ctx, keyword, config, options: any = {}) => searchModrinthProjects(ctx, keyword, {
      ...options, limit: options.limit || config.searchResults, offset: options.offset
    }),
    /**
     * 获取Modrinth项目详情
     * @type {Function}
     */
    getDetail: getModrinthProject,
    /**
     * 转换Modrinth项目数据为统一格式
     * @param {Object} p - 项目数据
     * @returns {Object} 统一格式的项目数据
     */
    transform: p => ({
      platform: 'Modrinth', name: p.title, description: p.description,
      url: `https://modrinth.com/${p.project_type}/${p.slug}`,
      extra: { id: p.project_id, type: p.project_type, author: p.author, downloads: p.downloads }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.modrinthEnabled
  },
  curseforge: {
    name: 'CurseForge',
    /**
     * 搜索CurseForge项目
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Array>} 搜索结果列表
     */
    search: (ctx, keyword, config, options = {}) => searchCurseForgeProjects(ctx, keyword, config.curseforgeEnabled, options),
    /**
     * 获取CurseForge项目详情
     * @param {Context} ctx - Koishi上下文
     * @param {string} id - 项目ID
     * @param {Config} config - 配置对象
     * @returns {Promise<Object>} 项目详情
     */
    getDetail: (ctx, id, config) => getCurseForgeProject(ctx, id, config.curseforgeEnabled),
    /**
     * 转换CurseForge项目数据为统一格式
     * @param {Object} p - 项目数据
     * @returns {Object} 统一格式的项目数据
     */
    transform: p => ({
      platform: 'CurseForge', name: p.name, description: p.summary,
      url: p.links?.websiteUrl || '',
      extra: { id: p.id, author: p.authors.map(a => a.name).join(', '), downloads: p.downloadCount, type: p.classId }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.curseforgeEnabled
  },
  mcmod: {
    name: 'MCMOD',
    /**
     * 搜索MCMOD项目
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Array>} 搜索结果列表
     */
    search: searchMcmodProjects,
    /**
     * 获取MCMOD项目详情
     * @param {Context} ctx - Koishi上下文
     * @param {string} id - 项目ID
     * @param {Config} config - 配置对象
     * @returns {Promise<Object>} 项目详情
     */
    getDetail: getMcmodProject,
    /**
     * 转换MCMOD项目数据为统一格式
     * @param {Object} p - 项目数据
     * @returns {Object} 统一格式的项目数据
     */
    transform: p => ({
      platform: 'MCMOD', name: p.name, description: p.description,
      url: `https://www.mcmod.cn/item/${p.id}.html`,
      extra: { id: p.id, type: p.type, mcversion: p.mcversion }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.mcmodEnabled
  },
  mcwiki: {
    name: 'Minecraft Wiki',
    /**
     * 搜索Minecraft Wiki页面
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Array>} 搜索结果列表
     */
    search: searchMcwikiPages,
    /**
     * 获取Minecraft Wiki页面详情
     * @param {Context} ctx - Koishi上下文
     * @param {string} id - 页面ID
     * @param {Config} config - 配置对象
     * @returns {Promise<Object>} 页面详情
     */
    getDetail: getMcwikiPage,
    /**
     * 转换Minecraft Wiki页面数据为统一格式
     * @param {Object} p - 页面数据
     * @returns {Object} 统一格式的页面数据
     */
    transform: p => ({
      platform: 'Minecraft Wiki', name: p.title, description: p.snippet.replace(/<\/?[^>]+(>|$)/g, ''),
      url: `https://minecraft.fandom.com/zh/wiki/${encodeURIComponent(p.title)}`,
      extra: { id: p.pageid }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.mcwikiEnabled
  }
}

/**
 * CurseForge资源类型映射
 * @type {Object}
 */
const cfTypeMap = {
  'mod': 6, 'resourcepack': 12, 'world': 17, 'plugin': 5,
  'modpack': 4471, 'addon': 4559, 'customization': 4546,
  'shader': 6552, 'datapack': 6945
}

/**
 * CurseForge加载器类型映射
 * @type {Object}
 */
const cfLoaderMap = {
  'any': 0, 'forge': 1, 'cauldron': 2, 'liteloader': 3,
  'fabric': 4, 'quilt': 5, 'neoforge': 6
}

/**
 * 注册搜索命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令对象
 * @param {Config} config - 配置对象
 */
export function registerSearch(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.search <keyword:text>', '搜索 Minecraft 资源')
    .option('mr', '-mr 搜索 Modrinth')
    .option('cf', '-cf 搜索 CurseForge')
    .option('mcmod', '-m 搜索 MCMOD 百科')
    .option('mcwiki', '-w 搜索 Minecraft Wiki')
    .option('all', '-a 搜索所有')
    .option('shot', '-s 使用截图模式')
    .option('mrs', '-mrs <sort:string> [MR]排序方式')
    .option('mrf', '-mrf <facets:string> [MR]高级过滤')
    .option('offset', '-mro <offset:number> [MR]跳过数量')
    .option('mrl', '-mrl <limit:number> [MR]结果数量')
    .option('cfl', '-cfl <loader:string> [CF]加载器')
    .option('cfs', '-cfs <sort:string> [CF]排序方式')
    .option('cfo', '-cfo <order:string> [CF]升降序')
    .option('cfi', '-cfi <index:number> [CF]跳过数量')
    .option('cfp', '-cfp <pageSize:number> [CF]结果数量')
    .option('version', '-v <version:string> 支持版本')
    .option('type', `-t <type:string> 资源类型(${Object.keys(cfTypeMap).join('|')})`)
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        const platformsToSearch = options.all ? Object.keys(PLATFORMS) :
          [options.mr && 'modrinth', options.cf && 'curseforge',
           options.mcmod && 'mcmod', options.mcwiki && 'mcwiki']
            .filter(Boolean);
        if (!platformsToSearch.length) platformsToSearch.push('modrinth', 'curseforge');
        // 参数配置
        const platformOptions = {
          modrinth: {
            facets: options.mrf || (options.type && JSON.stringify([[`project_type:${options.type}`]])),
            sort: options.mrs, version: options.version, offset: options.offset,
            limit: options.mrl ? Math.min(options.mrl, 100) : Math.min(config.searchResults, 100)
          },
          curseforge: {
            categoryId: options.type ? cfTypeMap[options.type] : undefined,
            gameVersion: options.version,
            modLoaderType: options.cfl ? cfLoaderMap[options.cfl] : undefined,
            sortField: options.cfs, sortOrder: options.cfo,
            pageSize: options.cfp > 50 ? 50 : options.cfp, index: options.cfi
          },
          mcmod: { type: options.type },
          mcwiki: {}
        }
        // 并行搜索
        const searchResults = await Promise.all(
          platformsToSearch.map(async p => {
            const platform = PLATFORMS[p]
            if (!platform?.checkConfig(config)) return { platform: p, results: [] }
            try {
              const projects = await platform.search(ctx, keyword, config, platformOptions[p] || {})
              return { platform: p, results: projects.map(platform.transform) }
            } catch (error) {
              ctx.logger.error(`${platform.name} 搜索失败:`, error)
              return { platform: p, results: [] }
            }
          })
        )
        // 整理结果
        const resultsByPlatform = {}
        searchResults.forEach(({ platform, results }) => {if (results.length > 0) resultsByPlatform[platform] = results})
        // 检查结果
        if (Object.keys(resultsByPlatform).length === 0) {
          const platformNames = platformsToSearch.map(p => PLATFORMS[p]?.name || p).join('、')
          return `未找到匹配的资源：${platformNames}${options.type ? `，类型: ${options.type}` : ''}${options.version ? `，版本: ${options.version}` : ''}`
        }
        // 过滤和交错排列结果
        const filtered = {};
        for (const platform in resultsByPlatform) {
          let results = resultsByPlatform[platform];
          // 版本过滤
          if (options.version && platform === 'mcmod') results = results.filter(item => !item.extra?.mcversion || item.extra.mcversion.includes(options.version));
          // 类型过滤
          if (options.type) {
            if (platform === 'modrinth') {
              const validTypes = ['mod', 'modpack', 'resourcepack', 'shader'];
              if (validTypes.includes(options.type)) results = results.filter(item => item.extra?.type === options.type);
            } else if (platform === 'mcmod') {
              results = results.filter(item => !item.extra?.type || item.extra.type.toLowerCase().includes(options.type.toLowerCase()));
            }
          }
          if (results.length > 0) filtered[platform] = results;
        }
        // 交错排列
        const combinedResults = [];
        let hasMore = true;
        let index = 0;
        while (hasMore && combinedResults.length < config.searchResults) {
          hasMore = false;
          for (const platform in filtered) {
            if (index < filtered[platform].length) {
              combinedResults.push(filtered[platform][index]);
              hasMore = true;
              if (combinedResults.length >= config.searchResults) break;
            }
          }
          index++;
        }
        // 格式化结果列表
        const formattedResults = ['请回复序号查看对应详情：'].concat(
          combinedResults.map((p, i) => {
            const desc = config.searchDesc > 0 && p.description
              ? `\n  ${p.description.substring(0, config.searchDesc)}${p.description.length > config.searchDesc ? '...' : ''}`
              : '';
            return `${i + 1}. [${p.platform}] ${p.name}${desc}`;
          })
        );
        await renderOutput(session, formattedResults, null, ctx, config, false)
        // 获取用户选择
        const choice = parseInt(await session.prompt(60 * 1000))
        if (isNaN(choice) || choice < 1 || choice > combinedResults.length) return `请输入 1-${combinedResults.length} 之间的数字`
        // 获取详情
        const selected = combinedResults[choice - 1]
        const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform)
        const detailId = selected.platform === 'MCMOD' ? selected : selected.extra.id
        const detail = await platform?.getDetail(ctx, detailId, config)
        if (!detail) return '获取详情失败'
        return renderOutput(session, detail.content, detail.url, ctx, config, options.shot)
      } catch (error) {
        ctx.logger.error('搜索执行失败:', error)
        return '搜索时发生错误，请稍后再试'
      }
    })
}