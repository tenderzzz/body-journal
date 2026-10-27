# 身体手记 · BodyJournal

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
![Platform: macOS Apple Silicon](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)

> 本地优先的个人健康 AI 助理。iPhone 随手记录，通过 iCloud 同步；Mac 保存持续更新的训练、饮食、体重腰围和生活状态档案。默认只有你点击分析或提问时才调用 AI。

当前版本 **v0.1.18**（2026-10-27）。这是一个个人项目：为个人使用而写，公开出来供参考和自用。不是商业产品，完成的是本地开发签名，没有 Apple Developer ID 公证，也不是 App Store 发行版。

![助理页面](evidence/assistant.png)

## 它解决什么问题

手机负责"随手记"，Mac 负责"连起来看"。训练、饮食、体重腰围和生活感受都先落成不可篡改的原始记录，再由本地程序做确定性统计；只有需要理解文字或照片时，才把显式组织过的上下文交给所选模型，结构化结果还要通过本地校验才允许入库。模型不直接写档案，也不直接算营养。

## 功能

- 助理、记录、趋势、我的档案四个页面；连接、数据导出和恢复设置。
- 四个快捷指令：记一餐（拍照或只记文字）、记训练、记身体、随手记。每条记录独立编号，图片随 JSON 一次保存，文字以 UTF-8 Base64 保留标点和换行。
- iCloud 完整记录自动导入、重复编号去重、缺失图片等待同步、正文与原图独立归档。
- 原始记录修改、版本历史、撤销、软删除与恢复；修改使相关旧回答与推断失效。
- 本地确定性训练统计、体重腰围趋势、饮食区间计算；7,793 条 USDA SR Legacy 食材数据及常用中文索引。
- 手动修正动作、重量、组次和食材分量；分析时最多两个追问；漏记餐食不按零摄入。
- 可编辑、有有效期的事实、近期状态与待验证判断；新会话、重启和切换模型保留同一档案。
- 官方 ChatGPT 本地个人应用授权流程（OAuth + PKCE）、模型目录、图文流式请求；可选 DeepSeek Flash、费用估计和本应用月预算。
- 动作统计口径由本地规则统一：哑铃按单只、杠铃与史密斯按报告总重、器械按标重；哑铃侧平举并入哑铃飞鸟，反向飞鸟按哑铃/杠铃/器械分开。可以手动归档动作、指定口径、删除手动归类，或软删除训练记录并在记录页恢复。
- 常用食物与补剂：蛋白粉等包装标签可长期保存（名称、品牌、每份克数与四项营养），餐食分析时由本地强制按标签计算，不再让模型每次重估；可在对话里说“记住我的补剂是……每份 30g、能量 120kcal……”自动结构化，也可在“我的档案”手动添加或修正。
- 自动记忆：首页对话与分析会自动保存明确的长期信息（偏好、条件、记法、补剂标签）与短期状态；写入必须有原话或记录原文依据，数字不得凭空出现，分析结果会在记录详情显示“分析时自动记住”，可随时在档案里修改或撤销。
- 记忆主题与检索分层：长期信息带稳定主题键（如 `communication.language`、`eating.environment`），档案按主题分组，同主题写入自动覆盖更新；聊天只带入与问题相关的记忆（实测注入从 3,789 字符降到平均 302 字符），周复盘单独 1,600 字符预算。
- 记忆整理：“我的档案”可一键整理记忆（先自动完整备份）：删除失效的自动训练参照和过期/失效的状态与判断、停用与常用食物重复的标签、合并完全重复的条目，并保留修订历史；训练参照默认只显示 8 条，可展开全部。
- 反复出现的食材不会自动写入常用食物：同一食材累计出现在至少 2 餐时，会在“我的档案 → 常用食物与补剂”显示候选卡片（出现餐数/天数、最近分量、营养来源；来自估算的会提示核对包装），点“加入常用食物”确认后才保存，也可以忽略。常用食物匹配同时看名称与品牌，避免同一产品的不同写法被拆成两条。
- 餐食引用复制：记录一餐时可以直接写“和 10 月 20 日午餐一样”，分析会从历史餐食里找到那一餐并整份复制食材与分量，再在本地重新计算营养；找不到或有多餐歧义时会追问。
- 短期记忆：对话上下文保留最近 20 条并按问题关键词检索更早的相关对话；“最近的状态”显示剩余天数并可一键续期 7 天；重复的记忆内容与同名常用食物不会被重复保存，自动偏好也不会再和常用食物重复。
- 动作按胸、背、肩、腿、核心分区显示：趋势页的动作选择器按部位分组，整理动作名称也按部位排序，并给每个动作标注所属部位。
- 可读 Markdown / JSON / 原图导出；包含修订历史的完整备份和恢复前自动备份；凭据不随备份导出。

## 动作统计口径

同一动作只保留一种计重方式，避免把“单只/总重”拆成多份统计：

| 动作类型 | 计重口径 |
| --- | --- |
| 名字含“哑铃”、交替前平举、臂屈伸 | 单只重量 |
| 名字含“杠铃/史密斯”、深蹲、窄距卧推、碎颅者、保加利亚分腿蹲 | 报告总重 |
| 器械、绳索、蝴蝶机动作 | 器械标重 |
| 卷腹、举腿、俯卧撑、引体向上等 | 自重 |

哑铃肩推默认按坐姿记录，原文明确写站姿时才保留站姿。原文在同一行明确写“总重 / 双手合计 / 总负重 / 合计重量”时保留原文总重；只写“总重”而没有点名动作的补充说明不会改动哑铃口径。历史记录在 v0.1.9 首次启动时自动重新归一化，修改前自动建立完整备份，可在“整理动作名称”里手动调整归类、计重口径或归档动作。

## 截图

| 记录 | 趋势 |
| --- | --- |
| ![记录](evidence/records.png) | ![趋势](evidence/trends.png) |

| 我的档案 | 连接与数据 |
| --- | --- |
| ![我的档案](evidence/profile.png) | ![连接与数据](evidence/settings.png) |

截图使用内置示例档案（`查看示例.command`），与真实数据隔离。

## 快速开始

### 从源码构建（macOS，Apple Silicon，Node.js 24+）

```sh
npm ci
npm test          # 50 项数据与模型契约测试，全部使用临时档案与合成数据
npm run build     # TypeScript 检查 + 生产构建
npm run package   # 打包为 release/身体手记-mac-arm64.zip
```

然后双击项目根目录的 `打开身体手记.command`，它会把打包产物解压安装到 `~/Applications/身体手记.app` 并打开。开发窗口用 `npm run dev`。

> **仓库不包含已签名的手机快捷指令。** 签名文件包含签名者的 Apple ID 签名验证记录，不适合公开分发；`release/` 目录同理不纳入版本库。要用手机入口，请先用本仓库的源文件生成并用自己的 Apple 账号签名：

```sh
python3 scripts/build-shortcuts.py
shortcuts sign --mode anyone \
  --input "shortcuts/unsigned/身体手记·随手记.shortcut" \
  --output "shortcuts/身体手记·随手记.shortcut"
# 其余三个同理：身体手记·记一餐 / 记训练 / 记身体
```

签名可能需要联网；未签名的源文件不能直接导入 iPhone。

### 首次使用

1. 打开应用，去“我的档案”检查目标和已知偏好；能量、蛋白质目标可以暂时留空。
2. 打开“连接与数据”，点 **Continue with ChatGPT**，在官方浏览器页面完成授权；回到应用选择账号可用的模型，保存设置，再点“测试图文连接”。测试只发送自带示意图。
3. 点击“建立并打开收件箱”。在 iPhone 的“文件”中打开本项目 `shortcuts` 文件夹，依次打开四个 `.shortcut` 文件。安装问题中选择 **iCloud Drive / Shortcuts / BodyJournal / inbox**。不要安装 `unsigned` 子文件夹中的源文件。
4. 先试一条“随手记”，确认快捷指令显示“已保存”，再在 Mac 查看导入结果。手机端的相机和照片权限在首次使用时由你选择。可将快捷指令添加到主屏幕。
5. 在“我的档案”补充目标和训练安排；在“记录 → 导入笔记”粘贴已有训练笔记。

详细操作见 [使用说明](docs/使用说明.html)，各版本的验收范围与已知问题见 [验证记录](docs/验证记录.md)。

## 数据位置与隐私

| 内容 | 默认位置 |
| --- | --- |
| 本地主档案 | `~/Library/Application Support/BodyJournal/vault` |
| 数据库 | 主档案中的 `health.sqlite`，运行时还有 SQLite 日志文件 |
| 不变的原文与原图 | 主档案中的 `raw`、`attachments` |
| 系统保护的模型凭据 | `~/Library/Application Support/BodyJournal/credentials.enc` |
| 手机收件箱 | `~/Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/BodyJournal/inbox` |

健康记录和凭据不存入源码目录。示例和自动测试使用独立临时档案。主数据库不放在 iCloud；iCloud 只承担收件箱同步。不要在应用运行时单独复制 SQLite 文件作为完整备份，请使用界面中的备份功能。

“本地优先”不等于完全离线：iCloud 文件经过 Apple 云服务，分析选中的原文和图片、回答需要的相关记录与个人档案会发送给当前选用的模型服务。没有后台模型调用，不会自动转到付费渠道。本地健康档案使用普通 SQLite 和文件存储，并非应用层全盘加密；模型凭据由 macOS 系统保护机制加密。

## 首版边界

- 真实 ChatGPT 账号授权、该账号实际模型额度和真实餐食识别需要你完成登录后验证；自动测试使用模拟流式响应，不使用你的真实模型额度。
- 四个快捷指令需自行签名；iPhone 的实际拍照、离线保存、跨设备同步需在你的设备上验证。
- 当前构建为 Apple Silicon 的本地开发应用，未经过 Developer ID 公证。
- Apple Health、手表自动同步、原生 iPhone App、后台主动建议不在首版范围。
- 中国食堂和外卖混合菜不具备标准配方精度；采用匹配原料和分量范围估算，无法匹配的部分单独显示。USDA 快照不是完整中式菜谱库。
- 读取上下文默认最近 35 天，含“月”的问题扩至 90 天，历史类问题读取历史，最多 160 条；界面回答需说明覆盖范围。单条分析最多 4 张照片，单张原图上限 20 MB。
- 完整备份上限 512 MB。大档案可用可读导出保存资料；首版未提供自动定时备份。
- 默认时间分组为 Asia/Shanghai。历史训练笔记只提供日期时，导入时间设为当天 12:00（+08:00），详情可改。
- 应用预算仅统计本应用发出的 DeepSeek 请求，以当前配置单价估算，不能控制你在其他应用的调用。断流的费用预留会保留为“未确认”。

## 开发与验证

需要 Node.js 24 或更高版本、npm 和 macOS。使用锁定文件安装依赖：

```sh
npm ci
npm test
npm run build
npm run test:ui   # Playwright 驱动真实 Electron 窗口的冒烟测试
npm run package
```

开发窗口：`npm run dev`。打包产物位于 `release`。Electron + React + TypeScript；SQLite 使用 Node 内置驱动。渲染层无 Node 权限，模型只处理显式组织的上下文和通过校验的结构化结果，不能直接操作文件或执行命令。

目录说明：

| 目录 | 内容 |
| --- | --- |
| `electron/core` | 导入、版本历史、日期、营养、验证与本地统计 |
| `electron/ai` | ChatGPT 授权、DeepSeek 适配、SSE 解码与推理结果解析 |
| `src/ui` | 中文界面（React 19） |
| `tests` | 50 项数据与模型契约测试 |
| `scripts` | 构建、打包、快捷指令生成、桌面冒烟测试 |
| `data` | USDA 食材快照（来源见 [data/README.md](data/README.md)） |
| `shortcuts` | 快捷指令可审查源文件（`unsigned`）与签名说明 |
| `docs` | 使用说明与逐版本验证记录 |
| `evidence` | 界面截图 |

重新生成快捷指令：`python3 scripts/build-shortcuts.py`；随后用 macOS `shortcuts sign --mode anyone --input <源文件> --output <签名文件>` 签名。签名可能需要联网，不能将未签名源文件直接导入 iPhone。

## 许可证

Copyright (C) 2026 tenderzzz。本项目以 **GNU General Public License v3.0** 发布，全文见 [LICENSE](LICENSE)。你可以自由使用、修改和分发，衍生作品必须同样以 GPL-3.0 开源并保留源代码。

`data/foods.json` 来自 USDA FoodData Central SR Legacy（公有领域 / CC0）；其中中文名称是搜索辅助翻译，不表示中国食堂菜品实测。npm 依赖遵循各自许可证。

## 免责声明

本项目不是医疗器械，不提供诊断或治疗建议，任何输出仅供参考；健康相关决定请咨询医生或专业人士。数据默认保存在本机，模型调用会把相关记录发送给你选择的服务商；请自行备份，开发者不对数据丢失、模型输出错误或由此产生的后果负责。软件按 GPL-3.0 “按现状”提供，不附带任何担保。

## 官方接口与数据依据

核对日期：2026-10-24。接口能力和资格由服务商决定。

- [OpenAI：Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [OpenAI：本地应用授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI：模型目录与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI：预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [DeepSeek：图像输入](https://api-docs.deepseek.com/guides/vision/)
- [DeepSeek：价格](https://api-docs.deepseek.com/quick_start/pricing/)
- [USDA FoodData Central](https://fdc.nal.usda.gov/api-guide/)；完整快照来源、哈希与处理过程见 [data/README.md](data/README.md)。
