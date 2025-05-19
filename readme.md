# koishi-plugin-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bot)

自动切换频道受理人（再也不需要逐个 `assign` 了），同时支持多机器人负载均衡功能

## 功能介绍

- **自动切换受理人**：当机器人离线时，自动将其负责的频道转移给其他在线机器人
- **负载均衡**：支持定时轮换频道或轮换机器人两种策略，均衡多机器人负载
- **灵活配置**：可指定启用的平台，并配置不参与自动切换的例外频道

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|-------|------|-------|------|
| switchMode | 'manual' \| number | 5 | 受理人切换模式。'manual'表示手动，数字表示延迟多少秒后切换 |
| initSwitch | boolean | false | 插件初始化时是否自动切换不可用的受理人 |
| enabledPlatforms | string[] | ['onebot'] | 启用的平台列表，留空表示所有平台 |
| showChannelDetails | boolean | false | 是否在日志中显示详细频道ID信息 |
| balanceMode | 'manual' \| number | 'manual' | 负载均衡模式。'manual'表示禁用，数字表示多少秒执行一次均衡 |
| balanceStrategy | 'channels' \| 'bots' | 'channels' | 负载均衡策略。'channels'表示随机分配频道，'bots'表示整体切换机器人 |
| excludeChannels | string[] | [] | 不参与自动切换和负载均衡的频道列表 |

## 使用场景

### 自动切换受理人

当某个受理人机器人离线时，插件会自动将其负责的频道转移给该平台下其他在线的机器人，确保服务不中断。

- 可配置切换延迟，防止机器人短时间内频繁上下线导致的频繁切换
- 支持初始化时检查并切换不可用受理人

### 负载均衡

支持两种负载均衡策略：

- **轮换频道策略**：将频道随机打乱并均匀分配给不同机器人，适合多机器人分担负载
- **轮换机器人策略**：定期切换使用的机器人，所有频道同时使用同一个机器人，适合备用机轮替

## 注意事项

- 例外频道格式支持 `平台:频道ID` 或直接使用 `频道ID`
- 轮换机器人策略会导致所有频道同时切换受理人，可能造成短时负载波动
