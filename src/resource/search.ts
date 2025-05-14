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
  mc.subcommand('.search <keyword:string>', '搜索 Minecraft 资源')
    .option('platform', '-p <platform:string> 指定平台')
    .option('mrs', '-mrs <sort:string> [MR]排序方式')
    .option('mrf', '-mrf <facets:string> [MR]高级过滤')
    .option('cfl', '-cfl <loader:string> [CF]加载器')
    .option('cfs', '-cfs <sort:string> [CF]排序方式')
    .option('cfo', '-cfo <order:string> [CF]升降序')
    .option('version', '-v <version:string> 支持版本')
    .option('skip', '-k <count:number> 跳过结果数')
    .option('what', '-w <what:string> [Wiki]搜索范围')
    .option('type', `-t <type:string> 资源类型(${Object.keys(CF_MAPS.TYPE).join('|')})`)
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '需要关键词'
      try {
        let platformResults: Record<string, any[]> = {}, platformOffsets = {}, exhaustedPlatforms = {};
        let currentPage = 0;
        let skip = Math.max(0, options.skip);
        // 确定搜索平台
        let platformsToSearch = [];
        if (options.platform) {
          const platforms = options.platform.toLowerCase().split(',');
          platformsToSearch = platforms.filter(p => ['modrinth', 'curseforge', 'mcmod', 'mcwiki'].includes(p));
          if (platformsToSearch.length === 0) return `所指定平台无效`;
        } else {
          platformsToSearch = ['modrinth', 'curseforge'];
        }
        // 初始化平台数据
        platformsToSearch.forEach(p => { platformOffsets[p] = skip; platformResults[p] = []; exhaustedPlatforms[p] = false });
        // 执行搜索，可指定平台
        const executeSearch = async (platforms = platformsToSearch) => {
          const activePlatforms = platforms.filter(p => !exhaustedPlatforms[p]);
          if (activePlatforms.length === 0) return { success: true };
          // 准备平台搜索选项
          const platformOptions = {
            modrinth: {
              facets: options.mrf || (options.type && JSON.stringify([[`project_type:${options.type}`]])),
              sort: options.mrs, version: options.version,
              offset: platformOffsets['modrinth'], limit: 100
            },
            curseforge: {
              categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
              gameVersion: options.version,
              modLoaderType: options.cfl ? CF_MAPS.LOADER[options.cfl] : undefined,
              sortField: options.cfs, sortOrder: options.cfo,
              index: platformOffsets['curseforge'], pageSize: 50
            },
            mcmod: { type: options.type },
            mcwiki: { offset: platformOffsets['mcwiki'], what: options.what }
          }
          // 并行搜索
          const searchResults = await Promise.all(activePlatforms.map(async p => {
            const platform = PLATFORMS[p];
            if (!platform?.checkConfig(config)) return { platform: p, results: [] };
            try {
              const response = await platform.search(ctx, keyword, config, platformOptions[p] || {});
              const isCF = p === 'curseforge';
              const results = isCF ? response.results : response;
              const transformedResults = results.map(platform.transform);
              // 如果没有返回结果或达到上限，标记为已耗尽
              if (transformedResults.length === 0 || (isCF && response.pagination && response.pagination.totalCount < platformOptions[p].pageSize)) {
                exhaustedPlatforms[p] = true;
              } else {
                platformOffsets[p] += transformedResults.length;
              }
              return { platform: p, results: transformedResults };
            } catch (error) {
              ctx.logger.error(`${platform.name} 搜索失败:`, error);
              return { platform: p, results: [] };
            }
          }));
          // 整理结果
          searchResults.forEach(({ platform, results }) => {
            if (results.length === 0) return;
            // 过滤结果
            let filtered = results;
            if (options.version && platform === 'mcmod')
              filtered = filtered.filter(i => !i.extra?.mcversion || i.extra.mcversion.includes(options.version));
            if (options.type) {
              if (platform === 'modrinth') {
                const validTypes = ['mod', 'modpack', 'resourcepack', 'shader'];
                if (validTypes.includes(options.type))
                  filtered = filtered.filter(i => i.extra?.type === options.type);
              } else if (platform === 'mcmod') {
                filtered = filtered.filter(i => !i.extra?.type ||
                  i.extra.type.toLowerCase().includes(options.type.toLowerCase()));
              }
            }
            platformResults[platform] = platformResults[platform].concat(filtered);
          });
          // 结果检查
          const isEmpty = platformsToSearch.every(p => exhaustedPlatforms[p]) &&
                         Object.values(platformResults).every(r => r.length === 0);
          if (isEmpty) {
            const names = platformsToSearch.map(p => PLATFORMS[p]?.name || p).join('、');
            return {
              success: false,
              message: `${names} 无匹配资源：${options.type ? `,类型:${options.type}` : ''}${options.version ? `,版本:${options.version}` : ''}`
            };
          }
          return { success: true };
        };
        // 初次搜索
        const initialSearch = await executeSearch();
        if (!initialSearch.success) return initialSearch.message;
        // 处理分页和用户交互
        const handlePage = async () => {
          const startIndex = currentPage * config.searchResults;
          const endIndex = startIndex + config.searchResults;
          // 交错合并所有平台结果
          const allResults = [];
          let maxResults = Math.max(...Object.values(platformResults).map(r => r.length));
          for (let i = 0; i < maxResults; i++) {
            for (const platform in platformResults) {
              if (i < platformResults[platform].length) allResults.push(platformResults[platform][i]);
            }
          }
          // 检查是否需要加载更多
          if (endIndex > allResults.length) {
            const platformsToLoad = Object.keys(platformOffsets).filter(p =>
              !exhaustedPlatforms[p] && (platformResults[p].length < maxResults || allResults.length - endIndex < config.searchResults)
            );
            if (platformsToLoad.length > 0) {
              await executeSearch(platformsToLoad);
              return handlePage();
            }
          }
          const currentResults = allResults.slice(startIndex, endIndex);
          if (currentResults.length === 0) return '无更多结果';
          const hasNextPage = endIndex < allResults.length;
          // 格式化结果
          const formattedResults = ['请回复序号查看详情，输入 n 查看下一页，输入 c 取消'].concat(
            currentResults.map((p, i) => {
              const desc = config.searchDesc > 0 && p.description
                ? `\n  ${p.description.substring(0, config.searchDesc)}${p.description.length > config.searchDesc ? '...' : ''}`
                : '';
              return `${startIndex + i + 1}. [${p.platform}] ${p.name}${desc}`;
            })
          );
          if (hasNextPage) formattedResults.push(`第 ${currentPage + 1}/${Math.ceil(allResults.length / config.searchResults)} 页`);
          await renderOutput(session, formattedResults, null, ctx, config, false);
          // 处理用户输入
          const input = await session.prompt(60 * 1000);
          if (!input) return '已超时，自动取消搜索';
          if (input.toLowerCase() === 'c') return '已取消搜索';
          if (input.toLowerCase() === 'n') {
            if (hasNextPage) {
              currentPage++;
              return handlePage();
            }
            return '无更多结果';
          }
          // 处理序号选择
          const choice = parseInt(input);
          if (isNaN(choice) || choice < 1 || choice > allResults.length) return `请输入 1-${allResults.length} 的数字，或输入 n 查看下一页，输入 c 取消`;
          // 获取详情
          const selected = allResults[choice - 1];
          const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform);
          const detailId = selected.platform === 'MCMOD' ? selected : selected.extra.id;
          const detail = await platform.getDetail(ctx, detailId, config);
          if (!detail) return '获取详情失败';
          return renderOutput(session, detail.content, detail.url, ctx, config);
        };
        return handlePage();
      } catch (error) {
        ctx.logger.error('搜索执行失败:', error);
        return '搜索过程中出错';
      }
    })
}