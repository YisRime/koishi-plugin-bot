import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

// 初始化日志记录器
const logger = new Logger('cave');

// 插件名称和依赖声明
export const name = 'cave';
export const inject = ['database'];

// 用户基础信息接口
export interface User {
  userId: string;
  username: string;
  nickname?: string;
}

// QQ用户信息接口
export interface getStrangerInfo {
  user_id: string;
  nickname: string;
}

// 插件配置接口和Schema定义
export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;    // 是否开启审核
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员账号，用于审核和管理'),
  number: Schema.number().default(60).description('群内回声洞调用冷却时间（秒）'),
  enableAudit: Schema.boolean().default(false).description('是否开启回声洞审核功能'),
});

// 文本处理相关函数
function processQQImageUrl(url: string): string {
  try {
    // 解码URL
    const decodedUrl = decodeURIComponent(url);

    // 处理QQ图片链接特殊字符
    if (decodedUrl.includes('multimedia.nt.qq.com.cn')) {
      return decodedUrl.replace(/&amp;/g, '&');
    }

    return url;
  } catch (error) {
    logger.error(`处理图片URL失败：${error.message}`);
    return url;
  }
}

// 文件操作相关函数
// 读取JSON数据文件：验证并返回回声洞数据数组
function readJsonFile(filePath: string): CaveObject[] {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data || '[]');
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(item =>
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
  } catch (error) {
    logger.error(`读取文件出错 ${filePath}: ${error.message}`);
    return [];
  }
}

// 写入JSON数据：验证数据格式并保存到文件
function writeJsonFile(filePath: string, data: CaveObject[]): void {
  try {
    // 数据格式验证
    const validData = data.filter(item =>
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
    fs.writeFileSync(filePath, JSON.stringify(validData, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`写入文件出错: ${error.message}`);
  }
}

// 添加待审核数据读写函数
function readPendingFile(filePath: string): PendingCave[] {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (error) {
    logger.error(`读取待审核文件失败 ${filePath}: ${error.message}`);
    return [];
  }
}

function writePendingFile(filePath: string, data: PendingCave[]): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.error(`写入待审核文件失败: ${error.message}`);
  }
}

// 数据处理相关函数
// 修改随机获取一条回声洞数据的逻辑
function getRandomObject(data: CaveObject[]): CaveObject | undefined {
  if (!data || !data.length) return undefined;
  const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
  if (!validCaves.length) return undefined;
  const randomIndex = Math.floor(Math.random() * validCaves.length);
  return validCaves[randomIndex];
}

// 添加获取最大ID的函数
function getMaxId(data: CaveObject[], pendingData: PendingCave[]): number {
  const maxDataId = data.length > 0 ? Math.max(...data.map(item => item.cave_id)) : 0;
  const maxPendingId = pendingData.length > 0 ? Math.max(...pendingData.map(item => item.cave_id)) : 0;
  return Math.max(maxDataId, maxPendingId);
}

// 图片处理相关函数
// 修改图片文件保存函数：处理URL并保存多张图片到本地
async function saveImages(
  urls: string[],
  imageDir: string,
  caveId: number,
  config: Config,
  ctx: Context
): Promise<string[]> {
  const savedFiles: string[] = [];

  for (let i = 0; i < urls.length; i++) {
    try {
      const url = urls[i];
      const ext = path.extname(url) || '.png';
      const filename = `${caveId}_${i + 1}${ext}`;
      const targetPath = path.join(imageDir, filename);
      const processedUrl = processQQImageUrl(url);

      const buffer = await ctx.http.get<ArrayBuffer>(processedUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'image/*',
          'Referer': 'https://qq.com'
        }
      });

      if (buffer && buffer.byteLength > 0) {
        await fs.promises.writeFile(targetPath, Buffer.from(buffer));
        savedFiles.push(filename);
      }
    } catch (error) {
      logger.error(`保存图片失败: ${error.message}`);
    }
  }

  return savedFiles;
}

// 审核相关函数
// 发送审核消息给所有管理员
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string) {
  const auditMessage = `📝 新回声洞待审核 [${cave.cave_id}]
来源：${cave.groupId ? `群${cave.groupId}` : '私聊'}
投稿：${cave.contributor_name}
内容：${content}`;

  for (const managerId of config.manager) {
    try {
      await ctx.bots[0]?.sendPrivateMessage(managerId, auditMessage);
    } catch (error) {
      logger.error(`发送审核消息给管理员 ${managerId} 失败: ${error.message}`);
    }
  }
}

// 修改回声洞数据结构定义
interface Element {
  type: 'text' | 'img';
  content?: string;
  file?: string;
}

interface CaveObject {
  cave_id: number;
  elements: Element[];
  contributor_number: string;
  contributor_name: string;
}

// 添加待审核回声洞接口
interface PendingCave extends CaveObject {
  groupId?: string;        // 来源群号
}

// 在审核相关函数部分添加新函数
async function handleSingleCaveAudit(
  ctx: Context,
  cave: PendingCave,
  isApprove: boolean,
  imageDir: string,
  data?: CaveObject[]
): Promise<boolean> {
  try {
    if (isApprove && data) {
      data.push(cave);
      logger.info(`审核通过回声洞 [${cave.cave_id}], 来自: ${cave.contributor_name}`);
    } else if (!isApprove && cave.elements) {
      // 删除被拒绝的图片
      for (const element of cave.elements) {
        if (element.type === 'img' && element.file) {
          const fullPath = path.join(imageDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
      logger.info(`拒绝回声洞 [${cave.cave_id}], 来自: ${cave.contributor_name}`);
    }

    if (cave.groupId) {
      await ctx.bots[0]?.sendMessage(cave.groupId,
        isApprove ?
        `✅ 回声洞 [${cave.cave_id}] 已通过审核` :
        `❌ 回声洞 [${cave.cave_id}] 未通过审核`);
    }
    return true;
  } catch (error) {
    logger.error(`处理回声洞 [${cave.cave_id}] 失败: ${error.message}`);
    return false;
  }
}

async function handleAudit(
  ctx: Context,
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  imageDir: string,
  pendingFilePath: string,
  targetId?: number
): Promise<string> {
  if (pendingData.length === 0) return '没有待审核的回声洞';

  // 处理单条审核
  if (typeof targetId === 'number') {
    const pendingIndex = pendingData.findIndex(item => item.cave_id === targetId);
    if (pendingIndex === -1) return '未找到该待审核回声洞';

    const cave = pendingData[pendingIndex];
    const data = isApprove ? readJsonFile(caveFilePath) : null;

    const success = await handleSingleCaveAudit(ctx, cave, isApprove, imageDir, data);
    if (!success) return '处理失败，请稍后重试';

    if (isApprove && data) writeJsonFile(caveFilePath, data);
    pendingData.splice(pendingIndex, 1);
    writePendingFile(pendingFilePath, pendingData);

    const remainingCount = pendingData.length;
    if (remainingCount > 0) {
      const remainingIds = pendingData.map(c => c.cave_id).join(', ');
      return `${isApprove ? '审核通过' : '拒绝'}成功，还有 ${remainingCount} 条待审核：[${remainingIds}]`;
    }
    return isApprove ? '审核通过成功' : '已拒绝该回声洞';
  }

  // 处理批量审核
  const data = isApprove ? readJsonFile(caveFilePath) : null;
  let processedCount = 0;

  for (const cave of pendingData) {
    const success = await handleSingleCaveAudit(ctx, cave, isApprove, imageDir, data);
    if (success) processedCount++;
  }

  if (isApprove && data) writeJsonFile(caveFilePath, data);
  writePendingFile(pendingFilePath, []);

  return isApprove ?
    `✅ 已通过 ${processedCount}/${pendingData.length} 条回声洞` :
    `❌ 已拒绝 ${processedCount}/${pendingData.length} 条回声洞`;
}

// 添加文件系统工具函数
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

// 插件主函数：提供回声洞的添加、查看、删除和随机功能
export async function apply(ctx: Context, config: Config) {
  // 初始化目录结构和文件
  const dataDir = path.join(ctx.baseDir, 'data');         // 数据根目录
  const caveDir = path.join(dataDir, 'cave');             // 回声洞目录
  const caveFilePath = path.join(caveDir, 'cave.json');   // 数据文件
  const imageDir = path.join(caveDir, 'images');          // 图片目录
  const pendingFilePath = path.join(caveDir, 'pending.json');  // 待审核数据文件

  try {
    // 确保所有必要的目录存在
    await ensureDirectory(dataDir);
    await ensureDirectory(caveDir);
    await ensureDirectory(imageDir);

    // 确保数据文件存在
    await ensureJsonFile(caveFilePath);
    await ensureJsonFile(pendingFilePath);
  } catch (error) {
    logger.error('初始化目录结构失败:', error);
    throw error;
  }

  // 群组冷却时间管理
  const lastUsed: Map<string, number> = new Map();

  // 注册回声洞命令
  ctx.command('cave', '回声洞')
    .usage('支持添加、查看、随机获取、审核回声洞')
    .example('cave           随机一条回声洞')
    .example('cave -a 内容   添加新回声洞')
    .example('cave -g 1      查看指定编号回声洞')
    .example('cave -r 1      删除指定编号回声洞')
    .example('cave -p 1      通过指定编号待审核回声洞')
    .example('cave -d 1      拒绝指定编号待审核回声洞')
    .example('cave -p all    一键通过所有待审核回声洞')
    .example('cave -d all    一键拒绝所有待审核回声洞')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })

    // 权限检查：管理员权限
    .before(async ({ session, options }) => {
      if ((options.p || options.d)
          && !config.manager.includes(session.userId)) {
        return '抱歉，只有管理员才能执行此操作';
      }
    })
    .action(async ({ session, options }, ...content) => {
      try {
        // 处理审核命令
        if (options.p || options.d) {
          const pendingData = readPendingFile(pendingFilePath);
          const isApprove = Boolean(options.p);

          // 修改批量审核判断逻辑
          if ((options.p === true && content[0] === 'all') ||
              (options.d === true && content[0] === 'all')) {
            return await handleAudit(ctx, pendingData, isApprove, caveFilePath, imageDir, pendingFilePath);
          }

          // 单条审核
          const id = parseInt(content[0] ||
            (typeof options.p === 'string' ? options.p : '') ||
            (typeof options.d === 'string' ? options.d : ''));

          if (isNaN(id)) return '请输入正确的回声洞编号';

          return await handleAudit(ctx, pendingData, isApprove, caveFilePath, imageDir, pendingFilePath, id);
        }

        const data = readJsonFile(caveFilePath);

        // 处理添加回声洞时的审核消息发送
        if (options.a) {
          let imageURLs: string[] = [];
          let cleanText = '';
          let originalContent = '';

          // 获取完整消息内容
          if (session.quote) {
            originalContent = session.quote.content;
          } else {
            originalContent = session.content;
          }

          // 获取所有图片URL
          const imgMatches = originalContent.match(/<img[^>]+src="([^"]+)"[^>]*>/g);
          if (imgMatches) {
            imageURLs = imgMatches.map(img => {
              const match = img.match(/src="([^"]+)"/);
              return match ? match[1] : null;
            }).filter(url => url);
          }

          // 检查 elements 中的图片
          if (session.elements) {
            const imageElements = session.elements.filter(el => el.type === 'image');
            imageElements.forEach(el => {
              if ('url' in el) {
                imageURLs.push(el.url as string);
              }
            });
          }

          // 去重
          imageURLs = [...new Set(imageURLs)];

          // 生成ID
          const pendingData = readPendingFile(pendingFilePath);
          const maxId = getMaxId(data, pendingData);
          const caveId = maxId + 1;

          // 处理文本内容时简化处理
          cleanText = originalContent
            .replace(/<img[^>]+>/g, '')    // 移除img标签
            .replace(/^~cave -a\s*/, '')   // 移除命令前缀
            .trim();                       // 清理首尾空格

          // 获取用户信息
          let contributorName = session.username;
          if (ctx.database) {
            try {
              const userInfo = await ctx.database.getUser(session.platform, session.userId);
              contributorName = (userInfo as unknown as User)?.nickname || session.username;
            } catch (error) {
              logger.error(`获取用户昵称失败: ${error.message}`);
            }
          }

          // 检查内容
          if (imageURLs.length === 0 && !cleanText) {
            return '添加失败：请提供文字内容或图片';
          }

          // 创建新回声洞对象
          const elements: Element[] = [];

          // 处理文本内容
          if (cleanText) {
            elements.push({
              type: 'text',
              content: cleanText
            });
          }

          const newCave: CaveObject = {
            cave_id: caveId,
            elements,
            contributor_number: session.userId,
            contributor_name: contributorName
          };

          // 显示消息构建函数：处理文本和多张图片显示
          const buildMessage = (cave: CaveObject, imageDir: string): string => {
            let content = `回声洞 —— [${cave.cave_id}]\n`;

            for (const element of cave.elements) {
              if (element.type === 'text') {
                content += element.content + '\n';  // 直接使用文本内容
              } else if (element.type === 'img' && element.file) {
                try {
                  const fullImagePath = path.join(imageDir, element.file);
                  if (fs.existsSync(fullImagePath)) {
                    const imageBuffer = fs.readFileSync(fullImagePath);
                    const base64Image = imageBuffer.toString('base64');
                    content += h('image', { src: `data:image/png;base64,${base64Image}` }) + '\n';
                  }
                } catch (error) {
                  logger.error(`读取图片失败: ${error.message}`);
                }
              }
            }

            return content + `——${cave.contributor_name}`;
          };

          // 处理审核流程
            if (config.enableAudit) {
              const pendingCave: PendingCave = {
                ...newCave,
                groupId: session.guildId
              };

              // 保存图片（如果有）
              if (imageURLs.length > 0) {
                try {
                  const savedImages = await saveImages(imageURLs, imageDir, caveId, config, ctx);
                  for (const filename of savedImages) {
                    elements.push({
                      type: 'img',
                      file: filename
                    });
                  }
                } catch (error) {
                  return '图片保存失败，请稍后重试';
                }
              }

              pendingData.push(pendingCave);
              writePendingFile(pendingFilePath, pendingData);

              // 构建审核消息
              await sendAuditMessage(ctx, config, pendingCave, buildMessage(pendingCave, imageDir));

              return '✨ 回声洞已提交审核，请等待审核结果';
            }

          // 非审核模式处理图片
          if (imageURLs.length > 0) {
            try {
              const savedImages = await saveImages(imageURLs, imageDir, caveId, config, ctx);
              for (const filename of savedImages) {
                elements.push({
                  type: 'img',
                  file: filename
                });
              }
            } catch (error) {
              if (cleanText) {
                data.push(newCave);
                writeJsonFile(caveFilePath, data);
                return `添加成功 (部分图片保存失败), 序号为 [${caveId}]`;
              }
              return '图片保存失败，请稍后重试';
            }
          }

          // 保存数据
          data.push(newCave);
          writeJsonFile(caveFilePath, data);
          return `✨ 回声洞添加成功！编号为 [${caveId}]`;
        }

        // 显示消息构建函数：处理文本和多张图片显示
        const buildMessage = (cave: CaveObject, imageDir: string): string => {
          let content = `回声洞 —— [${cave.cave_id}]\n`;

          for (const element of cave.elements) {
            if (element.type === 'text') {
              content += element.content + '\n';  // 直接使用文本内容
            } else if (element.type === 'img' && element.file) {
              try {
                const fullImagePath = path.join(imageDir, element.file);
                if (fs.existsSync(fullImagePath)) {
                  const imageBuffer = fs.readFileSync(fullImagePath);
                  const base64Image = imageBuffer.toString('base64');
                  content += h('image', { src: `data:image/png;base64,${base64Image}` }) + '\n';
                }
              } catch (error) {
                logger.error(`读取图片失败: ${error.message}`);
              }
            }
          }

          return content + `——${cave.contributor_name}`;
        };

        // 查看指定回声洞
        if (options.g) {
          const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
          if (isNaN(caveId)) {
            return '请输入正确的回声洞编号';
          }

          const cave = data.find(item => item.cave_id === caveId);
          if (!cave) {
            return '未找到该编号的回声洞';
          }

          return buildMessage(cave, imageDir);
        }

        // 随机查看回声洞：包含群组冷却控制
        if (!options.a && !options.g && !options.r) {
          if (data.length === 0) return '暂无回声洞内容';

          // 处理冷却时间
          const guildId = session.guildId;
          const now = Date.now();
          const lastCall = lastUsed.get(guildId) || 0;

          if (now - lastCall < config.number * 1000) {
            const waitTime = Math.ceil((config.number * 1000 - (now - lastCall)) / 1000);
            return `冷却中...请${waitTime}秒后再试`;
          }

          lastUsed.set(guildId, now);
          const cave = getRandomObject(data);
          if (!cave) return '获取回声洞失败';

          return buildMessage(cave, imageDir);
        }

        // 删除回声洞：需要权限验证
        if (options.r) {
          const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
          if (isNaN(caveId)) {
            return '请输入正确的回声洞编号';
          }

          const index = data.findIndex(item => item.cave_id === caveId);
          if (index === -1) {
            return '未找到该编号的回声洞';
          }

          // 权限校验：检查是否为内容贡献者或管理员
          const cave = data[index];
          if (cave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
            return '抱歉，只有内容发布者或管理员可以删除回声洞';
          }

          // 如果是图片内容，删除对应的图片文件
          if (cave.elements) {
            try {
              for (const element of cave.elements) {
                if (element.type === 'img' && element.file) {
                  const fullPath = path.join(imageDir, element.file);
                  if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                  }
                }
              }
            } catch (error) {
              logger.error(`删除图片文件失败: ${error.message}`);
            }
          }

          data.splice(index, 1);
          writeJsonFile(caveFilePath, data);
          return `✅ 已删除回声洞 [${caveId}]`;
        }

      } catch (error) {
        // 错误处理：记录日志并返回友好提示
        logger.error(`操作失败: ${error.message}`);
        return '操作失败，请稍后重试';
      }
    });
}
