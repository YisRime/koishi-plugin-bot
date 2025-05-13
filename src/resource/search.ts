import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { PLATFORMS, CF_MAPS } from './maps'

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
    .option('mcmod', '-mod 搜索 MCMOD 百科')
    .option('mcwiki', '-wiki 搜索 Minecraft Wiki')
    .option('shot', '-s 使用截图模式')
    .option('mrs', '-mrs <sort:string> [MR]排序方式')
    .option('mrf', '-mrf <facets:string> [MR]高级过滤')
    .option('cfl', '-cfl <loader:string> [CF]加载器')
    .option('cfs', '-cfs <sort:string> [CF]排序方式')
    .option('cfo', '-cfo <order:string> [CF]升降序')
    .option('version', '-v <version:string> 支持版本')
    .option('type', `-t <type:string> 资源类型(${Object.keys(CF_MAPS.TYPE).join('|')})`)
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        const platformsToSearch =
          [options.mr && 'modrinth', options.cf && 'curseforge',
           options.mcmod && 'mcmod', options.mcwiki && 'mcwiki']
            .filter(Boolean);
        if (!platformsToSearch.length) platformsToSearch.push('modrinth', 'curseforge');
        // 参数配置
        const platformOptions = {
          modrinth: {
            facets: options.mrf || (options.type && JSON.stringify([[`project_type:${options.type}`]])),
            sort: options.mrs, version: options.version
          },
          curseforge: {
            categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
            gameVersion: options.version,
            modLoaderType: options.cfl ? CF_MAPS.LOADER[options.cfl] : undefined,
            sortField: options.cfs, sortOrder: options.cfo
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