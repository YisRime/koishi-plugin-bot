import { Context, Schema, h } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

export const name = 'luobot'

export interface Config {
  manager: string[];
  number: number;
}

export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员QQ，一个项目填一个ID'),
  number: Schema.number().default(3).description('群单位回声洞冷却时间,单位为秒')
})

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

  async function saveImage(url: string, dirPath: string): Promise<string> {
    const safeFilename = `${Date.now()}`;
    const imageExtension = 'png';
    let fileRoot = path.join(dirPath, safeFilename);
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
      console.error('保存图片时出错：', error.message);
      throw error;
    }
  }

  await ensureFileExists(caveFilePath);

  ctx.command('cave [text]', '回声洞')
    .option('a', '-a 添加回声洞')
    .option('r', '-r 删除回声洞')
    .option('g', '-g 查看某个序号的回声洞')
    .action(async ({ session, options }, text) => {
      const data = JSON.parse(fs.readFileSync(caveFilePath, 'utf8'));

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
          imagePath = await saveImage(imageURL, assetsDir);
        }

        let caveId = 1;
        while (data.some(item => item.cave_id === caveId)) {
          caveId++;
        }

        const newCave = { cave_id: caveId, text: imagePath || text, contributor_id: session.userId, state: 1 };
        data.push(newCave);
        fs.writeFileSync(caveFilePath, JSON.stringify(data, null, 2), 'utf8');
        return `添加成功, 序号为 [${caveId}]`;
      }

      if (options.r) {
        const caveId = Number(text);
        const index = data.findIndex(item => item.cave_id === caveId);
        if (index === -1) return '未找到对应的回声洞序号。';
        data.splice(index, 1);
        fs.writeFileSync(caveFilePath, JSON.stringify(data, null, 2), 'utf8');
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
