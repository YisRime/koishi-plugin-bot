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

// 处理QQ图片链接
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

// 添加处理特殊字符的函数
function processSpecialChars(text: string): string {
  return text
    .replace(/\\n/g, '\n')       // 处理换行符
    .replace(/\\t/g, '\t')       // 处理制表符
    .replace(/\\r/g, '\r')       // 处理回车符
    .replace(/\\\\/g, '\\')      // 处理反斜杠
    .replace(/\\"/g, '"')        // 处理引号
    .replace(/\\'/g, "'")        // 处理单引号
    .replace(/&lt;/g, '<')       // 处理HTML转义字符
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

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
      const filename = `cave_${caveId}_${i + 1}.png`;
      const targetPath = path.join(imageDir, filename);
      const processedUrl = processQQImageUrl(urls[i]);

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

// 读取JSON数据文件：验证并返回回声洞数据数组
function readJsonFile(filePath: string): CaveObject[] {
  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 如果文件不存在，创建空数组文件
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf8');
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    // 验证数据格式
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(item =>
      item &&
      typeof item.cave_id === 'number' &&
      typeof item.text === 'string' &&
      typeof item.contributor_number === 'string' &&
      typeof item.contributor_name === 'string'
    );
  } catch (error) {
    logger.error(`读取文件出错: ${error.message}`);
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
      typeof item.text === 'string' &&
      typeof item.contributor_number === 'string' &&
      typeof item.contributor_name === 'string'
    );
    fs.writeFileSync(filePath, JSON.stringify(validData, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`写入文件出错: ${error.message}`);
  }
}

// 修改随机获取一条回声洞数据的逻辑
function getRandomObject(data: CaveObject[]): CaveObject | undefined {
  if (!data || !data.length) return undefined;
  const validCaves = data.filter(cave => cave.text || (cave.images && cave.images.length > 0));
  if (!validCaves.length) return undefined;
  const randomIndex = Math.floor(Math.random() * validCaves.length);
  return validCaves[randomIndex];
}

// 修改回声洞数据结构定义
interface CaveObject {
  cave_id: number;
  text: string;
  images?: string[];
  contributor_number: string;
  contributor_name: string;
}

// 添加待审核回声洞接口
interface PendingCave extends CaveObject {
  groupId?: string;        // 来源群号
  timestamp: number;       // 提交时间
}

// 添加待审核数据读写函数
function readPendingFile(filePath: string): PendingCave[] {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf8');
      return [];
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    logger.error(`读取待审核文件失败: ${error.message}`);
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

// 插件主函数：提供回声洞的添加、查看、删除和随机功能
export async function apply(ctx: Context, config: Config) {
  // 初始化目录结构和文件
  const dataDir = path.join(ctx.baseDir, 'data');         // 数据根目录
  const caveDir = path.join(dataDir, 'cave');             // 回声洞目录
  const caveFilePath = path.join(caveDir, 'cave.json');   // 数据文件
  const imageDir = path.join(caveDir, 'images');          // 图片目录
  const pendingFilePath = path.join(caveDir, 'pending.json');  // 待审核数据文件

  // 创建必要目录
  [dataDir, caveDir, imageDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  // 初始化数据文件
  if (!fs.existsSync(caveFilePath)) {
    fs.writeFileSync(caveFilePath, '[]', 'utf8');
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
    .example('cave -pa       一键通过所有待审核回声洞')
    .example('cave -da       一键拒绝所有待审核回声洞')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('pa', '一键通过所有待审核')
    .option('da', '一键拒绝所有待审核')

    // 权限检查：管理员权限
    .before(async ({ session, options }) => {
      if ((options.r || options.p || options.d || options.pa || options.da)
          && !config.manager.includes(session.userId)) {
        return '抱歉，只有管理员才能执行此操作';
      }
    })

    // 命令处理函数
    .action(async ({ session, options }, ...content) => {
      const data = readJsonFile(caveFilePath);

      try {
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
          let caveId = 1;
          while (data.some(item => item.cave_id === caveId)) {
            caveId++;
          }

          // 处理文本内容时增加转义字符处理
          cleanText = originalContent
            .replace(/<img[^>]+>/g, '')    // 移除所有img标签
            .replace(/^~cave -a\s*/, '')   // 移除命令前缀
            .replace(/\s+/g, ' ')          // 规范化空格
            .trim();
          cleanText = processSpecialChars(cleanText);  // 处理特殊字符

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
          const newCave: CaveObject = {
            cave_id: caveId,
            text: cleanText,
            contributor_number: session.userId,
            contributor_name: contributorName
          };

          // 处理审核流程
          if (config.enableAudit) {
            const pendingData = readPendingFile(pendingFilePath);
            const pendingCave: PendingCave = {
              ...newCave,
              groupId: session.guildId,
              timestamp: Date.now()
            };

            // 保存图片（如果有）
            if (imageURLs.length > 0) {
              try {
                const savedImages = await saveImages(imageURLs, imageDir, caveId, config, ctx);
                if (savedImages.length > 0) {
                  pendingCave.images = savedImages;
                }
              } catch (error) {
                return '图片保存失败，请稍后重试';
              }
            }

            pendingData.push(pendingCave);
            writePendingFile(pendingFilePath, pendingData);

            // 发送审核通知给主人
            const auditMessage = `📝 新回声洞待审核 #${caveId}\n`
              + `内容：${pendingCave.text}\n`
              + `来自：${pendingCave.contributor_name}\n`
              + `群组：${pendingCave.groupId || '私聊'}\n`
              + `处理方式：\n`
              + `同意 ${caveId} - 通过审核\n`
              + `拒绝 ${caveId} - 拒绝通过`;

            ctx.bots[0]?.sendPrivateMessage(config.manager[0], auditMessage);
            return '✨ 回声洞已提交审核，请等待审核结果';
          }

          // 保存图片（如果有）
          if (imageURLs.length > 0) {
            try {
              const savedImages = await saveImages(imageURLs, imageDir, caveId, config, ctx);
              if (savedImages.length > 0) {
                newCave.images = savedImages;
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
        const buildMessage = (cave: CaveObject) => {
          let content = cave.text || '';
          content = processSpecialChars(content);  // 处理特殊字符

          if (cave.images && cave.images.length > 0) {
            try {
              for (const imagePath of cave.images) {
                const fullImagePath = path.join(imageDir, imagePath);
                if (fs.existsSync(fullImagePath)) {
                  const imageBuffer = fs.readFileSync(fullImagePath);
                  const base64Image = imageBuffer.toString('base64');
                  content += `\n${h('image', { src: `data:image/png;base64,${base64Image}` })}`;
                }
              }
            } catch (error) {
              logger.error(`读取图片失败: ${error.message}`);
            }
          }
          return `📝 回声洞 #${cave.cave_id}\n${content}\n——${cave.contributor_name}`;
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

          return buildMessage(cave);
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

          return buildMessage(cave);
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
          if (cave.images) {
            try {
              for (const imagePath of cave.images) {
                const fullPath = path.join(imageDir, imagePath);
                if (fs.existsSync(fullPath)) {
                  fs.unlinkSync(fullPath);
                }
              }
            } catch (error) {
              logger.error(`删除图片文件失败: ${error.message}`);
            }
          }

          data.splice(index, 1);
          writeJsonFile(caveFilePath, data);
          return `✅ 已删除 #${caveId} 号回声洞`;
        }

        // 处理一键通过所有待审核
        if (options.pa) {
          const pendingData = readPendingFile(pendingFilePath);
          if (pendingData.length === 0) return '没有待审核的回声洞';

          const data = readJsonFile(caveFilePath);
          for (const cave of pendingData) {
            data.push(cave);
            if (cave.groupId) {
              await ctx.bots[0]?.sendMessage(cave.groupId, `✅ 回声洞 #${cave.cave_id} 已通过审核`);
            }
          }

          writeJsonFile(caveFilePath, data);
          writePendingFile(pendingFilePath, []);
          return `✅ 已通过全部 ${pendingData.length} 条待审核回声洞`;
        }

        // 处理一键拒绝所有待审核
        if (options.da) {
          const pendingData = readPendingFile(pendingFilePath);
          if (pendingData.length === 0) return '没有待审核的回声洞';

          for (const cave of pendingData) {
            // 删除图片
            if (cave.images) {
              for (const imagePath of cave.images) {
                const fullPath = path.join(imageDir, imagePath);
                if (fs.existsSync(fullPath)) {
                  fs.unlinkSync(fullPath);
                }
              }
            }
            if (cave.groupId) {
              await ctx.bots[0]?.sendMessage(cave.groupId, `❌ 回声洞 #${cave.cave_id} 未通过审核`);
            }
          }

          writePendingFile(pendingFilePath, []);
          return `❌ 已拒绝全部 ${pendingData.length} 条待审核回声洞`;
        }

        // 处理通过单条审核
        if (options.p) {
          const id = parseInt(content[0] || (typeof options.p === 'string' ? options.p : ''));
          if (isNaN(id)) return '请输入正确的回声洞编号';

          const pendingData = readPendingFile(pendingFilePath);
          const pendingIndex = pendingData.findIndex(item => item.cave_id === id);
          if (pendingIndex === -1) return '未找到该待审核回声洞';

          const cave = pendingData[pendingIndex];
          const data = readJsonFile(caveFilePath);
          data.push(cave);
          writeJsonFile(caveFilePath, data);

          pendingData.splice(pendingIndex, 1);
          writePendingFile(pendingFilePath, pendingData);

          if (cave.groupId) {
            await ctx.bots[0]?.sendMessage(cave.groupId, `✅ 回声洞 #${id} 已通过审核`);
          }
          return '审核通过成功';
        }

        // 处理拒绝单条审核
        if (options.d) {
          const id = parseInt(content[0] || (typeof options.d === 'string' ? options.d : ''));
          if (isNaN(id)) return '请输入正确的回声洞编号';

          const pendingData = readPendingFile(pendingFilePath);
          const pendingIndex = pendingData.findIndex(item => item.cave_id === id);
          if (pendingIndex === -1) return '未找到该待审核回声洞';

          const cave = pendingData[pendingIndex];
          if (cave.images) {
            for (const imagePath of cave.images) {
              const fullPath = path.join(imageDir, imagePath);
              if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
              }
            }
          }

          pendingData.splice(pendingIndex, 1);
          writePendingFile(pendingFilePath, pendingData);

          if (cave.groupId) {
            await ctx.bots[0]?.sendMessage(cave.groupId, `❌ 回声洞 #${id} 未通过审核`);
          }
          return '已拒绝该回声洞';
        }

      } catch (error) {
        // 错误处理：记录日志并返回友好提示
        logger.error(`操作失败: ${error.message}`);
        return '操作失败，请稍后重试';
      }
    });
}

