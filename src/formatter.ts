/**
 * DDNet 玩家信息格式化模块
 */

/**
 * 格式化玩家信息
 * @param data DDNet API 返回的玩家数据
 * @returns 格式化后的字符串
 */
export function formatPlayerInfo(data: any): string {
  const playerName = data.player
  let result = `🏆 ${playerName} 的 DDNet 信息\n\n`;

  // 合并显示排名和分数信息
  result += `📊 排名与分数\n`;

  // 总分信息
  if (data.points && typeof data.points === 'object') {
    const total = data.points.total || 0;
    const rank = data.points.rank || '未排名';
    const points = data.points.points || 0;
    result += `• 总分: ${points}/${total} (全球第 ${rank} 名)\n`;
  }

  // 个人与团队排名合并显示
  if (data.rank && typeof data.rank === 'object') {
    result += `• 个人排名: 第 ${data.rank.rank || '?'} 名 (${data.rank.points || 0} 分)\n`;
  }

  if (data.team_rank && typeof data.team_rank === 'object') {
    result += `• 团队排名: 第 ${data.team_rank.rank || '?'} 名 (${data.team_rank.points || 0} 分)\n`;
  }

  // 最近时间段成绩合并显示
  if (data.points_last_year || data.points_last_month || data.points_last_week) {
    result += `\n📅 最近活跃度\n`;

    if (data.points_last_year && data.points_last_year.points) {
      result += `• 过去一年: ${data.points_last_year.points} 分 (第 ${data.points_last_year.rank || '?'} 名)\n`;
    }

    if (data.points_last_month && data.points_last_month.points) {
      result += `• 过去一月: ${data.points_last_month.points} 分 (第 ${data.points_last_month.rank || '?'} 名)\n`;
    }

    if (data.points_last_week && data.points_last_week.rank) {
      result += `• 过去一周: ${data.points_last_week.points || 0} 分 (第 ${data.points_last_week.rank} 名)\n`;
    } else {
      result += `• 过去一周: 暂无排名\n`;
    }
  }

  // 首次完成和常用服务器
  result += `\n🎮 游戏信息\n`;

  if (data.favorite_server) {
    const server = typeof data.favorite_server === 'object' ?
                  (data.favorite_server.server || JSON.stringify(data.favorite_server)) :
                  data.favorite_server;
    result += `• 常用服务器: ${server}\n`;
  }

  if (data.hours_played_past_365_days !== undefined) {
    result += `• 年度游戏时间: ${data.hours_played_past_365_days} 小时\n`;
  }

  if (data.first_finish) {
    const date = new Date(data.first_finish.timestamp * 1000);
    const formattedDate = `${date.getFullYear()}年${(date.getMonth()+1)}月${date.getDate()}日`;
    const map = data.first_finish.map;
    const mins = Math.floor(data.first_finish.time / 60);
    const secs = Math.floor(data.first_finish.time % 60);
    const ms = Math.round((data.first_finish.time - Math.floor(data.first_finish.time)) * 1000);

    result += `• 首次完成: ${formattedDate} ${map} (${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')})\n`;
  }

  // 地图完成详细统计 - 显示所有地图类型的详细信息
  if (data.types && typeof data.types === 'object') {
    result += `\n🗺️ 地图类型统计\n`;
    const typesEntries = Object.entries(data.types);

    if (typesEntries.length > 0) {
      typesEntries.forEach(([typeName, typeInfo]: [string, any]) => {
        if (typeInfo) {
          // 获取类型的点数和排名信息
          let typePoints = 0;
          let typeRank = '未排名';
          let mapCount = 0;

          if (typeInfo.points) {
            if (typeof typeInfo.points === 'object') {
              typePoints = typeInfo.points.points || typeInfo.points.total || 0;
            } else {
              typePoints = typeInfo.points;
            }
          }

          if (typeInfo.rank && typeInfo.rank.rank) {
            typeRank = `第 ${typeInfo.rank.rank} 名`;
          }

          // 地图数量和列表
          if (typeInfo.maps) {
            mapCount = Object.keys(typeInfo.maps).length;
            result += `• ${typeName}: ${typePoints} 分 (${typeRank}), 完成 ${mapCount} 张地图\n`;

            // 如果有地图就列出一些地图名称(不超过15个,防止太长)
            if (mapCount > 0) {
              const mapNames: string[] = Object.keys(typeInfo.maps).slice(0, 15);
              result += `  包括: ${mapNames.join(', ')}${mapCount > 15 ? ' 等...' : ''}\n`;
            }
          }
        }
      });
    }
  }

  // 最近完成的地图 - 显示全部
  if (data.last_finishes && Array.isArray(data.last_finishes) && data.last_finishes.length > 0) {
    result += `\n🏁 最近完成记录 (${data.last_finishes.length}项)\n`;

    data.last_finishes.forEach((finish: any) => {
      if (finish.timestamp && finish.map) {
        const date = new Date(finish.timestamp * 1000);
        const formattedDate = `${date.getFullYear()}/${(date.getMonth()+1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
        const mins = Math.floor(finish.time / 60);
        const secs = Math.floor(finish.time % 60);
        const ms = Math.round((finish.time - Math.floor(finish.time)) * 1000);

        result += `• ${finish.map} (${finish.country || ''} ${finish.type || ''}) - ${formattedDate} - ${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}\n`;
      }
    });
  }

  // 最常合作的伙伴 - 显示全部
  if (data.favorite_partners && Array.isArray(data.favorite_partners) && data.favorite_partners.length > 0) {
    result += `\n👥 常用队友 (${data.favorite_partners.length}位)\n`;
    data.favorite_partners.forEach((partner: any) => {
      if (partner.name && partner.finishes) {
        result += `• ${partner.name}: ${partner.finishes} 次合作\n`;
      }
    });
  }

  // 活跃度信息 - 如果有就显示统计数据
  if (data.activity && Array.isArray(data.activity) && data.activity.length > 0) {
    // 计算统计数据
    let totalHours = 0;
    let maxHours = 0;
    let activeDays = 0;
    let activeMonths = new Set();

    data.activity.forEach((day: any) => {
      if (day && day.hours_played) {
        totalHours += day.hours_played;
        maxHours = Math.max(maxHours, day.hours_played);

        if (day.hours_played > 0) {
          activeDays++;
          if (day.date) {
            // 提取年月 (YYYY-MM)
            const month = day.date.substring(0, 7);
            activeMonths.add(month);
          }
        }
      }
    });

    const avgHoursPerActiveDay = activeDays > 0 ? (totalHours / activeDays).toFixed(1) : "0";

    result += `\n📊 活跃度统计\n`;
    result += `• 活跃天数: ${activeDays} 天\n`;
    result += `• 活跃月数: ${activeMonths.size} 个月\n`;
    result += `• 单日最长游戏: ${maxHours} 小时\n`;
    result += `• 平均每日游戏: ${avgHoursPerActiveDay} 小时\n`;
  }

  return result;
}

/**
 * 格式化时间（将秒转换为 分:秒.毫秒 格式）
 * @param seconds 秒数
 * @returns 格式化后的时间字符串
 */
export function formatTime(seconds: number): string {
  if (typeof seconds !== 'number') return '未知时间'

  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000)

  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

/**
 * 格式化日期（将时间戳转换为本地日期字符串）
 * @param timestamp Unix 时间戳（秒）
 * @returns 格式化后的日期字符串
 */
export function formatDate(timestamp: number): string {
  if (!timestamp) return '未知时间'

  try {
    const date = new Date(timestamp * 1000)
    return date.toLocaleString('zh-CN')
  } catch (e) {
    return '日期格式错误'
  }
}
