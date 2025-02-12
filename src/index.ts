// -------- 导入依赖、接口定义与配置 --------
// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {} from 'koishi-plugin-adapter-onebot'  // 添加onebot导入

// 基础定义
export const name = 'best-cave';
export const inject = ['database'];

// 配置Schema
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required(),
  blacklist: Schema.array(Schema.string()).default([]),
  whitelist: Schema.array(Schema.string()).default([]),
  number: Schema.number().default(60),
  enableAudit: Schema.boolean().default(false),
  allowVideo: Schema.boolean().default(true),
  videoMaxSize: Schema.number().default(16),
  imageMaxSize: Schema.number().default(4),
  enablePagination: Schema.boolean().default(false),
  itemsPerPage: Schema.number().default(10),
}).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
});

// 插件主函数：初始化和命令注册
export async function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  // 初始化路径和冷却管理
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');
  const caveFilePath = path.join(caveDir, 'cave.json');
  const resourceDir = path.join(caveDir, 'resources');
  const pendingFilePath = path.join(caveDir, 'pending.json');

  await FileHandler.ensureDirectory(dataDir);
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(resourceDir);
  await FileHandler.ensureJsonFile(caveFilePath);
  await FileHandler.ensureJsonFile(pendingFilePath);

  const lastUsed: Map<string, number> = new Map();

  async function processList(
    caveFilePath: string,
    session: any,
    content: string[],
    options: any,
    config: Config
  ): Promise<string> {
    const caveData = await FileHandler.readJsonData<CaveObject>(caveFilePath, session);
    const caveDir = path.dirname(caveFilePath);
    const stats: Record<string, number[]> = {};
    for (const cave of caveData) {
      if (cave.contributor_number === '10000') continue;
      if (!stats[cave.contributor_number]) stats[cave.contributor_number] = [];
      stats[cave.contributor_number].push(cave.cave_id);
    }
    const statFilePath = path.join(caveDir, 'stat.json');
    fs.writeFileSync(statFilePath, JSON.stringify(stats, null, 2), 'utf8');
    const lines: string[] = Object.entries(stats).map(([cid, ids]) => {
      return session.text('commands.cave.list.totalItems', [cid, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    });
    const totalSubmissions = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);
    if (config.enablePagination) {
      const itemsPerPage = config.itemsPerPage;
      const totalPages = Math.max(1, Math.ceil(lines.length / itemsPerPage));
      let query = (content[0] || String(options.l) || '').trim();
      let pageNum = parseInt(query, 10);
      if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
      if (pageNum > totalPages) pageNum = totalPages;
      const start = (pageNum - 1) * itemsPerPage;
      const paginatedLines = lines.slice(start, start + itemsPerPage);
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             paginatedLines.join('\n') + '\n' +
             session.text('commands.cave.list.pageInfo', [pageNum, totalPages]);
    } else {
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             lines.join('\n');
    }
  }

  async function processAudit(
    ctx: Context,
    pendingFilePath: string,
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath, session);
    const isApprove = Boolean(options.p);
    if ((options.p === true && content[0] === 'all') ||
        (options.d === true && content[0] === 'all')) {
      return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session);
    }
    const id = parseInt(content[0] ||
      (typeof options.p === 'string' ? options.p : '') ||
      (typeof options.d === 'string' ? options.d : ''));
    if (isNaN(id)) {
      return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    }
    return sendMessage(session, await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session, id), [], true);
  }

  async function processView(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
    if (isNaN(caveId)) return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath, session);
    const cave = data.find(item => item.cave_id === caveId);
    if (!cave) return sendMessage(session, 'commands.cave.error.notFound', [], true);
    const caveContent = await buildMessage(cave, resourceDir, session);
    return caveContent;
  }

  async function processRandom(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    config: Config,
    lastUsed: Map<string, number>
  ): Promise<string | void> {
    try {
      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath, session);
      if (data.length === 0) {
        return sendMessage(session, 'commands.cave.error.noCave', [], true);
      }
      const guildId = session.guildId;
      const now = Date.now();
      const lastCall = lastUsed.get(guildId) || 0;
      const isManager = config.manager.includes(session.userId);
      if (!isManager && now - lastCall < config.number * 1000) {
        const waitTime = Math.ceil((config.number * 1000 - (now - lastCall)) / 1000);
        return sendMessage(session, 'commands.cave.message.cooldown', [waitTime], true);
      }
      if (!isManager) lastUsed.set(guildId, now);
      const cave = (() => {
        const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
        if (!validCaves.length) return undefined;
        const randomIndex = Math.floor(Math.random() * validCaves.length);
        return validCaves[randomIndex];
      })();
      return cave ? buildMessage(cave, resourceDir, session)
                  : sendMessage(session, 'commands.cave.error.getCave', [], true);
    } catch (error) {
      return sendMessage(session, 'commands.cave.error.commandProcess', [error.message], true);
    }
  }

  async function processDelete(
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    config: Config,
    options: any,
    content: string[]
  ): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
    if (isNaN(caveId)) return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath, session);
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath, session);
    const index = data.findIndex(item => item.cave_id === caveId);
    const pendingIndex = pendingData.findIndex(item => item.cave_id === caveId);
    if (index === -1 && pendingIndex === -1) return sendMessage(session, 'commands.cave.error.notFound', [], true);
    let targetCave: CaveObject;
    let isPending = false;
    if (index !== -1) {
      targetCave = data[index];
    } else {
      targetCave = pendingData[pendingIndex];
      isPending = true;
    }
    if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
      return sendMessage(session, 'commands.cave.remove.noPermission', [], true);
    }

    // 先生成回声洞预览消息（图片等媒体将被嵌入）
    const caveContent = await buildMessage(targetCave, resourceDir, session);

    if (targetCave.elements) {
      for (const element of targetCave.elements) {
        if ((element.type === 'img' || element.type === 'video') && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    }
    // 返回预览消息后再更新数据文件
    if (isPending) {
      pendingData.splice(pendingIndex, 1);
      await FileHandler.writeJsonData(pendingFilePath, pendingData, session);
      const deleteStatus = isPending
        ? session.text('commands.cave.remove.deletePending')
        : '';
      const deleteMessage = session.text('commands.cave.remove.deleted');
      return `${deleteMessage}${deleteStatus}\n${caveContent}`;
    } else {
      data.splice(index, 1);
      await FileHandler.writeJsonData(caveFilePath, data, session);
      const deleteStatus = isPending
        ? session.text('commands.cave.remove.deletePending')
        : '';
      const deleteMessage = session.text('commands.cave.remove.deleted');
      return `${deleteMessage}${deleteStatus}${caveContent}`;
    }
  }

  async function processAdd(
    ctx: Context,
    config: Config,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    content: string[]
  ): Promise<string> {
    try {
      // 1. 收集所有输入内容
      let inputParts: string[] = [];

      // 读取命令后的内容（如果有）
      if (content.length > 0) {
        inputParts = content;
      }

      // 如果没有任何内容，进入提示流程
      if (!inputParts.length) {
        await sendMessage(session, 'commands.cave.add.noContent', [], true);
        const reply = await session.prompt({ timeout: 60000 });
        if (!reply || reply.trim() === "") {
          return sendMessage(session, 'commands.cave.add.operationTimeout', [], true);
        }
        inputParts = [reply];
      }

      // 检查是否包含本地文件路径
      const combinedInput = inputParts.join('\n');
      if (combinedInput.includes('/app/.config/QQ/')) {
        return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
      }

      // 提取媒体内容
      let { imageUrls, imageElements, videoUrls, videoElements, textParts } = await extractMediaContent(combinedInput);

      // 检查配置：是否允许添加视频
      if (videoUrls.length > 0 && !config.allowVideo) {
        return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
      }

      // 生成新的回声洞ID及处理媒体文件
      const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath, session);
      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath, session);

      // 修复获取maxid问题：检测中间是否有空缺，使用最小可用ID
      const usedIds = new Set<number>([...data.map(item => item.cave_id), ...pendingData.map(item => item.cave_id)]);
      let caveId = 1;
      while (usedIds.has(caveId)) {
        caveId++;
      }

      let savedImages: string[] = [];
      if (imageUrls.length > 0) {
        try {
          const imageFileNames = imageElements.map(el => el.fileName);
          const imageFileSizes = imageElements.map(el => el.fileSize);
          savedImages = await saveMedia(
            imageUrls,
            imageFileNames,
            imageFileSizes,
            resourceDir,
            caveId,
            config,
            ctx,
            'img',
            session
          );
        } catch (error) {
          return error.message;  // 直接使用转换后的错误消息
        }
      }

      let savedVideos: string[] = [];
      if (videoUrls.length > 0) {
        try {
          const videoFileNames = videoElements.map(el => el.fileName);
          const videoFileSizes = videoElements.map(el => el.fileSize);
          savedVideos = await saveMedia(
            videoUrls,
            videoFileNames,
            videoFileSizes,
            resourceDir,
            caveId,
            config,
            ctx,
            'video',
            session
          );
        } catch (error) {
          return error.message;  // 直接使用转换后的错误消息
        }
      }

      // 合并所有元素时保持原始顺序
      const elements: Element[] = [
        ...textParts,
        ...imageElements.map((el, idx) => ({
          ...el,
          file: savedImages[idx],
        })),
        ...videoElements.map((el, idx) => ({
          ...el,
          file: savedVideos[idx],
        }))
      ].sort((a, b) => a.index - b.index);

      const newCave: CaveObject = {
        cave_id: caveId,
        elements: cleanElementsForSave(elements, true), // 保存时保留索引信息
        contributor_number: session.userId,
        contributor_name: session.username
      };

      // 判断是否绕过审核：白名单包括用户、群组和频道
      const bypassAudit = config.whitelist.includes(session.userId) ||
                      (session.guildId && config.whitelist.includes(session.guildId)) ||
                      (session.channelId && config.whitelist.includes(session.channelId));
      if (config.enableAudit && !bypassAudit) {
        pendingData.push({ ...newCave, elements: cleanElementsForSave(elements, true) });
        await FileHandler.writeJsonData(pendingFilePath, pendingData, session);
        await sendAuditMessage(ctx, config, newCave, await buildMessage(newCave, resourceDir, session), session);
        return sendMessage(session, 'commands.cave.add.submitPending', [caveId], false);
      } else {
        const caveWithoutIndex = { ...newCave, elements: cleanElementsForSave(elements, false) };
        data.push(caveWithoutIndex);
        await FileHandler.writeJsonData(caveFilePath, data, session);
        return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);
      }
    } catch (error) {
      return sendMessage(session, 'commands.cave.error.commandProcess', [error.message], true);
    }
  }

  // 注册命令并配置权限检查
  ctx.command('cave [message]')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    // 仅对 -l、-p 和 -d 指令进行权限检查
    .before(async ({ session, options }) => {
      // 黑名单检查
      if (config.blacklist.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.blacklisted', [], true);
      }
      // 如果输入内容包含 "-help"，不进行权限检查
      if (session.content && session.content.includes('-help')) return;
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.managerOnly', [], true);
      }
    })
    .action(async ({ session, options }, ...content) => {
      try {
        // 使用上下文中已定义的文件路径变量
        const dataDir = path.join(ctx.baseDir, 'data');
        const caveDir = path.join(dataDir, 'cave');
        const caveFilePath = path.join(caveDir, 'cave.json');
        const resourceDir = path.join(caveDir, 'resources');
        const pendingFilePath = path.join(caveDir, 'pending.json');

        // 直接调用相应的处理函数
        if (options.l !== undefined) {
          return await processList(caveFilePath, session, content, options, config);
        }
        if (options.p || options.d) {
          return await processAudit(ctx, pendingFilePath, caveFilePath, resourceDir, session, options, content);
        }
        if (options.g) {
          return await processView(caveFilePath, resourceDir, session, options, content);
        }
        if (options.r) {
          return await processDelete(caveFilePath, resourceDir, pendingFilePath, session, config, options, content);
        }
        if (options.a) {
          return await processAdd(ctx, config, caveFilePath, resourceDir, pendingFilePath, session, content);
        }
        return await processRandom(caveFilePath, resourceDir, session, config, lastUsed);
      } catch (error) {
        logger.error(error);
        return sendMessage(session, 'commands.cave.error.commandProcess', [error.message], true);
      }
    });
}

// 日志记录器
const logger = new Logger('cave');

// 接口定义
export interface User {
  userId: string;
  username: string;
  nickname?: string;
}

export interface getStrangerInfo {
  user_id: string;
  nickname: string;
}

export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;
  allowVideo: boolean;
  videoMaxSize: number;
  imageMaxSize: number;  // 新增属性
  blacklist: string[];  // 新增属性
  whitelist: string[]; // 新增白名单属性
  enablePagination: boolean;
  itemsPerPage: number;
}

// 定义数据类型接口
interface BaseElement {
  type: 'text' | 'img' | 'video';
  index: number;
}

interface TextElement extends BaseElement {
  type: 'text';
  content: string;
}

interface MediaElement extends BaseElement {
  type: 'img' | 'video';
  file?: string;
  fileName?: string;
  fileSize?: string;
  filePath?: string;
}

type Element = TextElement | MediaElement;

// 定义回声洞数据结构
interface CaveObject {
  cave_id: number;             // 回声洞唯一ID
  elements: Element[];         // 内容元素数组
  contributor_number: string;  // 投稿者ID
  contributor_name: string;    // 投稿者昵称
}

interface PendingCave extends CaveObject {}

// -------- 新增：文件处理类 --------
// 修改 FileHandler 类以接收 session 参数
class FileHandler {
  private static writeQueue = new Map<string, Promise<void>>();

  static async readJsonData<T>(filePath: string, session: any, validator?: (item: any) => boolean): Promise<T[]> {
    try {
      const data = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(data || '[]');
      return Array.isArray(parsed) ? (validator ? parsed.filter(validator) : parsed) : [];
    } catch (error) {
      logger.error(session.text('commands.cave.error.fileRead', [error.message]));
      return [];
    }
  }

  static async writeJsonData<T>(filePath: string, data: T[], session: any): Promise<void> {
    const queueKey = filePath;

    const writeOperation = async () => {
      try {
        const jsonString = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(filePath, jsonString, 'utf8');
      } catch (error) {
        logger.error(session.text('commands.cave.error.fileWrite', [error.message]));
        throw new Error(session.text('commands.cave.error.saveFailed'));
      }
    };

    // 队列写入操作
    if (!this.writeQueue.has(queueKey)) {
      this.writeQueue.set(queueKey, Promise.resolve());
    }

    const currentPromise = this.writeQueue.get(queueKey)!
      .then(writeOperation)
      .finally(() => {
        if (this.writeQueue.get(queueKey) === currentPromise) {
          this.writeQueue.delete(queueKey);
        }
      });

    this.writeQueue.set(queueKey, currentPromise);
    return currentPromise;
  }

  static async ensureDirectory(dir: string): Promise<void> {
    !fs.existsSync(dir) && await fs.promises.mkdir(dir, { recursive: true });
  }

  static async ensureJsonFile(filePath: string, defaultContent = '[]'): Promise<void> {
    !fs.existsSync(filePath) && await fs.promises.writeFile(filePath, defaultContent, 'utf8');
  }

  static async batchWriteFiles(operations: Array<{
    filePath: string,
    data: any,
    session: any
  }>): Promise<void> {
    return BatchProcessor.addToBatch('fileWrite', operations, async (items) => {
      const results = await Promise.all(
        items.map(({ filePath, data, session }) =>
          this.writeJsonData(filePath, data, session)
        )
      );
      return results;
    });
  }
}

// -------- 图片及视频处理函数 --------
async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  fileSizes: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  config: Config,
  ctx: Context,
  mediaType: 'img' | 'video',
  session: any
): Promise<string[]> {
  const defaults = mediaType === 'img'
    ? { ext: 'png', accept: 'image/*', maxSize: config.imageMaxSize }
    : { ext: 'mp4', accept: 'video/*', maxSize: config.videoMaxSize };
  const extPattern = /\.[a-zA-Z0-9]+$/;

  const downloadTasks = urls.map(async (url, i) => {
    try {
      const processedUrl = (() => {
        try {
          const decodedUrl = decodeURIComponent(url);
          return decodedUrl.includes('multimedia.nt.qq.com.cn') ? decodedUrl.replace(/&amp;/g, '&') : url;
        } catch {
          return url;
        }
      })();

      let ext = defaults.ext;
      const fileName = fileNames[i];
      const fileSize = fileSizes[i];

      if (fileSize) {
        const sizeInBytes = parseInt(fileSize);
        if (sizeInBytes > defaults.maxSize * 1024 * 1024) {
          logger.warn(`${mediaType} size exceeded: ${sizeInBytes} bytes`);
          throw new Error('file_size_exceeded');
        }
      }

      if (fileName && extPattern.test(fileName)) {
        ext = fileName.match(extPattern)![0].slice(1);
      }

      // 清理文件名，直接删除特殊字符
      const sanitizeFileName = (name: string) => {
        return name
          .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '') // 只保留中文、英文、数字
          .toLowerCase();                              // 转换为小写
      };

      const finalFileName = fileName
        ? `${caveId}_${sanitizeFileName(path.basename(fileName, path.extname(fileName)))}.${ext}`
        : `${caveId}_${i + 1}.${ext}`;

      const targetPath = path.join(resourceDir, finalFileName);

      const response = await ctx.http(processedUrl, {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': defaults.accept,
          'Referer': 'https://qq.com'
        }
      });

      if (!response.data) {
        throw new Error('empty_response');
      }

      const fileBuffer = Buffer.from(response.data);
      await fs.promises.writeFile(targetPath, fileBuffer);
      return finalFileName;
    } catch (error) {
      // 记录详细错误信息
      logger.error(`Failed to process ${mediaType} (${url}):`, error);
      if (error.message === 'file_size_exceeded') {
        throw new Error(session.text('commands.cave.message.mediaSizeExceeded', [mediaType]));
      }
      throw new Error(session.text(`commands.cave.error.upload${mediaType === 'img' ? 'Image' : 'Video'}Failed`));
    }
  });

  // 使用 allSettled 而不是 all，以便更好地处理部分失败的情况
  const results = await Promise.allSettled(downloadTasks);
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map(result => result.value);

  if (successfulResults.length === 0 && results.length > 0) {
    // 如果所有任务都失败，抛出第一个错误
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstError) {
      throw firstError.reason;
    }
  }

  return successfulResults;
}

// -------- 审核相关函数 --------
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string, session: any) {
  const auditMessage = `${session.text('commands.cave.audit.title')}\n${content}
${session.text('commands.cave.audit.from')}${cave.contributor_number}`;

  for (const managerId of config.manager) {
    try {
      await ctx.bots[0]?.sendPrivateMessage(managerId, auditMessage);
    } catch (error) {
      logger.error(session.text('commands.cave.audit.sendFailed', [managerId]));
    }
  }
}

// 审核相关函数
async function handleSingleCaveAudit(
  ctx: Context,
  cave: PendingCave,
  isApprove: boolean,
  resourceDir: string,
  data?: CaveObject[],
  session?: any
): Promise<boolean | string> {
  // 处理单个审核项，根据审批状态更新数据或删除文件
  try {
    if (isApprove && data) {
      // 保存经过清理的回声洞数据
      const caveWithoutIndex = {
        ...cave,
        elements: cleanElementsForSave(cave.elements, false)
      };
      data.push(caveWithoutIndex);
    } else if (!isApprove && cave.elements) {
      // 删除与回声洞关联的媒体文件
      for (const element of cave.elements) {
        if (element.type === 'img' && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    }
    return true;
  } catch (error) {
    return sendMessage(session, 'commands.cave.error.auditProcess', [error.message], true);
  }
}

async function handleAudit(
  ctx: Context,
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string,
  session: any,
  targetId?: number
): Promise<string> {
  // 处理审核操作，支持单条及批量处理
  if (pendingData.length === 0) return sendMessage(session, 'commands.cave.audit.noPending', [], true);

  // 处理单条审核
  if (typeof targetId === 'number') {
    const pendingIndex = pendingData.findIndex(item => item.cave_id === targetId);
    if (pendingIndex === -1) return sendMessage(session, 'commands.cave.audit.pendingNotFound', [], true);

    const cave = pendingData[pendingIndex];
    const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath, session) : null;

    const auditResult = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data, session);
    if (typeof auditResult === 'string') return auditResult;
    if (isApprove && data) await FileHandler.writeJsonData(caveFilePath, data, session);

    pendingData.splice(pendingIndex, 1);
    await FileHandler.writeJsonData(pendingFilePath, pendingData, session);

    const remainingCount = pendingData.length;
    if (remainingCount > 0) {
      const remainingIds = pendingData.map(c => c.cave_id).join(', ');
      const action = isApprove ? 'auditPassed' : 'auditRejected';
      return sendMessage(session, 'commands.cave.audit.pendingResult', [
        session.text(`commands.cave.audit.${action}`),
        remainingCount,
        remainingIds
      ], false);
    }
    return sendMessage(
      session,
      isApprove ? 'commands.cave.audit.auditPassed' : 'commands.cave.audit.auditRejected',
      [],
      false // 审核结果改为永久消息
    );
  }

  // 处理批量审核
  const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath, session) : null;
  let processedCount = 0;

  for (const cave of pendingData) {
    await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data, session) && processedCount++;
  }

  if (isApprove && data) await FileHandler.writeJsonData(caveFilePath, data, session);
  await FileHandler.writeJsonData(pendingFilePath, [], session);

  return sendMessage(session, 'commands.cave.audit.batchAuditResult', [
    isApprove ? '通过' : '拒绝',
    processedCount,
    pendingData.length
  ], false); // 批量审核结果改为永久消息
}

// -------- 消息构建函数 --------
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  if (!elements?.length) return [];

  // 深拷贝以避免修改原数组
  const cleanedElements = elements.map(element => {
    if (element.type === 'text') {
      return { type: 'text' as const, index: element.index, content: (element as TextElement).content } as TextElement;
    } else if (element.type === 'img' || element.type === 'video') {
      const mediaElement = element as MediaElement;
      if (mediaElement.file) {
        return { type: element.type as 'img' | 'video', index: element.index, file: mediaElement.file } as MediaElement;
      } else {
        return { type: element.type as 'img' | 'video', index: element.index } as MediaElement;
      }
    }
    return element;
  });
  return cleanedElements.sort((a, b) => a.index - b.index);
}

async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  try {
    const lines: string[] = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];
    const videoElements: MediaElement[] = [];

    // 按索引排序并处理元素
    const sortedElements = [...cave.elements].sort((a, b) => a.index - b.index);

    for (const element of sortedElements) {
      switch (element.type) {
        case 'text':
          lines.push((element as TextElement).content);
          break;

        case 'img':
          const imgElement = element as MediaElement;
          if (imgElement.file) {
            const imgPath = path.resolve(resourceDir, imgElement.file);
            if (fs.existsSync(imgPath)) {
              try {
                // 使用 booru-local 风格的 URL 转换
                const url = pathToFileURL(imgPath).href;
                lines.push(String(h('image', {
                  src: url,
                  // 添加额外的图片处理参数
                  cache: true,
                  timeout: 30000,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'image/*'
                  }
                })));
              } catch (error) {
                logger.error('Image path error:', error);
                lines.push(session.text('commands.cave.error.mediaLoadFailed', ['图片']));
              }
            } else {
              logger.error(`Image file not found: ${imgPath}`);
              lines.push(session.text('commands.cave.error.mediaLoadFailed', ['图片']));
            }
          }
          break;

        case 'video':
          const videoElement = element as MediaElement;
          if (videoElement.file) {
            // 修改：使用完整的绝对路径
            const videoPath = path.resolve(resourceDir, videoElement.file);
            if (fs.existsSync(videoPath)) {
              videoElements.push({
                ...videoElement,
                filePath: videoPath
              });
            } else {
              logger.error(`Video file not found: ${videoPath}`);
              lines.push(session.text('commands.cave.error.mediaLoadFailed', ['视频']));
            }
          }
          break;
      }
    }

    // 添加投稿者信息
    lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));

    // 如果存在视频元素，添加提示并发送视频
    if (videoElements.length > 0) {
      lines.push(session.text('commands.cave.message.videoSending'));

      // 异步发送视频
      for (const videoElement of videoElements) {
        if (videoElement.filePath) {
          const fileUrl = `file://${videoElement.filePath}`;
          await session.send(h('video', {
            src: fileUrl
          })).catch(error => {
            logger.error('Failed to send video:', error);
          });
        }
      }
    }

    return lines.join('\n');

  } catch (error) {
    logger.error('Error building message:', error);
    return session.text('commands.cave.error.messageBuildFailed', [error.message]);
  }
}

// 添加辅助函数到文件开头的函数定义区域
const messageQueue = new Map<string, Promise<void>>();
async function sendMessage(
  session: any,
  key: string,
  params: any[] = [],
  isTemp = true,
  timeout = 10000
): Promise<string> {
  const channelId = session.channelId;
  if (!messageQueue.has(channelId)) {
    messageQueue.set(channelId, Promise.resolve());
  }

  const sendOperation = async () => {
    const msg = await session.send(session.text(key, params));
    if (isTemp) {
      setTimeout(async () => {
        try {
          await session.bot.deleteMessage(channelId, msg);
        } catch (error) {
          logger.error('Failed to delete message:', error);
        }
      }, timeout);
    }
  };

  const currentPromise = messageQueue.get(channelId)!
    .then(sendOperation)
    .finally(() => {
      if (messageQueue.get(channelId) === currentPromise) {
        messageQueue.delete(channelId);
      }
    });

  messageQueue.set(channelId, currentPromise);
  return '';
}

// 媒体处理及回复
async function extractMediaContent(originalContent: string): Promise<{
  imageUrls: string[],
  imageElements: { type: 'img'; index: number; fileName?: string; fileSize?: string }[],
  videoUrls: string[],
  videoElements: { type: 'video'; index: number; fileName?: string; fileSize?: string }[],
  textParts: Element[]
}> {
  // 拆分文本与媒体标签，并分别提取相关信息
  const parsedTexts = originalContent
    .split(/<img[^>]+>|<video[^>]+>/g)
    .map(t => t.trim())
    .filter(t => t);
  const textParts: Element[] = [];
  parsedTexts.forEach((text, idx) => {
    textParts.push({ type: 'text', content: text, index: idx * 3 });
  });

  // 初始化数组用于存储媒体链接与元素信息
  const imageUrls: string[] = [];
  const imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }> = [];
  const videoUrls: string[] = [];
  const videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }> = [];

  // 提取 <img> 标签中的 src 和 file 属性
  const imgMatches = originalContent.match(/<img[^>]+src="([^"]+)"[^>]*>/g) || [];
  imgMatches.forEach((img, idx) => {
    const srcMatch = img.match(/src="([^"]+)"/);
    const fileName = img.match(/file="([^"]+)"/)?.[1];
    const fileSize = img.match(/fileSize="([^"]+)"/)?.[1];
    if (srcMatch?.[1]) {
      imageUrls.push(srcMatch[1]);
      imageElements.push({ type: 'img', index: idx * 3 + 1, fileName, fileSize });
    }
  });

  // 提取 <video> 标签中的 src 与 file 属性
  const videoMatches = originalContent.match(/<video[^>]+src="([^"]+)"/g) || [];
  videoMatches.forEach((video, idx) => {
    const srcMatch = video.match(/src="([^"]+)"/);
    const fileName = video.match(/file="([^"]+)"/)?.[1];
    const fileSize = video.match(/fileSize="([^"]+)"/)?.[1];
    if (srcMatch?.[1]) {
      videoUrls.push(srcMatch[1]);
      videoElements.push({ type: 'video', index: idx * 3 + 2, fileName, fileSize });
    }
  });

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

// 添加批处理管理器
class BatchProcessor {
  private static batchQueue = new Map<string, Array<{
    data: any,
    resolve: (value: any) => void,
    reject: (reason: any) => void
  }>>();
  private static batchTimeout = 100; // 100ms 批处理窗口

  static async addToBatch<T>(
    key: string,
    data: any,
    processor: (items: any[]) => Promise<T[]>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.batchQueue.has(key)) {
        this.batchQueue.set(key, []);
        setTimeout(() => this.processBatch(key, processor), this.batchTimeout);
      }
      this.batchQueue.get(key)!.push({ data, resolve, reject });
    });
  }

  private static async processBatch(
    key: string,
    processor: (items: any[]) => Promise<any[]>
  ) {
    const batch = this.batchQueue.get(key) || [];
    this.batchQueue.delete(key);

    try {
      // 处理批次
      const items = batch.map(item => item.data);
      const results = await processor(items);
      // 分发结果
      batch.forEach((item, index) => item.resolve(results[index]));
    } catch (error) {
      batch.forEach(item => item.reject(error));
    }
  }
}
