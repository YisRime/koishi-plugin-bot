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
  nameinfo?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒'),
  nameinfo: Schema.boolean().default(false).description('是否显示用户名')
});

// 保存图片至指定目录并返回保存后的文件路径
async function saveImages(url: string, selectedPath: string, safeFilename: string, imageExtension: string, config: Config, ctx: Context): Promise<string> {
  let fileRoot = path.join(selectedPath, safeFilename);
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

// 更新 readJsonFile 函数
function readJsonFile(filePath: string): any[] {
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
    return JSON.parse(data);
  } catch (error) {
    logger.error(`读取文件出错: ${error.message}`);
    return [];
  }
}

// 将对象数组写入到 JSON 文件
function writeJsonFile(filePath: string, data: any[]): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`写入文件出错: ${error.message}`);
  }
}

// 从对象数组中随机选择一个对象
function getRandomObject(data: any[]): any {
  const randomIndex = Math.floor(Math.random() * data.length);
  return data[randomIndex];
}

// 定义 destructureAndPrint 函数
function destructureAndPrint(message: any): string {
  // 根据实际需求实现函数逻辑
  return message.toString();
}

// 插件入口函数，用于初始化并绑定指令
export async function apply(ctx: Context, config: Config) {
  // 确保基础目录结构存在
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
    .action(async ({ session, options }, inputText) => {
      // 根据不同子命令执行相应逻辑
      const data = readJsonFile(caveFilePath);

      if (options.a) {
        // 处理添加回声洞
        let imageURL: string;
        let sessioncontent: string = session.content;

        imageURL = h.select(sessioncontent, 'img').map(a => a.attrs.src)[0];
        if (!imageURL && !inputText) {
          return '请输入图片或文字';
        }

        let caveId = 1;
        while (data.some(item => item.cave_id === caveId)) {
          caveId++;
        }

        let imagePath = '';
        if (imageURL) {
          imagePath = await saveImages(imageURL, assetsDir, `cave_${caveId}`, 'png', config, ctx);
        }

        const newCave = { cave_id: caveId, text: imagePath || inputText, contributor_id: session.userId, state: 1 };
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

      if (options.g) {
        const caveId = Number(inputText);
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
      const randomObject = getRandomObject(data);

      // 修改这部分逻辑，增加空值检查
      if (!randomObject) {
        return '获取回声洞失败';
      }

      const { cave_id, text, contributor_id } = randomObject;

      let username = contributor_id;
      if (config.nameinfo) {
        try {
          const user = await ctx.bots[0].getUser(contributor_id);
          username = user.name;
        } catch (error) {
          logger.warn(`获取用户名失败: ${error}`);
        }
      }

      // 根据text的类型来决定如何显示内容
      if (!text) {
        return '回声洞内容为空';
      }

      // 如果是图片路径
      if (text.startsWith('/') || text.startsWith('http')) {
        const messageElements = [
          `回声洞 —— [ ${cave_id} ]`,
          `\n`,
          h('image', { src: text }),
          `—— ${username}`
        ];
        return session.send(messageElements);
      }

      // 如果是文字内容
      const messageElements = [
        `回声洞 —— [ ${cave_id} ]`,
        `\n\n`,
        h.text(text),
        '\n\n',
        `—— ${username}`
      ];
      return session.send(messageElements);
    });
}
