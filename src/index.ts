// -------- 导入依赖、接口定义与配置 --------
// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import {} from 'koishi-plugin-adapter-onebot'

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

  const idManager = new IdManager(ctx.baseDir);
  await idManager.initialize(caveFilePath, pendingFilePath, null);

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
    return buildMessage(cave, resourceDir, session);
  }

  async function processRandom(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    config: Config,
    lastUsed: Map<string, number>
  ): Promise<string | void> {
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
      data.splice(index, 1);
      idManager.markDeleted(targetCave.cave_id); // 记录被删除的ID
      await FileHandler.writeJsonData(caveFilePath, data, session);
    } else {
      targetCave = pendingData[pendingIndex];
      pendingData.splice(pendingIndex, 1);
      idManager.markDeleted(targetCave.cave_id); // 记录被删除的ID
      await FileHandler.writeJsonData(pendingFilePath, pendingData, session);
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
    // 收集输入内容
    let inputContent = '';

    // 读取命令后的内容
    if (content.length > 0) {
      inputContent = content.join('\n');
    } else {
      // 如果没有内容，进入提示流程
      await sendMessage(session, 'commands.cave.add.noContent', [], true);
      const reply = await session.prompt({ timeout: 60000 });
      if (!reply) {
        return sendMessage(session, 'commands.cave.add.operationTimeout', [], true);
      }
      inputContent = reply;
    }

    // 检查是否包含本地文件路径
    if (inputContent.includes('/app/.config/QQ/')) {
      return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
    }

    // 提取媒体内容
    let { imageUrls, imageElements, videoUrls, videoElements, textParts } = await extractMediaContent(inputContent);

    if (videoUrls.length > 0 && !config.allowVideo) {
      return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
    }

    // 获取新ID并处理媒体文件
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath, session);
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath, session);
    const caveId = idManager.getNextId();

    // 处理媒体文件
    let savedImages: string[] = [];
    let savedVideos: string[] = [];
    try {
      if (imageUrls.length > 0) {
        savedImages = await saveMedia(
          imageUrls,
          imageElements.map(el => el.fileName),
          imageElements.map(el => el.fileSize),
          resourceDir,
          caveId,
          config,
          ctx,
          'img',
          session
        );
      }

      if (videoUrls.length > 0) {
        savedVideos = await saveMedia(
          videoUrls,
          videoElements.map(el => el.fileName),
          videoElements.map(el => el.fileSize),
          resourceDir,
          caveId,
          config,
          ctx,
          'video',
          session
        );
      }
    } catch (error) {
      return error.message;
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
      elements: cleanElementsForSave(elements, true),
      contributor_number: session.userId,
      contributor_name: session.username
    };

    // 处理审核逻辑
    const bypassAudit = config.whitelist.includes(session.userId) ||
                    (session.guildId && config.whitelist.includes(session.guildId)) ||
                    (session.channelId && config.whitelist.includes(session.channelId));

    if (config.enableAudit && !bypassAudit) {
      pendingData.push(newCave);
      await FileHandler.writeJsonData(pendingFilePath, pendingData, session);
      // 使用公共的 buildMessage 函数
      await sendAuditMessage(ctx, config, newCave, await buildMessage(newCave, resourceDir, session), session);
      return sendMessage(session, 'commands.cave.add.submitPending', [caveId], false);
    }

    data.push({ ...newCave, elements: cleanElementsForSave(elements, false) });
    await FileHandler.writeJsonData(caveFilePath, data, session);
    return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);
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
export interface User { userId: string; username: string; nickname?: string; }
export interface getStrangerInfo { user_id: string; nickname: string; }
export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;
  allowVideo: boolean;
  videoMaxSize: number;
  imageMaxSize: number;
  blacklist: string[];
  whitelist: string[];
  enablePagination: boolean;
  itemsPerPage: number;
}

// 定义数据类型接口
interface BaseElement { type: 'text' | 'img' | 'video'; index: number }
interface TextElement extends BaseElement { type: 'text'; content: string }
interface MediaElement extends BaseElement { type: 'img' | 'video'; file?: string; fileName?: string; fileSize?: string; filePath?: string }
type Element = TextElement | MediaElement;

interface CaveObject { cave_id: number; elements: Element[]; contributor_number: string; contributor_name: string }
interface PendingCave extends CaveObject {}

// -------- 新增：文件处理类 --------
class FileHandler {
  private static locks = new Map<string, Promise<void>>();
  private static writeQueue = new Map<string, Promise<void>>();
  private static retryCount = 3;
  private static retryDelay = 1000;

  // 文件锁实现
  private static async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let complete: () => void;
    const lockPromise = new Promise<void>(resolve => complete = resolve);
    this.locks.set(key, lockPromise);

    try {
      return await operation();
    } finally {
      this.locks.delete(key);
      complete!();
    }
  }

  // 带重试的文件操作
  private static async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let i = 0; i < this.retryCount; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (i < this.retryCount - 1) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    }

    throw lastError!;
  }

  // 优化后的读取方法，只在解析 JSON 时保留 try-catch
  static async readJsonData<T>(filePath: string, session: any, validator?: (item: any) => boolean): Promise<T[]> {
    const data = await fs.promises.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(data || '[]');
      if (!Array.isArray(parsed)) {
        await this.backupFile(filePath);
        return [];
      }
      return validator ? parsed.filter(validator) : parsed;
    } catch (error) {
      await this.backupFile(filePath);
      return [];
    }
  }

  // 优化后的写入方法
  static async writeJsonData<T>(filePath: string, data: T[], session: any): Promise<void> {
    const queueKey = filePath;

    const writeOperation = async () => {
      return this.withLock(`write:${filePath}`, async () => {
        const tempPath = `${filePath}.tmp`;
        const backupPath = `${filePath}.bak`;

        const jsonString = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(tempPath, jsonString, 'utf8');

        const written = await fs.promises.readFile(tempPath, 'utf8');
        JSON.parse(written);

        if (fs.existsSync(filePath)) {
          await fs.promises.rename(filePath, backupPath);
        }

        await fs.promises.rename(tempPath, filePath);

        if (fs.existsSync(backupPath)) {
          await fs.promises.unlink(backupPath);
        }
      });
    };

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

  // 新增：文件备份方法
  private static async backupFile(filePath: string): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.${timestamp}.bak`;
    if (fs.existsSync(filePath)) {
      await fs.promises.copyFile(filePath, backupPath);
    }
  }

  // 文件是否存在检查
  static async ensureDirectory(dir: string): Promise<void> {
    !fs.existsSync(dir) && await fs.promises.mkdir(dir, { recursive: true });
  }

  // JSON文件初始化
  static async ensureJsonFile(filePath: string, defaultContent = '[]'): Promise<void> {
    !fs.existsSync(filePath) && await fs.promises.writeFile(filePath, defaultContent, 'utf8');
  }

  // 批量写入优化
  static async batchWriteFiles(operations: Array<{
    filePath: string,
    data: any,
    session: any
  }>): Promise<void> {
    const grouped = new Map<string, any[]>();

    // 按文件路径分组
    operations.forEach(op => {
      if (!grouped.has(op.filePath)) {
        grouped.set(op.filePath, []);
      }
      grouped.get(op.filePath)!.push(op.data);
    });

    // 并行处理每个文件的写入
    await Promise.all(
      Array.from(grouped.entries()).map(async ([filePath, dataArray]) => {
        // 合并同一文件的多个写入操作
        const mergedData = dataArray.flat();
        await this.writeJsonData(filePath, mergedData, operations[0].session);
      })
    );
  }
}

// -------- 修改 IdManager 类 --------
class IdManager {
  private deletedIds: Set<number> = new Set();
  private maxId: number = 0;
  private initialized: boolean = false;
  private readonly deletedIdsPath: string;

  constructor(baseDir: string) {
    // 在cave目录下存储已删除ID的文件
    this.deletedIdsPath = path.join(baseDir, 'data', 'cave', 'deleted_ids.json');
  }

  // 读取持久化的已删除ID
  private async loadDeletedIds(): Promise<void> {
    if (!fs.existsSync(this.deletedIdsPath)) {
      return;
    }
    const data = await fs.promises.readFile(this.deletedIdsPath, 'utf8');
    const { deletedIds, maxId } = JSON.parse(data);
    this.deletedIds = new Set(deletedIds);
    this.maxId = maxId;
  }

  // 保存已删除ID到文件
  private async saveDeletedIds(): Promise<void> {
    try {
      const data = {
        deletedIds: Array.from(this.deletedIds),
        maxId: this.maxId,
        timestamp: new Date().toISOString()
      };
      await fs.promises.writeFile(
        this.deletedIdsPath,
        JSON.stringify(data, null, 2),
        'utf8'
      );
    } catch (error) {
      logger.error('Failed to save deleted IDs:', error);
    }
  }

  // 初始化ID管理器
  async initialize(caveFilePath: string, pendingFilePath: string, session: any) {
    if (this.initialized) return;

    // 首先尝试加载持久化的删除ID列表
    await this.loadDeletedIds();

    // 如果没有持久化数据,则执行全量扫描
    if (this.deletedIds.size === 0) {
      const [caveData, pendingData] = await Promise.all([
        FileHandler.readJsonData<CaveObject>(caveFilePath, session),
        FileHandler.readJsonData<PendingCave>(pendingFilePath, session)
      ]);

      // 找出最大ID
      this.maxId = Math.max(
        0,
        ...caveData.map(item => item.cave_id),
        ...pendingData.map(item => item.cave_id)
      );

      // 找出空缺的ID
      const usedIds = new Set([
        ...caveData.map(item => item.cave_id),
        ...pendingData.map(item => item.cave_id)
      ]);

      // 收集1到maxId之间的空缺ID
      for (let i = 1; i <= this.maxId; i++) {
        if (!usedIds.has(i)) {
          this.deletedIds.add(i);
        }
      }

      // 保存初始扫描结果
      await this.saveDeletedIds();
    }

    this.initialized = true;
  }

  // 获取下一个可用ID
  getNextId(): number {
    if (this.deletedIds.size > 0) {
      const nextId = Math.min(...this.deletedIds);
      this.deletedIds.delete(nextId);
      // 当分配ID时保存状态
      this.saveDeletedIds().catch(err => logger.error('Failed to save state after ID allocation:', err));
      return nextId;
    }
    this.maxId++;
    // 当分配新ID时保存状态
    this.saveDeletedIds().catch(err => logger.error('Failed to save state after max ID update:', err));
    return this.maxId;
  }

  // 记录被删除的ID
  async markDeleted(id: number) {
    if (id > 0 && id <= this.maxId) {
      this.deletedIds.add(id);
      // 当标记ID删除时保存状态
      await this.saveDeletedIds();
    }
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
  const sendOperation = async () => {
    const msg = await session.send(session.text(key, params));
    if (isTemp) {
      setTimeout(() => session.bot.deleteMessage(channelId, msg), timeout);
    }
  };

  const currentPromise = (messageQueue.get(channelId) || Promise.resolve())
    .then(sendOperation)
    .finally(() => {
      if (messageQueue.get(channelId) === currentPromise) {
        messageQueue.delete(channelId);
      }
    });

  messageQueue.set(channelId, currentPromise);
  return '';
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
): Promise<boolean> {
  if (isApprove && data) {
    const caveWithoutIndex = {
      ...cave,
      elements: cleanElementsForSave(cave.elements, false)
    };
    data.push(caveWithoutIndex);
  } else if (!isApprove && cave.elements) {
    for (const element of cave.elements) {
      if (element.type === 'img' && element.file) {
        const fullPath = path.join(resourceDir, element.file);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
    }
  }
  return true;
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

    const auditResult = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data);
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
    await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data) && processedCount++;
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

async function processMediaFile(filePath: string, type: 'image' | 'video'): Promise<string | null> {
  const data = await fs.promises.readFile(filePath).catch(() => null);
  if (!data) return null;
  return `data:${type}/${type === 'image' ? 'png' : 'mp4'};base64,${data.toString('base64')}`;
}

async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  const lines = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];

  for (const element of cave.elements) {
    if (element.type === 'text') {
      lines.push(element.content);
      continue;
    }

    if (!element.file) continue;

    const filePath = path.join(resourceDir, element.file);
    const base64Data = await processMediaFile(filePath, element.type === 'img' ? 'image' : 'video');
    if (!base64Data) continue;

    if (element.type === 'img') {
      lines.push(h('image', { src: base64Data }));
    } else if (session) {
      // 视频单独发送
      await session.send(h('video', { src: base64Data }));
    }
  }

  lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));
  return lines.join('\n');
}

// 媒体处理及回复
async function extractMediaContent(originalContent: string): Promise<{
  imageUrls: string[],
  imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>,
  videoUrls: string[],
  videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>,
  textParts: Element[]
}> {
  const textParts = originalContent
    .split(/<(img|video)[^>]+>/)
    .map((text, idx) => text.trim() && ({
      type: 'text' as const,
      content: text.replace(/^(img|video)$/, '').trim(),  // 移除单独的 img 或 video 文本
      index: idx * 3
    }))
    .filter(text => text && text.content);  // 过滤掉空内容

  const getMediaElements = (type: 'img' | 'video') => {
    const regex = new RegExp(`<${type}[^>]+src="([^"]+)"[^>]*>`, 'g');
    const elements: Array<{ type: typeof type; index: number; fileName?: string; fileSize?: string }> = [];
    const urls: string[] = [];

    let match;
    let idx = 0;
    while ((match = regex.exec(originalContent)) !== null) {
      const element = match[0];
      const url = match[1];
      const fileName = element.match(/file="([^"]+)"/)?.[1];
      const fileSize = element.match(/fileSize="([^"]+)"/)?.[1];

      urls.push(url);
      elements.push({
        type,
        index: idx * 3 + (type === 'img' ? 1 : 2),
        fileName,
        fileSize
      });
      idx++;
    }
    return { urls, elements };
  };

  const { urls: imageUrls, elements: imageElementsRaw } = getMediaElements('img');
  const imageElements = imageElementsRaw as Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  const { urls: videoUrls, elements: videoElementsRaw } = getMediaElements('video');
  const videoElements = videoElementsRaw as Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
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
  const { ext, accept, maxSize } = mediaType === 'img'
    ? { ext: 'png', accept: 'image/*', maxSize: config.imageMaxSize }
    : { ext: 'mp4', accept: 'video/*', maxSize: config.videoMaxSize };

  const downloadTasks = urls.map(async (url, i) => {
    // 检查文件大小
    const sizeInBytes = fileSizes[i] && parseInt(fileSizes[i]!);
    if (sizeInBytes && sizeInBytes > maxSize * 1024 * 1024) {
      throw new Error('file_size_exceeded');
    }

    // 生成文件名
    const fileName = fileNames[i];
    const fileExt = fileName?.match(/\.[a-zA-Z0-9]+$/)?.[0]?.slice(1) || ext;
    const baseName = fileName
      ? path.basename(fileName, path.extname(fileName)).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
      : String(i + 1);
    const finalFileName = `${caveId}_${baseName}.${fileExt}`;

    // 下载和保存
    const response = await ctx.http(decodeURIComponent(url).replace(/&amp;/g, '&'), {
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': accept,
        'Referer': 'https://qq.com'
      }
    });

    if (!response.data) throw new Error('empty_response');

    await fs.promises.writeFile(path.join(resourceDir, finalFileName), Buffer.from(response.data));
    return finalFileName;
  });

  const results = await Promise.allSettled(downloadTasks);
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map(result => result.value);

  if (!successfulResults.length) {
    const firstError = results[0] as PromiseRejectedResult;
    throw new Error(firstError.reason.message === 'file_size_exceeded'
      ? session.text('commands.cave.message.mediaSizeExceeded', [mediaType])
      : session.text(`commands.cave.error.upload${mediaType === 'img' ? 'Image' : 'Video'}Failed`));
  }

  return successfulResults;
}
