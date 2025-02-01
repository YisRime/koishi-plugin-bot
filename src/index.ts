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
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒'),
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

// 随机获取一条回声洞数据
function getRandomObject(data: CaveObject[]): CaveObject | undefined {
  if (!data || !data.length) return undefined;
  // 过滤出有效的回声洞（至少包含文本或图片的记录）
  const validCaves = data.filter(cave => cave.text || cave.images);
  if (!validCaves.length) return undefined;
  const randomIndex = Math.floor(Math.random() * validCaves.length);
  return validCaves[randomIndex];
}

// 修改回声洞数据结构定义
interface CaveObject {
  cave_id: number;
  text: string;
  images?: string[];         // 修改为图片路径数组
  contributor_number: string;
  contributor_name: string;
}

// 插件主函数：提供回声洞的添加、查看、删除和随机功能
export async function apply(ctx: Context, config: Config) {
  // 初始化目录结构和文件
  const dataDir = path.join(ctx.baseDir, 'data');         // 数据根目录
  const caveDir = path.join(dataDir, 'cave');             // 回声洞目录
  const caveFilePath = path.join(caveDir, 'cave.json');   // 数据文件
  const imageDir = path.join(caveDir, 'images');          // 图片目录

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
    .usage('cave [-a/-g/-r] [内容]')
    .example('cave           随机查看回声洞')
    .example('cave -a x      添加内容为x的回声洞')
    .example('cave -g 1      查看序号为1的回声洞')
    .example('cave -r 1      删除序号为1的回声洞')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })

    // 权限检查：删除操作需要管理员权限
    .before(async ({ session, options }) => {
      if (options.r && !config.manager.includes(session.userId)) {
        return '你没有删除回声洞的权限';
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

          // 处理文本内容
          cleanText = originalContent
            .replace(/<img[^>]+>/g, '')    // 移除所有img标签
            .replace(/^~cave -a\s*/, '')   // 移除命令前缀
            .replace(/\s+/g, ' ')          // 规范化空格
            .trim();

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
            return '请输入图片或文字';
          }

          // 创建新回声洞对象
          const newCave: CaveObject = {
            cave_id: caveId,
            text: cleanText,
            contributor_number: session.userId,
            contributor_name: contributorName
          };

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
          return `添加成功, 序号为 [${caveId}]`;
        }

        // 显示消息构建函数：处理文本和多张图片显示
        const buildMessage = (cave: CaveObject) => {
          let content = cave.text;
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
          return `回声洞 —— [${cave.cave_id}]\n${content}\n—— ${cave.contributor_name}`;
        };

        // 查看指定回声洞
        if (options.g) {
          const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
          if (isNaN(caveId)) {
            return '请输入有效的回声洞序号。';
          }

          const cave = data.find(item => item.cave_id === caveId);
          if (!cave) {
            return '未找到对应的回声洞序号。';
          }

          return buildMessage(cave);
        }

        // 随机查看回声洞：包含群组冷却控制
        if (!options.a && !options.g && !options.r) {
          if (data.length === 0) return '当前无回声洞。';

          // 处理冷却时间
          const guildId = session.guildId;
          const now = Date.now();
          const lastCall = lastUsed.get(guildId) || 0;

          if (now - lastCall < config.number * 1000) {
            return `群回声洞调用的太频繁了, 请等待${Math.ceil((config.number * 1000 - (now - lastCall)) / 1000)}秒后再试`;
          }

          lastUsed.set(guildId, now);
          const cave = getRandomObject(data);
          if (!cave) return '获取回声洞失败';
          if (!cave.text) return '回声洞内容为空';

          return buildMessage(cave);
        }

        // 删除回声洞：需要权限验证
        if (options.r) {
          const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
          if (isNaN(caveId)) {
            return '请输入有效的回声洞序号。';
          }

          const index = data.findIndex(item => item.cave_id === caveId);
          if (index === -1) {
            return '未找到对应的回声洞序号。';
          }

          // 权限校验：检查是否为内容贡献者或管理员
          const cave = data[index];
          if (cave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
            return '你没有权限删除该回声洞。只有内容贡献者或管理员可以删除。';
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
          return `回声洞序号 ${caveId} 已成功删除。`;
        }

      } catch (error) {
        // 错误处理：记录日志并返回友好提示
        logger.error(`执行命令出错: ${error.message}`);
        return '执行命令时发生错误，请稍后重试';
      }
    });
}

