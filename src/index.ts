import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

const logger = new Logger('cave');

export const name = 'cave';

// 修改 using 声明
export const using = [] as const;

export interface User {
  userId: string;
  username: string;
}

export interface getStrangerInfo {
  user_id: string;
  nickname: string;
}

export interface Config {
  manager: string[];
  number: number;
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒'),
});

// 修改 saveImages 函数，简化路径处理
async function saveImages(url: string, caveDir: string, safeFilename: string, imageExtension: string, config: Config, ctx: Context): Promise<string> {
  let fileRoot = path.join(caveDir, safeFilename);
  let fileExt = `.${imageExtension}`;
  let targetPath = `${fileRoot}${fileExt}`;
  let index = 0;

  while (fs.existsSync(targetPath)) {
    index++;
    targetPath = `${fileRoot}_${index}${fileExt}`;
  }

  try {
    const buffer = await ctx.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
    if (buffer.byteLength === 0) throw new Error('下载的数据为空');
    await fs.promises.writeFile(targetPath, Buffer.from(buffer));
    return targetPath;
  } catch (error) {
    logger.info('保存图片时出错： ' + error.message);
    throw error;
  }
}

// 更新 readJsonFile 函数，指定返回类型
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
      Array.isArray(item.message) &&
      typeof item.contributor_id === 'string'
    );
  } catch (error) {
    logger.error(`读取文件出错: ${error.message}`);
    return [];
  }
}

// 修改 writeJsonFile 函数，指定参数类型
function writeJsonFile(filePath: string, data: CaveObject[]): void {
  try {
    // 数据格式验证
    const validData = data.filter(item =>
      item &&
      typeof item.cave_id === 'number' &&
      Array.isArray(item.message) &&
      typeof item.contributor_id === 'string'
    );
    fs.writeFileSync(filePath, JSON.stringify(validData, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`写入文件出错: ${error.message}`);
  }
}

// 修改 getRandomObject 函数，指定类型
function getRandomObject(data: CaveObject[]): CaveObject | undefined {
  if (!data.length) return undefined;
  const randomIndex = Math.floor(Math.random() * data.length);
  return data[randomIndex];
}

// 添加新的接口定义
interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  path?: string;
}

interface CaveObject {
  cave_id: number;
  message: MessageContent[];
  contributor_id: string;
}

// 插件入口函数，用于初始化并绑定指令
export async function apply(ctx: Context, config: Config) {
  // 简化初始化逻辑
  const dataDir = path.join(ctx.baseDir, 'data');
  const assetsDir = path.join(dataDir, 'assets');
  const caveDir = path.join(assetsDir, 'cave');
  const caveFilePath = path.join(assetsDir, 'cave.json');

  // 创建所需的目录结构
  [dataDir, assetsDir, caveDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // 确保 cave.json 文件存在
  if (!fs.existsSync(caveFilePath)) {
    fs.writeFileSync(caveFilePath, '[]', 'utf8');
  }

  const lastUsed: Map<string, number> = new Map();

  async function ensureFileExists(filePath: string) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf-8');
    }
  }

  // 注册命令
  ctx.command('cave [...content]', '回声洞系统')
    .usage('cave [-a/-g/-r] [内容]\n添加回声洞：cave -a [文字/图片]\n查看回声洞：cave -g <序号>\n删除回声洞：cave -r <序号>')
    .example('cave            随机查看一条回声洞')
    .example('cave -a 内容    添加一条回声洞')
    .example('cave -g 1      查看序号为1的回声洞')
    .example('cave -r 1      删除序号为1的回声洞')
    .option('a', '添加回声洞')
    .option('g', '查看指定回声洞', { type: 'number', fallback: 0 })
    .option('r', '删除回声洞', { type: 'number' })
    .before(async ({ session, options }) => {
      if (options.r && !config.manager.includes(session.userId)) {
        return '你没有删除回声洞的权限';
      }
    })
    .action(async ({ session, options }, ...content) => {
      const caveFilePath = path.join(ctx.baseDir, 'data', 'assets', 'cave.json');
      const caveDir = path.join(ctx.baseDir, 'data', 'assets', 'cave');
      const data = readJsonFile(caveFilePath);

      try {
        // 添加功能
        if (options.a) {
          let quote = session.quote;
          let imageURL: string;
          let sessioncontent: string = session.content;

          imageURL = h.select(sessioncontent, 'img').map(a => a.attrs.src)[0];

          if (!imageURL && !quote) {
            return '请输入图片或引用回复一条消息';
          }

          const message = [];

          // 处理引用消息
          if (quote) {
            const elements = h.parse(quote.content);
            if (elements) {
              const textContents = [];
              const imgSrcs = [];

              for (const element of elements) {
                if (element.type === 'text' && element.attrs?.text) {
                  textContents.push(element.attrs.text);
                } else if (element.type === 'image' && element.attrs?.src) {
                  imgSrcs.push(element.attrs.src);
                }
              }

              if (textContents.length > 0) {
                message.push({
                  type: 'text',
                  text: textContents.join(' ')
                });
              }

              if (imgSrcs.length > 0) {
                imageURL = imgSrcs[0];
              }
            }
          }

          // 处理图片
          if (imageURL) {
            try {
              const savedPath = await saveImages(imageURL, caveDir, `cave_${data.length + 1}`, 'png', config, ctx);
              if (!savedPath) {
                return '保存失败,请稍后重试';
              }
              message.push({
                type: 'image',
                path: savedPath
              });
            } catch (error) {
              logger.error(`保存图片失败: ${error.message}`);
              return '图片保存失败，请稍后重试';
            }
          }

          if (message.length === 0) {
            return '请不要引用合并转发,视频,语音等\n或消息在bot重启之前发送,无法寻找上下文';
          }

          let caveId = 1;
          while (data.some(item => item.cave_id === caveId)) {
            caveId++;
          }

          const contributor_id = quote?.user?.userId ?? session.userId;

          const newCave: CaveObject = {
            cave_id: caveId,
            message,
            contributor_id,
          };

          data.push(newCave);
          writeJsonFile(caveFilePath, data);

          return `添加成功, 序号为 [${caveId}]\n提交者: ${contributor_id}`;
        }

        // 查看功能
        if (typeof options.g === 'number') {
          const cave = data.find(item => item.cave_id === Number(options.g));
          if (!cave) return '未找到对应的回声洞序号。';
          return await displayCave(cave);
        }

        // 删除功能
        if (options.r !== undefined) {
          const index = data.findIndex(item => item.cave_id === Number(options.r));
          if (index === -1) return '未找到对应的回声洞序号。';
          data.splice(index, 1);
          writeJsonFile(caveFilePath, data);
          return `回声洞序号 ${options.r} 已成功删除。`;
        }

        // 随机查看功能（默认）
        if (!options.g && !options.r) {
          // 处理冷却时间
          const guildId = session.guildId;
          const lastCall = lastUsed.get(guildId) || 0;
          const now = Date.now();
          const diff = now - lastCall;

          if (diff < config.number * 1000) {
            const timeLeft = Math.ceil((config.number * 1000 - diff) / 1000);
            return `群回声洞调用的太频繁了, 请等待${timeLeft}秒后再试`;
          }

          lastUsed.set(guildId, now);
          const cave = getRandomObject(data);
          if (!cave) return '获取回声洞失败';
          return await displayCave(cave);
        }

      } catch (error) {
        logger.error(`执行命令出错: ${error.message}`);
        return '执行命令时发生错误，请稍后重试';
      }
    });
}

// 添加Unicode转换函数
function convertUnicodeText(text: string): string {
  if (!text) return '';

  // 检查是否包含Unicode字符
  if (text.includes('\\u')) {
    const codePoints = text.split('\\u')
      .filter(Boolean)
      .map(hex => {
        const codePoint = parseInt(hex, 16);
        return isNaN(codePoint) ? '' : String.fromCodePoint(codePoint);
      });
    return codePoints.join('');
  }

  // 如果不是Unicode，尝试解析JSON格式
  try {
    return JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
  } catch {
    return text;
  }
}

async function displayCave(cave: CaveObject): Promise<h.Fragment> {
  const messageElements = [
    `回声洞 —— [ ${cave.cave_id} ]`,
    '\n'
  ];

  // 先处理文字内容
  const texts = cave.message
    .filter(msg => msg.type === 'text' && msg.text)
    .map(msg => convertUnicodeText(msg.text))
    .filter(Boolean);

  // 处理图片内容
  const images = cave.message
    .filter(msg => msg.type === 'image' && msg.path)
    .map(msg => msg.path);

  // 根据内容类型组织显示
  if (texts.length === 0 && images.length > 0) {
    // 只有图片
    messageElements.push('\n');
    images.forEach(path => {
      messageElements.push(
        h('image', { src: path.startsWith('/') || path.startsWith('http') ? path : `file:///${path}` }) as unknown as string
      );
    });
  } else if (texts.length > 0) {
    // 有文字（可能有图片）
    messageElements.push('\n\n');
    messageElements.push(h.text(texts.join('\n')).toString());

    // 如果同时有图片
    if (images.length > 0) {
      messageElements.push('\n\n');
      images.forEach(path => {
        messageElements.push(
          h('image', { src: path.startsWith('/') || path.startsWith('http') ? path : `file:///${path}` }) as unknown as string
        );
      });
    }
  }

  // 添加署名
  messageElements.push('\n');
  messageElements.push(`—— ${cave.contributor_id}`);

  return h('message', null, ...messageElements);
}

