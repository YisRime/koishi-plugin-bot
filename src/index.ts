import { Context, Schema, h } from 'koishi';
// npm publish --workspace koishi-plugin-asmr-lizard --access public --registry https://registry.npmjs.org
import { } from 'koishi-plugin-ffmpeg';
export const name = 'asmr-lizard';
export const inject = ['ffmpeg'];
export interface Config { }
export const Config = Schema.object({});
export const usage = `
- 获取以下类型的助眠音频：钢琴、雨声、脑波、自然

- 还有睡前故事哦~

- 如果是比较长的音频会分段发送~
---
<details>
<summary>如果要反馈建议或报告问题</summary>

可以[点这里](https://github.com/lizard0126/asmr-lizard/issues)创建议题~
</details>
<details>
<summary>如果喜欢我的插件</summary>

可以[请我喝可乐](https://ifdian.net/a/lizard0126)，没准就有动力更新新功能了~
</details>
`;

const apis = {
  '钢琴': 'https://www.hhlqilongzhu.cn/api/ximalaya/ximalaya_gangqin.php',
  '雨声': 'https://www.hhlqilongzhu.cn/api/ximalaya/ximalaya_rain.php',
  '脑波': 'https://www.hhlqilongzhu.cn/api/ximalaya/ximalaya_naobo.php',
  '自然': 'https://www.hhlqilongzhu.cn/api/ximalaya/ximalaya_daziran.php',
  '故事': 'https://www.hhlqilongzhu.cn/api/ximalaya/ximalaya_gushi.php',
};

export function apply(ctx: Context) {
  ctx.command('助眠 [type]', '获取助眠音频，包括小故事')
    .action(async ({ session }, type) => {
      if (!type) {
        return '提供以下类型：钢琴、雨声、脑波、自然、故事，输入随机则随机获取。';
      }

      if (type === '随机') {
        const keys = Object.keys(apis);
        type = keys[Math.floor(Math.random() * keys.length)];
      }

      const apiUrl = apis[type];
      if (!apiUrl) {
        return '提供以下类型：钢琴、雨声、脑波、自然、故事，输入随机则随机获取。';
      }

      try {
        const response = await ctx.http.get(apiUrl);
        const { title, cover, url } = response;

        const audioData = await ctx.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(audioData);

        const durationBuffer = await ctx.ffmpeg.builder()
          .input(buffer)
          .outputOption('-f', 'null')
          .run('info');

        const durationOutput = durationBuffer.toString();
        const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(durationOutput);
        const duration = match ? (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3])) : 0;

        const coverResponse = await ctx.http.get(cover);
        await session.send(`${title}\n${h.image(coverResponse)}`);

        const maxSegmentDuration = 5 * 60;
        const [tipMessageId] = await session.send('正在获取音频，请耐心等待');
        if (duration <= maxSegmentDuration) {
          await session.send(h.audio(buffer, 'audio/mp3'));
          await session.bot.deleteMessage(session.channelId, tipMessageId);
        } else {
          const segmentCount = Math.ceil(duration / maxSegmentDuration);
          await session.send(`音频时长大于5分钟，将分${segmentCount}段发送。`);

          for (let i = 0; i < segmentCount; i++) {
            const startTime = i * maxSegmentDuration;

            const segmentBuffer = await ctx.ffmpeg.builder()
              .input(buffer)
              .inputOption('-ss', startTime.toString())
              .outputOption('-t', maxSegmentDuration.toString(), '-f', 'mp3')
              .run('buffer');

            const maxRetries = 3; // 最大重试次数
            let attempts = 0;
            let sent = false;

            while (attempts < maxRetries && !sent) {
              try {
                await session.send(h.audio(segmentBuffer, 'audio/mp3'));
                sent = true;
              } catch (error) {
                attempts++;
                await session.send(`发送第 ${i + 1} 段音频失败，正在重试...（尝试次数: ${attempts}）`);
                if (attempts === maxRetries) {
                  await session.send(`第 ${i + 1} 段音频发送失败。`);
                }
              }
            }
          }
          await session.bot.deleteMessage(session.channelId, tipMessageId);
        }
      } catch (error) {
        ctx.logger.error('请求失败', error.message);
        return '请求过程中出现错误，请稍后重试。';
      }
    });
}
