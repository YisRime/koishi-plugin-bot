import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

const logger = new Logger('cave');

export const name = 'cave';


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
async function saveImages(
  url: string,
  caveDir: string,
  safeFilename: string,
  imageExtension: string,
  config: Config,
  ctx: Context
): Promise<string> {
  const targetPath = path.join(caveDir, `${safeFilename}.${imageExtension}`);

  try {
    const buffer = await ctx.http.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 10000 // 添加超时设置
    });

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
  const dataDir = path.join(ctx.baseDir, 'data');
  const assetsDir = path.join(dataDir, 'assets');
  const caveDir = path.join(assetsDir, 'cave');
  const caveFilePath = path.join(assetsDir, 'cave.json');

  [dataDir, assetsDir, caveDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(caveFilePath)) {
    fs.writeFileSync(caveFilePath, '[]', 'utf8');
  }

  const lastUsed: Map<string, number> = new Map();

  ctx.command('cave [...content]', '回声洞系统')
    .usage('cave [-a/-g/-r] [内容]\n添加回声洞：cave -a [文字/图片]\n查看回声洞：cave -g <序号>\n删除回声洞：cave -r <序号>')
    .example('cave            随机查看一条回声洞')
    .example('cave -a 内容    添加一条回声洞')
    .example('cave -g 1      查看序号为1的回声洞')
    .example('cave -r 1      删除序号为1的回声洞')
    .option('a', '添加回声洞')
    // 修改选项类型定义
    .option('g', '查看指定回声洞', { type: 'number' })
    .option('r', '删除回声洞', { type: 'number' })
    .before(async ({ session, options }) => {
      if (options.r && !config.manager.includes(session.userId)) {
        return '你没有删除回声洞的权限';
      }
    })
    .action(async ({ session, options }, ...content) => {
      const data = readJsonFile(caveFilePath);
      const inputText = content.join(' ');

      try {
        // 修改查看功能的逻辑
        if (options.g !== undefined) {
          const caveId = Number(options.g);
          // 简化验证逻辑
          if (!Number.isInteger(caveId)) {
            return '请输入有效的回声洞序号';
          }
          const cave = data.find(item => item.cave_id === caveId);
          return cave ? await displayCave(cave) : '未找到对应的回声洞序号。';
        }

        // 删除回声洞
        if (options.r) {
          if (typeof options.r !== 'string') return '请输入有效的回声洞序号';
          const caveId = parseInt(options.r);
          if (isNaN(caveId)) return '请输入有效的回声洞序号';
          const index = data.findIndex(item => item.cave_id === caveId);
          if (index === -1) return '未找到对应的回声洞序号。';
          data.splice(index, 1);
          writeJsonFile(caveFilePath, data);
          return `回声洞序号 ${caveId} 已成功删除。`;
        }

        // 添加回声洞
        if (options.a) {
          const message: MessageContent[] = [];
          const elements = h.parse(session.content);
          let isFirstText = true;

          for (const element of elements) {
            // 处理命令文本
            if (element.type === 'text' && element.attrs?.content) {
              const text = element.attrs.content.trim();
              if (!isFirstText && text) {
                message.push({ type: 'text', text });
              }
              isFirstText = false;
            }
            // 处理图片，使用简单序号作为文件名
            else if (element.type === 'img' && element.attrs?.src) {
              const caveId = Math.max(0, ...data.map(item => item.cave_id)) + 1;
              try {
                const savedPath = await saveImages(
                  element.attrs.src,
                  caveDir,
                  caveId.toString(), // 直接使用序号作为文件名
                  'png',
                  config,
                  ctx
                );
                if (savedPath) {
                  message.push({ type: 'image', path: savedPath });
                }
              } catch (error) {
                logger.error(`保存图片失败: ${error.message}`);
              }
            }
          }

          if (message.length === 0) {
            return '请输入文字或图片内容';
          }

          const caveId = Math.max(0, ...data.map(item => item.cave_id)) + 1;
          const newCave: CaveObject = {
            cave_id: caveId,
            message,
            contributor_id: session.userId
          };

          data.push(newCave);
          writeJsonFile(caveFilePath, data);
          return `添加成功, 序号为 [${caveId}]`;
        }

        // 随机查看
        if (data.length === 0) return '当前无回声洞。';

        const guildId = session.guildId;
        const now = Date.now();
        const lastCall = lastUsed.get(guildId) || 0;
        if (now - lastCall < config.number * 1000) {
          return `群回声洞调用的太频繁了, 请等待${Math.ceil((config.number * 1000 - (now - lastCall)) / 1000)}秒后再试`;
        }

        lastUsed.set(guildId, now);
        const cave = getRandomObject(data);
        if (!cave) return '获取回声洞失败';

        const messageElements = [`回声洞 —— [ ${cave.cave_id} ]\n`];

        // 处理消息内容
        for (const msg of cave.message) {
          if (msg.type === 'text' && msg.text) {
            messageElements.push(h.text(msg.text).toString());
            messageElements.push('\n');
          } else if (msg.type === 'image' && msg.path) {
            messageElements.push(h('image', { src: msg.path }).toString());
            messageElements.push('\n');
          }
        }

        messageElements.push(`—— ${cave.contributor_id}`);
        return session.send(messageElements);

      } catch (error) {
        logger.error(`执行命令出错: ${error.message}`);
        return '执行命令时发生错误，请稍后重试';
      }
    });
}

async function displayCave(cave: CaveObject): Promise<h.Fragment> {
  const messageElements = [`回声洞 —— [ ${cave.cave_id} ]\n`];

  // 处理消息内容
  for (const msg of cave.message) {
    if (msg.type === 'text' && msg.text) {
      messageElements.push('\n');
      messageElements.push(h.text(msg.text).toString());
      messageElements.push('\n');
    } else if (msg.type === 'image' && msg.path) {
      messageElements.push('\n');
      messageElements.push(h('image', { src: msg.path }).toString());
      messageElements.push('\n');
    }
  }

  messageElements.push(`—— ${cave.contributor_id}`);
  return h('message', null, ...messageElements);
}

