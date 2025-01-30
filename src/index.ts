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
  consoleinfo?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒'),
  consoleinfo: Schema.boolean().default(false).description('是否在控制台输出信息')
});

async function saveImages(url: string, selectedPath: string, safeFilename: string, imageExtension: string, config: Config, ctx: Context): Promise<string> {
  let fileRoot = path.join(selectedPath, safeFilename);
  let fileExt = `.${imageExtension}`;
  let targetPath = `${fileRoot}${fileExt}`;
  let index = 0;

  if (config.consoleinfo) {
    logger.info('提取到的图片链接：' + url);
  }

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

function readJsonFile(filePath: string): any[] {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`读取文件出错: ${error.message}`);
  }
}

function writeJsonFile(filePath: string, data: any[]): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`写入文件出错: ${error.message}`);
  }
}

export async function apply(ctx: Context, config: Config) {
  const caveFilePath = path.join(ctx.baseDir, 'data', 'cave.json');
  const assetsDir = path.join(ctx.baseDir, 'assets', 'cave');
  await ensureDirExists(assetsDir);
  const lastUsed: Map<string, number> = new Map();

  async function ensureFileExists(filePath: string) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf-8');
    }
  }

  async function ensureDirExists(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  await ensureFileExists(caveFilePath);

  ctx.command('cave [text]', '回声洞')
    .example('cave')
    .example('cave -a')
    .example('cave -g <id>')
    .example('cave -r <id>')
    .option('a', '-a 添加回声洞')
    .option('r', '-r 删除回声洞')
    .option('g', '-g 查看某个序号的回声洞')
    .action(async ({ session, options }, text) => {
      const data = readJsonFile(caveFilePath);

      if (options.a) {
        let quote = session.quote;
        let imageURL: string;
        let sessioncontent: string = session.content;

        imageURL = h.select(sessioncontent, 'img').map(a => a.attrs.src)[0];
        if (!imageURL && !quote) {
          return '请输入图片或引用回复一条消息';
        }

        let elements = quote?.elements;
        let textContents = [];
        let imgSrcs = [];
        let message = [];

        if (elements) {
          elements.forEach(element => {
            if (element.type === 'text') {
              textContents.push(element.attrs.content);
            } else if (element.type === 'img') {
              imgSrcs.push(element.attrs.src);
            }
          });

          let textMessage = {
            type: 'text',
            text: textContents.join(' ')
          };
          if (textContents.length > 0) {
            message.push(textMessage);
          }
          imageURL = imgSrcs[0];
        } else if (imageURL) {
          let quotemessage: string | h[];
          quotemessage = session.quote?.content ?? imageURL;
          imageURL = h.select(quotemessage, 'img').map(a => a.attrs.src)[0];
        }

        let imagePath = '';
        if (imageURL) {
          imagePath = await saveImages(imageURL, assetsDir, `${Date.now()}`, 'png', config, ctx);
        }

        let caveId = 1;
        while (data.some(item => item.cave_id === caveId)) {
          caveId++;
        }

        const newCave = { cave_id: caveId, text: imagePath || text, contributor_id: session.userId, state: 1 };
        data.push(newCave);
        writeJsonFile(caveFilePath, data);
        return `添加成功, 序号为 [${caveId}]`;
      }

      if (options.r) {
        const caveId = Number(text);
        const index = data.findIndex(item => item.cave_id === caveId);
        if (index === -1) return '未找到对应的回声洞序号。';
        data.splice(index, 1);
        writeJsonFile(caveFilePath, data);
        return `回声洞序号 ${caveId} 已成功删除。`;
      }

      if (options.g) {
        const caveId = Number(text);
        if (isNaN(caveId)) return '请输入有效的回声洞序号。';
        const cave = data.find(item => item.cave_id === caveId);
        if (!cave) return '未找到对应的回声洞序号。';
        if (cave.text.startsWith('http')) {
          return `回声洞 —— [${cave.cave_id}]\n${h('image', { src: cave.text })}\n—— ${cave.contributor_id}`;
        }
        return `回声洞 —— [${cave.cave_id}]\n${cave.text}\n—— ${cave.contributor_id}`;
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
      const randomCave = data[Math.floor(Math.random() * data.length)];
      if (randomCave.text.startsWith('http')) {
        return `回声洞 —— [${randomCave.cave_id}]\n${h('image', { src: randomCave.text })}\n—— ${randomCave.contributor_id}`;
      }
      return `回声洞 —— [${randomCave.cave_id}]\n${randomCave.text}\n—— ${randomCave.contributor_id}`;
    });
}
