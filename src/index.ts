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
  nameinfo?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒'),
  nameinfo: Schema.boolean().default(false).description('是否显示用户名')
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
      typeof item.contributor_id === 'string' &&
      typeof item.state === 'number'
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
      typeof item.contributor_id === 'string' &&
      typeof item.state === 'number'
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
  state: number;
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
  ctx.command('cave [text]', '回声洞')
    .example('cave')
    .example('cave -a')
    .example('cave -g <id>')
    .example('cave -r <id>')
    .option('a', '-a 添加回声洞')
    .option('r', '-r 删除回声洞')
    .option('g', '-g 查看某个序号的回声洞')
    .action(async ({ session, options }, inputText) => {
      const caveFilePath = path.join(ctx.baseDir, 'data', 'assets', 'cave.json');
      const caveDir = path.join(ctx.baseDir, 'data', 'assets', 'cave');
      const data = readJsonFile(caveFilePath);

      // 随机获取或指定获取回声洞的统一处理函数
      async function displayCave(cave: CaveObject) {
        if (!cave.message || !Array.isArray(cave.message)) {
          return '回声洞数据格式错误';
        }

        let username = cave.contributor_id;
        if (config.nameinfo) {
          try {
            const user = await ctx.bots[0]?.getUser(cave.contributor_id);
            username = user?.name || cave.contributor_id;
          } catch (error) {
            logger.warn(`获取用户名失败: ${error}`);
          }
        }

        const messageContent = cave.message
          .filter(msg => msg && (msg.type === 'text' || msg.type === 'image'))
          .map(msg => {
            if (msg.type === 'text' && msg.text) return msg.text;
            if (msg.type === 'image' && msg.path) return h('image', { src: msg.path });
            return '';
          })
          .filter(Boolean)
          .join('\n');

        if (!messageContent) {
          return '回声洞内容为空';
        }

        return `回声洞 —— [${cave.cave_id}]\n${messageContent}\n—— ${username}`;
      }

      if (options.g || !options.a) {
        if (data.length === 0) {
          return '当前无回声洞。';
        }

        // 处理冷却时间
        if (!options.g) {
          const guildId = session.guildId;
          const lastCall = lastUsed.get(guildId) || 0;
          const now = Date.now();
          const diff = now - lastCall;

          if (diff < config.number * 1000) {
            const timeLeft = Math.ceil((config.number * 1000 - diff) / 1000);
            return `群回声洞调用的太频繁了, 请等待${timeLeft}秒后再试`;
          }
          lastUsed.set(guildId, now);
        }

        const cave = options.g ?
          data.find(item => item.cave_id === Number(inputText)) :
          getRandomObject(data);

        if (!cave) {
          return options.g ? '未找到对应的回声洞序号。' : '获取回声洞失败';
        }

        return await displayCave(cave);
      }

      if (options.a) {
        const message: MessageContent[] = [];

        // 处理引用消息的情况
        if (session.quote) {
          let sessionContent = session.quote.content;
          const textContents: string[] = [];
          const imgSrcs: string[] = [];

          h.parse(sessionContent).forEach(element => {
            if (element.type === 'text' && element.attrs?.text) {
              textContents.push(element.attrs.text);
            } else if (element.type === 'image' && element.attrs?.src) {
              imgSrcs.push(element.attrs.src);
            }
          });

          // 处理引用消息中的文字内容
          if (textContents.length > 0) {
            message.push({
              type: 'text',
              text: textContents.join(' ')
            });
          }

          // 处理引用消息中的图片内容
          if (imgSrcs.length > 0) {
            for (const imgSrc of imgSrcs) {
              try {
                const savedPath = await saveImages(imgSrc, caveDir, `cave_${data.length + 1}`, 'png', config, ctx);
                if (savedPath) {
                  message.push({
                    type: 'image',
                    path: savedPath
                  });
                }
              } catch (error) {
                logger.error(`保存图片失败: ${error.message}`);
              }
            }
          }
        } else {
          // 处理直接输入的内容
          const commandContent = session.content.replace(/^cave\s+-a\s*/, '').trim();
          if (!commandContent) {
            return '请输入要添加的内容';
          }

          // 解析命令后面的内容
          for (const element of h.parse(commandContent)) {
            if (element.type === 'text' && element.attrs?.text) {
              message.push({
                type: 'text',
                text: element.attrs.text.trim()
              });
            } else if (element.type === 'image' && element.attrs?.src) {
              const imgSrc = element.attrs.src;
              try {
                const savedPath = await saveImages(imgSrc, caveDir, `cave_${data.length + 1}`, 'png', config, ctx);
                if (savedPath) {
                  message.push({
                    type: 'image',
                    path: savedPath
                  });
                }
              } catch (error) {
                logger.error(`保存图片失败: ${error.message}`);
              }
            }
          }
        }

        if (message.length === 0) {
          return '请输入有效的文字或图片内容';
        }

        let caveId = 1;
        while (data.some(item => item.cave_id === caveId)) {
          caveId++;
        }

        const newCave: CaveObject = {
          cave_id: caveId,
          message: message.map(msg => ({
            type: msg.type,
            ...(msg.type === 'text' ? { text: msg.text } : { path: msg.path })
          })),
          contributor_id: session.userId,
          state: 1
        };

        // 验证新数据格式
        if (newCave.message.length === 0 ||
            !newCave.message.every(msg =>
              (msg.type === 'text' && typeof msg.text === 'string') ||
              (msg.type === 'image' && typeof msg.path === 'string')
            )) {
          return '数据格式错误，请重试';
        }

        data.push(newCave);
        writeJsonFile(caveFilePath, data);
        return `添加成功, 序号为 [${caveId}]`;
      }

      if (options.r) {
        const caveId = Number(inputText);
        const index = data.findIndex(item => item.cave_id === caveId);
        if (index === -1) return '未找到对应的回声洞序号。';
        data.splice(index, 1);
        writeJsonFile(caveFilePath, data);
        return `回声洞序号 ${caveId} 已成功删除。`;
      }

      // 修改显示逻辑，添加空值检查
      if (options.g || !options.a) {
        const cave = options.g ?
          data.find(item => item.cave_id === Number(inputText)) :
          getRandomObject(data);

        if (!cave) return options.g ? '未找到对应的回声洞序号。' : '获取回声洞失败';
        if (!cave.message || !Array.isArray(cave.message)) {
          return '回声洞数据格式错误';
        }

        let username = cave.contributor_id;
        if (config.nameinfo) {
          try {
            const user = await ctx.bots[0]?.getUser(cave.contributor_id);
            username = user?.name || cave.contributor_id;
          } catch (error) {
            logger.warn(`获取用户名失败: ${error}`);
          }
        }

        // 确保 message 数组中的每个元素都是有效的
        const messageContent = cave.message
          .filter(msg => msg && (msg.type === 'text' || msg.type === 'image'))
          .map(msg => {
            if (msg.type === 'text' && msg.text) return msg.text;
            if (msg.type === 'image' && msg.path) return h('image', { src: msg.path });
            return '';
          })
          .filter(Boolean)
          .join('\n');

        if (!messageContent) {
          return '回声洞内容为空';
        }

        return `回声洞 —— [${cave.cave_id}]\n${messageContent}\n—— ${username}`;
      }

      if (data.length === 0) {
        return '当前无回声洞。';
      }

      const guildId = session.guildId;
      const lastCall = lastUsed.get(guildId) || 0;
      const now = Date.now();
      const diff = now - lastCall;

      if (diff < config.number * 1000) {
        const timeLeft = Math.ceil((config.number * 1000 - diff) / 1000);
        return `群回声洞调用的太频繁了, 请等待${timeLeft}秒后再试`;
      }

      lastUsed.set(guildId, now);
      const randomObject = getRandomObject(data);

      // 修改这部分逻辑，增加空值检查
      if (!randomObject) {
        return '获取回声洞失败';
      }

      const { cave_id, message, contributor_id } = randomObject;

      let username = contributor_id;
      if (config.nameinfo) {
        try {
          const user = await ctx.bots[0].getUser(contributor_id);
          username = user.name;
        } catch (error) {
          logger.warn(`获取用户名失败: ${error}`);
        }
      }

      // 格式化消息内容
      const messageContent = message
        .filter(msg => msg && (msg.type === 'text' || msg.type === 'image'))
        .map(msg => {
          if (msg.type === 'text' && msg.text) return msg.text;
          if (msg.type === 'image' && msg.path) return h('image', { src: msg.path });
          return '';
        })
        .filter(Boolean)
        .join('\n');

      if (!messageContent) {
        return '回声洞内容为空';
      }

      return `回声洞 —— [${cave_id}]\n${messageContent}\n—— ${username}`;
    });
}
