import { searchModrinthProjects, getModrinthProject } from './modrinth'
import { searchCurseForgeProjects, getCurseForgeProject } from './curseforge'
import { searchMcmodProjects, getMcmodProject } from './mcmod'
import { searchMcwikiPages, getMcwikiPage } from './mcwiki'

/**
 * 支持的平台配置，包含各平台的搜索、详情获取和数据转换方法
 * @type {Object}
 */
export const PLATFORMS = {
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