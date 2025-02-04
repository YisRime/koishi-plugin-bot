import { Context, Schema } from 'koishi'

export const name = 'jrrp'

export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  ctx.command('jrrp', '查看今日人品')
    .action(({ session }) => {
      const userId = session.userId
      const date = new Date().toLocaleDateString()

      // 使用用户ID和日期生成随机数
      const seed = `${userId}-${date}`
      const hash = Array.from(seed).reduce((acc, char) => {
        return (acc * 31 + char.charCodeAt(0)) >>> 0
      }, 0)
      const rp = hash % 101 // 生成0-100的人品值

      // 根据人品值返回不同的消息
      let message = `今天你的人品值是: ${rp}\n`
      if (rp >= 90) {
        message += '今天运气超好！'
      } else if (rp >= 70) {
        message += '今天运气不错~'
      } else if (rp >= 40) {
        message += '今天运气一般般。'
      } else if (rp >= 20) {
        message += '今天运气稍差，小心点！'
      } else {
        message += '今天还是待在家里比较好...'
      }

      return message
    })
}
