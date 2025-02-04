import { Context, Schema } from 'koishi'
import { initCavePaths, handleCaveAction } from './cave'
import { Config as CaveConfig } from './cave'  // 新增导入 Config 接口

export * from './cave';
export * from './jrrp';

// 基础定义
export const name = 'cave';
export const inject = ['database'];

// 配置Schema
export const Config: Schema<CaveConfig> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员账号'),
  number: Schema.number().default(60).description('群内调用冷却时间（秒）'),
  enableAudit: Schema.boolean().default(false).description('是否开启审核功能'),
});

// 插件主函数：初始化和命令注册
export async function apply(ctx: Context, config: CaveConfig) {
  const { caveFilePath, imageDir, pendingFilePath } = await initCavePaths(ctx);
  // 群组冷却时间管理
  const lastUsed: Map<string, number> = new Map();

  // 命令处理主函数
  ctx.command('cave', '回声洞')
    .usage('支持添加、抽取、查看、查询回声洞')
    .example('cave           随机抽取回声洞')
    .example('cave -a 内容   添加新回声洞')
    .example('cave -g/r x      查看/删除指定回声洞')
    .example('cave -p/d x/all  通过/拒绝待审回声洞')
    .example('cave -l x      查询投稿者投稿列表')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    // 仅对 -l、-p 和 -d 指令进行权限检查
    .before(async ({ session, options }) => {
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return '只有管理员才能执行此操作';
      }
    })
    .action(async ({ session, options }, ...content) => {
      return await handleCaveAction(ctx, config, session, options, content, lastUsed);
    });
}
