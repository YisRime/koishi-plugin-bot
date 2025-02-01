import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

// 初始化日志记录器
const logger = new Logger('cave');

// 插件名称
export const name = 'cave';

// 插件依赖声明
export const inject = ['database'];

// 用户信息接口
export interface User {
  userId: string;
  username: string;
  nickname?: string;
}

// 获取陌生人信息接口
export interface getStrangerInfo {
  user_id: string;
  nickname: string;
}

// 插件配置接口
export interface Config {
  manager: string[];
  number: number;
}

// 插件配置Schema
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒'),
});

/**
 * 保存图片文件
 * @param url 图片URL
 * @param imageDir 图片保存目录
 * @param caveId 回声洞ID
 * @param imageExtension 图片扩展名
 * @param config 插件配置
 * @param ctx Koishi上下文
 * @returns 保存后的文件名
 */
async function saveImages(
  url: string,
  imageDir: string,  // 改为直接使用 imageDir
  caveId: number,
  imageExtension: string,
  config: Config,
  ctx: Context
): Promise<string> {
  const filename = `cave_${caveId}.${imageExtension}`;
  const targetPath = path.join(imageDir, filename);  // 使用 imageDir
  try {
    const buffer = await ctx.http.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 10000 // 添加超时设置
    });
    if (buffer.byteLength === 0) throw new Error('下载的数据为空');
    await fs.promises.writeFile(targetPath, Buffer.from(buffer));
    return filename;  // 只返回文件名
  } catch (error) {
    logger.info('保存图片时出错： ' + error.message);
    throw error;
  }
}

/**
 * 读取JSON数据文件
 * @param filePath 文件路径
 * @returns 回声洞数据数组
 */
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

/**
 * 写入JSON数据文件
 * @param filePath 文件路径
 * @param data 回声洞数据数组
 */
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

/**
 * 获取随机回声洞对象
 * @param data 回声洞数据数组
 * @returns 随机选择的回声洞对象
 */
function getRandomObject(data: CaveObject[]): CaveObject | undefined {
  if (!data.length) return undefined;
  const randomIndex = Math.floor(Math.random() * data.length);
  return data[randomIndex];
}

/**
 * 回声洞数据对象接口
 */
interface CaveObject {
  cave_id: number;          // 回声洞ID
  text: string;             // 文本内容
  image_path?: string;      // 本地图片路径
  image_url?: string;       // 备用网络图片URL
  contributor_number: string;// 贡献者ID
  contributor_name: string; // 贡献者昵称
}

/**
 * 插件主函数
 * 功能：
 * 1. 初始化目录和文件
 * 2. 提供添加回声洞功能
 * 3. 提供查看回声洞功能
 * 4. 提供删除回声洞功能
 * 5. 提供随机查看功能
 *
 * 命令：
 * - cave        随机查看回声洞
 * - cave -a     添加回声洞
 * - cave -g     查看指定回声洞
 * - cave -r     删除回声洞（需要权限）
 */
export async function apply(ctx: Context, config: Config) {
  /**
   * 1. 初始化目录结构
   */
  const dataDir = path.join(ctx.baseDir, 'data');        // 基础数据目录
  const caveDir = path.join(dataDir, 'cave');            // 回声洞专用目录
  const caveFilePath = path.join(caveDir, 'cave.json');  // 回声洞数据文件
  const imageDir = path.join(caveDir, 'images');         // 图片存储目录

  // 确保所有必要目录存在
  [dataDir, caveDir, imageDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  // 确保数据文件存在
  if (!fs.existsSync(caveFilePath)) {
    fs.writeFileSync(caveFilePath, '[]', 'utf8');
  }

  /**
   * 2. 初始化群组冷却时间Map
   * - key: 群组ID
   * - value: 上次使用时间戳
   */
  const lastUsed: Map<string, number> = new Map();

  /**
   * 3. 注册命令
   */
  ctx.command('cave', '回声洞')
    // 设置命令帮助信息
    .usage('cave [-a/-g/-r] [内容]')
    .example('cave           随机查看回声洞')
    .example('cave -a x      添加内容为x的回声洞')
    .example('cave -g 1      查看序号为1的回声洞')
    .example('cave -r 1      删除序号为1的回声洞')
    // 注册命令选项
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })

    /**
     * 4. 权限预检查
     * - 检查删除操作的权限
     * - 仅管理员可执行删除操作
     */
    .before(async ({ session, options }) => {
      if (options.r && !config.manager.includes(session.userId)) {
        return '你没有删除回声洞的权限';
      }
    })

    /**
     * 5. 命令处理函数
     */
    .action(async ({ session, options }, ...content) => {
      const data = readJsonFile(caveFilePath);
      const inputText = content.join(' ');

      try {
        /**
         * 5.1 添加功能 (-a)
         * - 支持文字内容
         * - 支持图片内容
         * - 支持图文混合内容
         * - 获取用户昵称
         * - 保存图片到本地
         * - 生成唯一ID
         * - 写入数据文件
         */
        if (options.a) {
          // 清理输入文本中的图片标签
          const cleanText = content.join(' ').replace(/<img[^>]+>/g, '').trim();

          // 收集所有图片URL
          let imageURL = null;

          // 从img标签中获取URL
          const imgMatch = session.content.match(/<img[^>]+src="([^"]+)"[^>]*>/);
          if (imgMatch) {
            imageURL = imgMatch[1];
          }

          // 从elements中获取URL（优先级更高）
          if (session.elements) {
            const imageElement = session.elements.find(el => el.type === 'image');
            if (imageElement && 'url' in imageElement) {
              imageURL = imageElement.url;
            }
          }

          // 检查是否有有效内容
          if (!imageURL && !cleanText) {
            return '请输入图片或文字';
          }

          let caveId = 1;
          while (data.some(item => item.cave_id === caveId)) {
            caveId++;
          }

          // 获取用户昵称
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
            text: cleanText,
            contributor_number: session.userId,
            contributor_name: contributorName
          };

          // 保存图片
          if (imageURL) {
            try {
              const filename = await saveImages(imageURL, imageDir, caveId, 'png', config, ctx);
              newCave.image_path = filename;
            } catch (error) {
              logger.error(`保存图片失败: ${error.message}`);
              return '图片保存失败，请稍后重试';
            }
          }

          data.push(newCave);
          writeJsonFile(caveFilePath, data);
          return `添加成功, 序号为 [${caveId}]`;
        }

        /**
         * 5.2 查看功能 (-g)
         * - 验证序号有效性
         * - 查找对应回声洞
         * - 处理文本显示
         * - 处理图片显示（转base64）
         * - 显示贡献者信息
         */
        const buildMessage = (cave: CaveObject) => {
          let content = cave.text;
          if (cave.image_path) {
            try {
              const imagePath = path.join(imageDir, cave.image_path);
              if (fs.existsSync(imagePath)) {
                const imageBuffer = fs.readFileSync(imagePath);
                const base64Image = imageBuffer.toString('base64');
                content += `\n${h('image', { src: `data:image/png;base64,${base64Image}` })}`;
              } else {
                logger.error(`找不到图片文件: ${imagePath}`);
              }
            } catch (error) {
              logger.error(`读取图片失败: ${error.message}`);
            }
          }
          return `回声洞 —— [${cave.cave_id}]\n${content}\n—— ${cave.contributor_name}`;
        };

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

        /**
         * 5.3 随机查看功能（默认）
         * - 检查群组冷却时间
         * - 随机选择回声洞
         * - 处理文本显示
         * - 处理图片显示（转base64）
         * - 显示贡献者信息
         * - 更新冷却时间
         */
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

        /**
         * 5.4 删除功能 (-r)
         * - 验证序号有效性
         * - 权限验证（贡献者或管理员）
         * - 删除图片文件（如果有）
         * - 从数据文件中移除
         * - 保存更新后的数据
         */
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
          if (cave.image_path) {
            try {
              const imagePath = path.join(imageDir, cave.image_path);
              if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
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
        /**
         * 5.5 错误处理
         * - 记录错误日志
         * - 返回友好的错误消息
         */
        logger.error(`执行命令出错: ${error.message}`);
        return '执行命令时发生错误，请稍后重试';
      }
    });
}

