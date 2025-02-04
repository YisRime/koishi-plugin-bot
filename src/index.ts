// ================ 导入、接口定义与配置 =================
// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

// 基础定义
export const name = 'cave';
export const inject = ['database'];

// 配置Schema
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员账号'),
  number: Schema.number().default(60).description('群内调用冷却时间（秒）'),
  enableAudit: Schema.boolean().default(false).description('是否开启审核功能'),
  // 新增配置项
  allowVideo: Schema.boolean().default(true).description('是否允许用户添加视频'),
  allowAudio: Schema.boolean().default(true).description('是否允许用户添加音频'),
  videoMaxSize: Schema.number().default(10).description('允许添加的视频最大大小（MB）'),
  imageMaxSize: Schema.number().default(4).description('允许添加的图片最大大小（MB）'),
});

// 插件主函数：初始化和命令注册
export async function apply(ctx: Context, config: Config) {
  const { caveFilePath, resourceDir, pendingFilePath } = await initCavePaths(ctx);
  // 群组冷却时间管理
  const lastUsed: Map<string, number> = new Map();

  // 命令处理主函数
  ctx.command('cave [message:text]', '回声洞')
    .usage('支持添加、抽取、查看、查询回声洞')
    .example('cave           随机抽取回声洞')
    .example('cave -a 内容   添加新回声洞')
    .example('cave -g/r x      查看/删除指定回声洞')
    .example('cave -p/d x/all  通过/拒绝待审回声洞')
    .example('cave -l x      查询投稿者投稿列表')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    // 仅对 -l、-p 和 -d 指令进行权限检查
    .before(async ({ session, options }) => {
      // 如果输入内容包含 "-help"，不进行权限检查
      if (session.content && session.content.includes('-help')) return;
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return '只有管理员才能执行此操作';
      }
    })
    .action(async ({ session, options }, ...content) => {
      return await handleCaveAction(ctx, config, session, options, content, lastUsed);
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
  // 新增配置项
  allowVideo: boolean;
  allowAudio: boolean;
  videoMaxSize: number;
  imageMaxSize: number;
}

// 定义数据类型接口
interface Element {
  type: 'text' | 'img' | 'video' | 'audio'; // 新增 'audio' 类型
  content?: string;      // 文本内容
  file?: string;         // 图片或视频文件名
  index: number;         // 排序索引
}

// 定义回声洞数据结构
interface CaveObject {
  cave_id: number;             // 回声洞唯一ID
  elements: Element[];         // 内容元素数组
  contributor_number: string;  // 投稿者ID
  contributor_name: string;    // 投稿者昵称
}

interface PendingCave extends CaveObject {}

// ================ 文件操作工具 =================
function readJsonData<T>(filePath: string, validator?: (item: any) => boolean): T[] {
  try {
    // 读取并解析JSON文件
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data || '[]');

    // 验证数据结构
    if (!Array.isArray(parsed)) return [];
    return validator ? parsed.filter(validator) : parsed;
  } catch (error) {
    logger.error(`读取文件失败 ${filePath}: ${error.message}`);
    return [];
  }
}

function writeJsonData<T>(filePath: string, data: T[]): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.error(`写入文件失败: ${error.message}`);
    throw error;
  }
}

// 文件操作工具
async function ensureDirectory(dir: string): Promise<void> {
  try {
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  } catch (error) {
    logger.error(`创建目录失败 ${dir}: ${error.message}`);
    throw error;
  }
}

async function ensureJsonFile(filePath: string, defaultContent = '[]'): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) {
      await fs.promises.writeFile(filePath, defaultContent, 'utf8');
    }
  } catch (error) {
    logger.error(`创建文件失败 ${filePath}: ${error.message}`);
    throw error;
  }
}

// ================ 图片处理函数 =================
// 删除原来的 saveImages 与 saveVideos，并新增 saveMedia 函数
// 新增：通过 HEAD 请求获取 URL 扩展名，不解析 URL
async function getUrlExtension(url: string, ctx: Context, defaultExt: string): Promise<string> {
  try {
    const response = await ctx.http.get(url, { method: 'HEAD' });
    const contentType = (response.headers && (response.headers as Record<string, string>)['content-type']) || '';
    if (contentType) {
      return contentType.split('/').pop() || defaultExt;
    }
  } catch (error) {
    logger.error(`获取扩展名失败: ${error.message}`);
  }
  return defaultExt;
}

// 新增辅助函数：统一处理URL解码
function processUrl(url: string): string {
  try {
    const decoded = decodeURIComponent(url);
    return decoded.includes('multimedia.nt.qq.com.cn') ? decoded.replace(/&amp;/g, '&') : url;
  } catch {
    return url;
  }
}

// 新增：获取音频文件路径的辅助函数
function getAudioPath(url: any): string | null {
  if (typeof url === 'object' && url !== null) {
    // 尝试获取各种可能的路径
    const possiblePaths = [
      url.attrs?.path,
      url.attrs?.file,
      url.path,
      url.file,
    ].filter(Boolean);

    // 尝试每个路径
    for (const path of possiblePaths) {
      if (path && typeof path === 'string' && fs.existsSync(path)) {
        return path;
      }
    }
  }
  return null;
}

// 修改 fetchAudioBuffer 函数，确保所有 URL 都经过 processUrl 处理
async function fetchAudioBuffer(url: any, suggestion: string | undefined, ctx: Context): Promise<Buffer> {
  try {
    // 1. 如果传入的是 Buffer，直接返回
    if (Buffer.isBuffer(url)) {
      return url;
    }

    // 2. 如果有建议的文件路径，尝试读取
    if (suggestion && fs.existsSync(suggestion)) {
      return await fs.promises.readFile(suggestion);
    }

    // 3. 如果是对象，尝试从对象中获取数据
    if (typeof url === 'object' && url !== null) {
      // 尝试直接获取 buffer 数据
      if (url.data && Buffer.isBuffer(url.data)) {
        return url.data;
      }

      // 尝试获取消息中的音频文件路径
      const audioPath = getAudioPath(url);
      if (audioPath) {
        return await fs.promises.readFile(audioPath);
      }

      // 尝试从 rawMessage 中获取数据
      if (url.rawMessage?.data && Buffer.isBuffer(url.rawMessage.data)) {
        return url.rawMessage.data;
      }

      // 从消息内容中解析 base64 数据
      if (url.content && typeof url.content === 'string') {
        const content = processUrl(url.content);
        if (content.startsWith('base64://')) {
          return Buffer.from(content.slice(9), 'base64');
        }
      }

      // 尝试获取音频 URL
      const rawUrl = url.url || url.src || url.attrs?.url || url.attrs?.src;
      if (rawUrl && typeof rawUrl === 'string') {
        const processedUrl = processUrl(rawUrl);
        if (processedUrl.startsWith('http')) {
          const response = await ctx.http.get<ArrayBuffer>(processedUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
          });
          return Buffer.from(response);
        }
        if (fs.existsSync(processedUrl)) {
          return await fs.promises.readFile(processedUrl);
        }
      }

      // 如果对象包含 session 和 bot，尝试通过 API 获取
      if (url.session?.bot && typeof url.session.bot.getAudio === 'function') {
        const audioData = await url.session.bot.getAudio(url);
        if (audioData) {
          return Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
        }
      }
    }

    // 4. 如果是字符串路径，确保经过 processUrl 处理
    if (typeof url === 'string') {
      const processedUrl = processUrl(url);
      if (fs.existsSync(processedUrl)) {
        return await fs.promises.readFile(processedUrl);
      }
      if (processedUrl.startsWith('http')) {
        const response = await ctx.http.get<ArrayBuffer>(processedUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });
        return Buffer.from(response);
      }
      if (processedUrl.startsWith('base64://')) {
        return Buffer.from(processedUrl.slice(9), 'base64');
      }
    }

    throw new Error('无法获取音频数据');
  } catch (error) {
    logger.error(`获取音频数据失败: ${error.message}`);
    throw error;
  }
}

// 修改：通用的媒体文件大小检查函数，增加预检查功能
function checkMediaSize(mediaType: 'img' | 'video', config: Config, fileSize?: number, buffer?: Buffer): void {
  const maxSize = mediaType === 'img' ? config.imageMaxSize : config.videoMaxSize;
  const mediaTypeName = mediaType === 'img' ? '图片' : '视频';

  // 如果提供了 fileSize，优先使用它进行检查
  if (fileSize !== undefined) {
    const sizeInMB = fileSize / (1024 * 1024);
    if (sizeInMB > maxSize) {
      logger.error(`${mediaTypeName}超出大小限制 (${maxSize}MB), 当前大小: ${sizeInMB.toFixed(2)}MB`);
      throw new Error(`${mediaTypeName}超出大小限制 (${maxSize}MB)`);
    }
    return;
  }

  // 如果没有 fileSize 但有 buffer，使用 buffer 检查
  if (buffer) {
    const sizeInMB = buffer.byteLength / (1024 * 1024);
    if (sizeInMB > maxSize) {
      logger.error(`${mediaTypeName}超出大小限制 (${maxSize}MB), 当前大小: ${sizeInMB.toFixed(2)}MB`);
      throw new Error(`${mediaTypeName}超出大小限制 (${maxSize}MB)`);
    }
  }
}

// 新增类型定义，用于处理消息对象
interface MediaElement {
  type?: string;
  attrs?: {
    url?: string;
    src?: string;
    file?: string;
    path?: string;
    fileSize?: number;
    size?: number;
  };
  size?: number;
  url?: string;
  src?: string;
}

// 修改 saveMedia 函数，添加类型安全检查和错误处理
async function saveMedia(
  urls: (string | MediaElement)[],
  fileSuggestions: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  config: Config,
  ctx: Context,
  mediaType: 'img' | 'video' | 'audio'
): Promise<string[]> {
  const savedFiles: string[] = [];
  const defaults = {
    img: { ext: 'png', accept: 'image/*' },
    video: { ext: 'mp4', accept: 'video/*' },
    audio: { ext: 'amr' }
  }[mediaType];

  for (let i = 0; i < urls.length; i++) {
    try {
      const url = urls[i];
      let ext = defaults.ext;
      const suggestion = fileSuggestions[i];

      // 处理扩展名
      if (suggestion) {
        const parsed = path.extname(suggestion).slice(1);
        if (parsed) ext = parsed;
      }

      // 处理对象类型的 URL
      if (typeof url === 'object' && url !== null) {
        // 预先检查文件大小
        if (mediaType === 'img' || mediaType === 'video') {
          const fileSize = Number(
            url.attrs?.fileSize ||
            url.attrs?.size ||
            url.size ||
            0
          );
          if (fileSize > 0) {
            checkMediaSize(mediaType, config, fileSize);
          }
        }

        // 获取实际 URL
        if (mediaType !== 'audio') {
          const actualUrl = url.attrs?.url || url.attrs?.src || url.url || url.src;
          if (actualUrl && typeof actualUrl === 'string') {
            ext = await getUrlExtension(actualUrl, ctx, defaults.ext);
          }
        }
      }

      const filename = `${caveId}_${i + 1}.${ext}`;
      const targetPath = path.join(resourceDir, filename);

      let buffer: Buffer;
      if (mediaType === 'audio') {
        buffer = await fetchAudioBuffer(url, suggestion, ctx);
      } else {
        const actualUrl = typeof url === 'string' ? url :
          url.attrs?.url || url.attrs?.src || url.url || url.src;

        if (!actualUrl) {
          throw new Error('无法获取媒体URL');
        }

        const response = await ctx.http.get<ArrayBuffer>(processUrl(actualUrl), {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: mediaType === 'img' || mediaType === 'video' ? {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': defaults.accept,
            'Referer': 'https://qq.com'
          } : {}
        });
        buffer = Buffer.from(response);

        // 如果没有预先检查过大小，使用 buffer 检查
        if ((mediaType === 'img' || mediaType === 'video') &&
            typeof url === 'object' &&
            !url.attrs?.fileSize) {
          checkMediaSize(mediaType, config, undefined, buffer);
        }
      }

      // 保存文件
      if (fs.existsSync(targetPath)) {
        await fs.promises.unlink(targetPath);
      }
      await fs.promises.writeFile(targetPath, buffer);
      savedFiles.push(filename);

      logger.success(`${mediaType}文件保存成功: ${filename}`);
    } catch (error) {
      const mediaTypeName = mediaType === 'img' ? '图片' : mediaType === 'video' ? '视频' : '音频';
      logger.error(`保存${mediaTypeName}失败: ${error.message}`);
      throw error;
    }
  }
  return savedFiles;
}

// ================ 审核相关函数 =================
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string) {
  const auditMessage = `待审核回声洞：\n${content}
来自：${cave.contributor_number}`;
  for (const managerId of config.manager) {
    try {
      await ctx.bots[0]?.sendPrivateMessage(managerId, auditMessage);
    } catch (error) {
      logger.error(`发送审核消息 ${managerId} 失败: ${error.message}`);
    }
  }
}

// 审核相关函数
async function handleSingleCaveAudit(
  ctx: Context,
  cave: PendingCave,
  isApprove: boolean,
  resourceDir: string,
  data?: CaveObject[]
): Promise<boolean> {
  try {
    if (isApprove && data) {
      const caveWithoutIndex = {
        ...cave,
        elements: cleanElementsForSave(cave.elements, false)
      };
      data.push(caveWithoutIndex);
      logger.info(`审核通过回声洞（${cave.cave_id}）`);
    } else if (!isApprove && cave.elements) {
      for (const element of cave.elements) {
        if (element.type === 'img' && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
      logger.info(`审核失败回声洞（${cave.cave_id}）`);
    }
    return true;
  } catch (error) {
    logger.error(`处理回声洞（${cave.cave_id}）失败: ${error.message}`);
    return false;
  }
}

async function handleAudit(
  ctx: Context,
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string,
  targetId?: number
): Promise<string> {
  if (pendingData.length === 0) return '没有待审核回声洞';

  // 处理单条审核
  if (typeof targetId === 'number') {
    const pendingIndex = pendingData.findIndex(item => item.cave_id === targetId);
    if (pendingIndex === -1) return '未找到该待审核回声洞';

    const cave = pendingData[pendingIndex];
    const data = isApprove ? readJsonData<CaveObject>(caveFilePath) : null;

    const success = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data);
    if (!success) return '处理失败，请稍后重试';

    if (isApprove && data) writeJsonData(caveFilePath, data);
    pendingData.splice(pendingIndex, 1);
    writeJsonData(pendingFilePath, pendingData);

    const remainingCount = pendingData.length;
    if (remainingCount > 0) {
      const remainingIds = pendingData.map(c => c.cave_id).join(', ');
      return `${isApprove ? '审核通过' : '拒绝'}成功，还有 ${remainingCount} 条待审核：[${remainingIds}]`;
    }
    return isApprove ? '已通过该回声洞' : '已拒绝该回声洞';
  }

  // 处理批量审核
  const data = isApprove ? readJsonData<CaveObject>(caveFilePath) : null;
  let processedCount = 0;

  for (const cave of pendingData) {
    const success = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data);
    if (success) processedCount++;
  }

  if (isApprove && data) writeJsonData(caveFilePath, data);
  writeJsonData(pendingFilePath, []);

  return isApprove ?
    `✅ 已通过 ${processedCount}/${pendingData.length} 条回声洞` :
    `❌ 已拒绝 ${processedCount}/${pendingData.length} 条回声洞`;
}

// ================ 消息构建函数 =================
// 在文件顶部添加清理函数
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  const sorted = elements.sort((a, b) => a.index - b.index);
  return sorted.map(({ type, content, file, index }) => ({
    type,
    ...(keepIndex && { index }),
    ...(content && { content }),
    ...(file && { file })
  }));
}

// 新增辅助函数：发送媒体块(视频/音频)
function sendMediaSection(
  session: any,
  resourceDir: string,
  cave: CaveObject,
  mediaType: 'video' | 'audio',
  mediaElements: { file: string }[]
): void {
  if (mediaElements.length === 0) return;
  const header = `回声洞 ——（${cave.cave_id}）\n（↓${mediaType === 'video' ? '视频' : '音频'}↓）\n—— ${cave.contributor_name}`;
  session.send(header);
  for (const media of mediaElements) {
    try {
      const fullPath = path.join(resourceDir, media.file);
      if (fs.existsSync(fullPath)) {
        const mediaBuffer = fs.readFileSync(fullPath);
        const base64 = mediaBuffer.toString('base64');
        const type = mediaType === 'video' ? 'video/mp4' : 'audio/amr';
        session.send(h(mediaType, { src: `data:${type};base64,${base64}` }));
      }
    } catch (error) {
      logger.error(`发送${mediaType}失败: ${error.message}`);
    }
  }
}

// ---------------- 修改 buildMessage 函数 ----------------
function buildMessage(cave: CaveObject, resourceDir: string, session?: any): string {
  let text = ""; // 收集纯文本和图片部分
  const videoElements: { file: string }[] = [];
  const audioElements: { file: string }[] = [];
  for (const element of cave.elements) {
    if (element.type === 'text') {
      text += element.content + '\n';
    } else if (element.type === 'img' && element.file) {
      try {
        const fullImagePath = path.join(resourceDir, element.file);
        if (fs.existsSync(fullImagePath)) {
          const imageBuffer = fs.readFileSync(fullImagePath);
          const base64Image = imageBuffer.toString('base64');
          text += h('image', { src: `data:image/png;base64,${base64Image}` }) + '\n';
        }
      } catch (error) {
        logger.error(`读取图片失败: ${error.message}`);
      }
    } else if (element.type === 'video' && element.file) {
      videoElements.push({ file: element.file });
    } else if (element.type === 'audio' && element.file) {
      audioElements.push({ file: element.file });
    }
  }
  if (session) {
    sendMediaSection(session, resourceDir, cave, 'video', videoElements);
    sendMediaSection(session, resourceDir, cave, 'audio', audioElements);
    if (text.trim()) session.send(text);
    return '';
  }
  text += `—— ${cave.contributor_name}`;
  return text;
}

// ================ 初始化函数 =================
// 新增函数：初始化 cave 所需的目录和文件路径
export async function initCavePaths(ctx: Context): Promise<{
  dataDir: string,
  caveDir: string,
  caveFilePath: string,
  resourceDir: string, // 修改变量名
  pendingFilePath: string
}> {
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');
  const caveFilePath = path.join(caveDir, 'cave.json');
  const resourceDir = path.join(caveDir, 'resources'); // 目录名称更新
  const pendingFilePath = path.join(caveDir, 'pending.json');

  await ensureDirectory(dataDir);
  await ensureDirectory(caveDir);
  await ensureDirectory(resourceDir); // 修改调用
  await ensureJsonFile(caveFilePath);
  await ensureJsonFile(pendingFilePath);

  return { dataDir, caveDir, caveFilePath, resourceDir, pendingFilePath };
}

// ================ 主业务函数 =================
// 修改 handleCaveAction: 调用 initCavePaths 获取各路径
export async function handleCaveAction(
  ctx: Context,
  config: Config,
  session: any,
  options: any,
  content: string[],
  lastUsed: Map<string, number>
): Promise<string> {
  const { caveFilePath, resourceDir, pendingFilePath } = await initCavePaths(ctx);

  // 提取查询投稿统计的函数（cave -l）
  async function processList(): Promise<string> {
    const caveData = readJsonData<CaveObject>(caveFilePath);
    const caveDir = path.dirname(caveFilePath);
    const stats: Record<string, number[]> = {};
    for (const cave of caveData) {
      if (cave.contributor_number === '10000') continue;
      if (!stats[cave.contributor_number]) stats[cave.contributor_number] = [];
      stats[cave.contributor_number].push(cave.cave_id);
    }
    const statFilePath = path.join(caveDir, 'stat.json');
    try {
      fs.writeFileSync(statFilePath, JSON.stringify(stats, null, 2), 'utf8');
    } catch (error) {
      logger.error(`写入投稿统计失败: ${error.message}`);
    }
    function formatIds(ids: number[]): string {
      const lines: string[] = [];
      for (let i = 0; i < ids.length; i += 10) {
        lines.push(ids.slice(i, i + 10).join(', '));
      }
      return lines.join('\n');
    }
    let queryId: string | null = null;
    if (typeof options.l === 'string') {
      const match = String(options.l).match(/\d+/);
      if (match) queryId = match[0];
    } else if (content.length > 0) {
      const numberMatch = content.join(' ').match(/\d+/);
      if (numberMatch) queryId = numberMatch[0];
    }
    if (queryId) {
      if (stats[queryId]) {
        const count = stats[queryId].length;
        return `${queryId} 共计投稿 ${count} 项回声洞:\n` + formatIds(stats[queryId]);
      } else {
        return `未找到投稿者 ${queryId}`;
      }
    } else {
      let total = 0;
      const lines = Object.entries(stats).map(([cid, ids]) => {
        total += ids.length;
        return `${cid} 共计投稿 ${ids.length} 项回声洞:\n` + formatIds(ids);
      });
      return `共计投稿 ${total} 项回声洞:\n` + lines.join('\n');
    }
  }

  // 提取审核操作的函数（cave -p / -d）
  async function processAudit(): Promise<string> {
    const pendingData = readJsonData<PendingCave>(pendingFilePath);
    const isApprove = Boolean(options.p);
    if ((options.p === true && content[0] === 'all') ||
        (options.d === true && content[0] === 'all')) {
      return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath);
    }
    const id = parseInt(content[0] ||
      (typeof options.p === 'string' ? options.p : '') ||
      (typeof options.d === 'string' ? options.d : ''));
    if (isNaN(id)) return '请输入正确的回声洞序号';
    return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, id);
  }

  // ---------------- 修改 processView 函数 ----------------
  async function processView(): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
    if (isNaN(caveId)) return '请输入正确的回声洞序号';
    const data = readJsonData<CaveObject>(caveFilePath, item =>
      item &&
      typeof item.cave_id === 'number' &&
      Array.isArray(item.elements) &&
      item.elements.every(el =>
        (el.type === 'text' && typeof el.content === 'string') ||
        (el.type === 'img' && typeof el.file === 'string') ||
        (el.type === 'video' && typeof el.file === 'string')
      ) &&
      typeof item.contributor_number === 'string' &&
      typeof item.contributor_name === 'string'
    );
    const cave = data.find(item => item.cave_id === caveId);
    if (!cave) return '未找到该序号的回声洞';

    // 调用 buildMessage 时传入 session 以发送视频
    return buildMessage(cave, resourceDir, session);
  }

  // 提取随机抽取的函数（不带 -a, -g, -r 及审核指令）
  async function processRandom(): Promise<string> {
    const data = readJsonData<CaveObject>(caveFilePath, item =>
      item &&
      typeof item.cave_id === 'number' &&
      Array.isArray(item.elements) &&
      item.elements.every(el =>
        (el.type === 'text' && typeof el.content === 'string') ||
        (el.type === 'img' && typeof el.file === 'string')
      ) &&
      typeof item.contributor_number === 'string' &&
      typeof item.contributor_name === 'string'
    );
    if (data.length === 0) return '暂无回声洞可用';
    const guildId = session.guildId;
    const now = Date.now();
    const lastCall = lastUsed.get(guildId) || 0;
    const isManager = config.manager.includes(session.userId);
    if (!isManager && now - lastCall < config.number * 1000) {
      const waitTime = Math.ceil((config.number * 1000 - (now - lastCall)) / 1000);
      return `群聊冷却中...请${waitTime}秒后再试`;
    }
    if (!isManager) lastUsed.set(guildId, now);
    const cave = (() => {
      const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
      if (!validCaves.length) return undefined;
      const randomIndex = Math.floor(Math.random() * validCaves.length);
      return validCaves[randomIndex];
    })();
    return cave ? buildMessage(cave, resourceDir) : '获取回声洞失败';
  }

  // 提取删除操作的函数（cave -r）
  async function processDelete(): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
    if (isNaN(caveId)) return '请输入正确的回声洞序号';
    const data = readJsonData<CaveObject>(caveFilePath, item =>
      item && typeof item.cave_id === 'number'
    );
    const pendingData = readJsonData<PendingCave>(pendingFilePath);
    const index = data.findIndex(item => item.cave_id === caveId);
    const pendingIndex = pendingData.findIndex(item => item.cave_id === caveId);
    if (index === -1 && pendingIndex === -1) return '未找到该序号的回声洞';
    let targetCave: CaveObject;
    let isPending = false;
    if (index !== -1) {
      targetCave = data[index];
    } else {
      targetCave = pendingData[pendingIndex];
      isPending = true;
    }
    if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
      return '你不是这条回声洞的添加者！';
    }
    if (targetCave.elements) {
      try {
        for (const element of targetCave.elements) {
          if ((element.type === 'img' || element.type === 'video' || element.type === 'audio') && element.file) {
            const fullPath = path.join(resourceDir, element.file);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          }
        }
      } catch (error) {
        logger.error(`删除媒体失败: ${error.message}`);
      }
    }
    // 获取回声洞内容（调用 buildMessage 不传 session 返回纯文本）
    const caveContent = buildMessage(targetCave, resourceDir);
    if (isPending) {
      pendingData.splice(pendingIndex, 1);
      writeJsonData(pendingFilePath, pendingData);
      return `✅ 已删除（待审核）\n${caveContent}`;
    } else {
      data.splice(index, 1);
      writeJsonData(caveFilePath, data);
      return `✅ 已删除\n${caveContent}`;
    }
  }

// 新增辅助函数：解析文本及媒体标签
function parseMessage(content: string, commandPattern?: RegExp): {
  textParts: Element[],
  imageUrls: string[],
  imageElements: { type: 'img'; index: number; fileAttr?: string }[],
  videoUrls: string[],
  videoElements: { type: 'video'; index: number; fileAttr?: string }[],
  audioUrls: string[],
  audioElements: { type: 'audio'; index: number; fileAttr?: string }[]
} {
  if (commandPattern) content = content.replace(commandPattern, '');
  // 使用非贪婪模式并支持换行字符
  const textParts: Element[] = content.split(/<img[\s\S]*?>|<video[\s\S]*?>|<audio[\s\S]*?>/g)
    .map(t => t.trim()).filter(t => t)
    .map((text, idx) => ({ type: 'text', content: text, index: idx * 3 }));
  const imageMatches = content.match(/<img[\s\S]*?src="([^"]+)"[^>]*>/g) || [];
  const videoMatches = content.match(/<video[\s\S]*?src="([^"]+)"[^>]*>/g) || [];
  const audioMatches = content.match(/<audio[\s\S]*?src="([^"]+)"/g) || [];
  const imageUrls: string[] = [];
  const imageElements: { type: 'img'; index: number; fileAttr?: string }[] = [];
  imageMatches.forEach((img, idx) => {
    const srcMatch = img.match(/src="([^"]+)"/);
    const fileMatch = img.match(/file="([^"]+)"/);
    if (srcMatch?.[1]) {
      imageUrls.push(srcMatch[1]);
      imageElements.push({ type: 'img', index: idx * 3 + 1, fileAttr: fileMatch?.[1] });
    }
  });
  const videoUrls: string[] = [];
  const videoElements: { type: 'video'; index: number; fileAttr?: string }[] = [];
  videoMatches.forEach((video, idx) => {
    const srcMatch = video.match(/src="([^"]+)"/);
    const fileMatch = video.match(/file="([^"]+)"/);
    if (srcMatch?.[1]) {
      videoUrls.push(srcMatch[1]);
      videoElements.push({ type: 'video', index: idx * 3 + 2, fileAttr: fileMatch?.[1] });
    }
  });
  const audioUrls: string[] = [];
  const audioElements: { type: 'audio'; index: number; fileAttr?: string }[] = [];
  audioMatches.forEach((audio, idx) => {
    const srcMatch = audio.match(/src="([^"]+)"/);
    const fileMatch = audio.match(/file="([^"]+)"/);
    if (srcMatch?.[1]) {
      audioUrls.push(srcMatch[1]);
      audioElements.push({ type: 'audio', index: idx * 3 + 3, fileAttr: fileMatch?.[1] });
    }
  });
  return { textParts, imageUrls, imageElements, videoUrls, videoElements, audioUrls, audioElements };
}

// 修改 processAdd 函数，使用 parseMessage 辅助函数代替重复解析逻辑
async function processAdd(): Promise<string> {
  // 提取原始内容
  const originalContent = session.quote?.content || session.content;
  // 定义命令剔除模式
  const prefixes = Array.isArray(session.app.config.prefix)
    ? session.app.config.prefix
    : [session.app.config.prefix];
  const nicknames = Array.isArray(session.app.config.nickname)
    ? session.app.config.nickname
    : session.app.config.nickname ? [session.app.config.nickname] : [];
  const allTriggers = [...prefixes, ...nicknames];
  const triggerPattern = new RegExp(`^(?:${allTriggers.map(t => t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')}).*?-a\\s*`);

  // 解析原始内容
  let { textParts, imageUrls, imageElements, videoUrls, videoElements, audioUrls, audioElements } = parseMessage(originalContent, triggerPattern);

  // 若没有任何内容，则提示回复并解析
  if (textParts.length === 0 && imageElements.length === 0 && videoElements.length === 0 && audioElements.length === 0) {
    await session.send('请发送你想添加到回声洞的内容：');
    const reply = await session.prompt({ timeout: 60000 });
    if (reply) {
      const replyResult = parseMessage(reply);
      // 合并两次解析结果
      textParts = textParts.concat(replyResult.textParts);
      imageUrls = imageUrls.concat(replyResult.imageUrls);
      imageElements = imageElements.concat(replyResult.imageElements);
      videoUrls = videoUrls.concat(replyResult.videoUrls);
      videoElements = videoElements.concat(replyResult.videoElements);
      audioUrls = audioUrls.concat(replyResult.audioUrls);
      audioElements = audioElements.concat(replyResult.audioElements);
    } else {
      return '已放弃本次添加';
    }
  }

  // 判断是否允许添加视频/音频
  if (videoUrls.length > 0 && !config.allowVideo) {
    return '当前不允许添加视频';
  }
  if (audioUrls.length > 0 && !config.allowAudio) {
    return '当前不允许添加音频';
  }

  // 生成新的回声洞ID及保存媒体文件
  const pendingData = readJsonData<PendingCave>(pendingFilePath);
  const data = readJsonData<CaveObject>(caveFilePath, item => item && typeof item.cave_id === 'number');
  const maxDataId = data.length > 0 ? Math.max(...data.map(item => item.cave_id)) : 0;
  const maxPendingId = pendingData.length > 0 ? Math.max(...pendingData.map(item => item.cave_id)) : 0;
  const caveId = Math.max(maxDataId, maxPendingId) + 1;

  let savedImages: string[] = [];
  if (imageUrls.length > 0) {
    try {
      const fileSuggestions = imageElements.map(el => el.fileAttr);
      savedImages = await saveMedia(imageUrls, fileSuggestions, resourceDir, caveId, config, ctx, 'img');
    } catch (error) {
      logger.error(`保存图片失败: ${error.message}`);
      return `添加失败：保存图片失败: ${error.message}`;
    }
  }

  let savedVideos: string[] = [];
  if (videoUrls.length > 0) {
    try {
      const fileSuggestions = videoElements.map(el => el.fileAttr);
      savedVideos = await saveMedia(videoUrls, fileSuggestions, resourceDir, caveId, config, ctx, 'video');
    } catch (error) {
      return `添加失败：超出 ${config.videoMaxSize}MB 限制`;
    }
  }

  let savedAudios: string[] = [];
  if (audioUrls.length > 0) {
    try {
      const fileSuggestions = audioElements.map(el => el.fileAttr);
      savedAudios = await saveMedia(audioUrls, fileSuggestions, resourceDir, caveId, config, ctx, 'audio');
    } catch (error) {
      logger.error(`保存音频失败: ${error.message}`);
      return `添加失败：保存音频失败: ${error.message}`;
    }
  }

  // 合并所有元素：文本/图片/视频/音频
  const elements: Element[] = [];
  elements.push(...textParts);
  savedImages.forEach((file, idx) => {
    if (imageElements[idx]) elements.push({ ...imageElements[idx], type: 'img', file });
  });
  savedVideos.forEach((file, idx) => {
    if (videoElements[idx]) elements.push({ ...videoElements[idx], type: 'video', file });
  });
  savedAudios.forEach((file, idx) => {
    if (audioElements[idx]) elements.push({ ...audioElements[idx], type: 'audio', file });
  });
  elements.sort((a, b) => a.index - b.index);

  // 获取投稿者信息
  let contributorName = session.username;
  if (ctx.database) {
    try {
      const userInfo = await ctx.database.getUser(session.platform, session.userId);
      contributorName = (userInfo as unknown as User)?.nickname || session.username;
    } catch (error) {
      logger.error(`获取用户昵称失败: ${error.message}`);
    }
  }

  const newCave: CaveObject = {
    cave_id: caveId,
    elements: cleanElementsForSave(elements, true),
    contributor_number: session.userId,
    contributor_name: contributorName
  };

  if (config.enableAudit) {
    pendingData.push({ ...newCave, elements: cleanElementsForSave(elements, true) });
    writeJsonData(pendingFilePath, pendingData);
    await sendAuditMessage(ctx, config, newCave, buildMessage(newCave, resourceDir));
    return `✨ 已提交审核，序号为 (${caveId})`;
  }

  const caveWithoutIndex = { ...newCave, elements: cleanElementsForSave(elements, false) };
  data.push(caveWithoutIndex);
  writeJsonData(caveFilePath, data);
  return `✨ 添加成功！序号为 (${caveId})`;
}

  try {
    if (options.l !== undefined) return await processList();
    if (options.p || options.d) return await processAudit();
    if (options.g) return await processView();
    if (options.r) return await processDelete();
    if (options.a) return await processAdd();
    return await processRandom();
  } catch (error) {
    logger.error(`操作失败: ${error.message}`);
    return '操作失败，请稍后重试';
  }
}
