# 开发与发布

本页描述仓库中实际提供的开发入口。首次使用与下载入口见 [README](../README.md)，能量模型见 [能量估算说明](能量估算说明.md)，既往验收范围见 [验证记录](验证记录.md)。

## 环境与启动

- macOS Apple Silicon（arm64），当前打包脚本固定生成此架构。
- Node.js 24 或更高版本与 npm；SQLite 使用 Node 内置的 `node:sqlite`。
- 打包需要 Xcode 命令行工具，脚本会调用 `codesign` 与 `ditto`。
- 安装依赖、首次下载 Electron 以及连接模型时需要网络。查看本地记录和运行合成数据测试不需要模型账号。

```sh
git clone https://github.com/tenderzzz/body-journal.git
cd body-journal
npm ci
HEALTH_DEMO=1 npm run dev
```

示例模式将档案和应用配置放在系统临时目录，与正式档案隔离。启动前先退出已打开的身体手记，避免单实例机制把焦点转到原窗口。`npm run dev` 会构建主进程与预加载脚本、启动 Vite，再启动 Electron；界面改动由开发服务器处理，主进程与预加载脚本改动后需要重新启动此命令。

**不带 `HEALTH_DEMO=1` 的启动使用正式档案。** 若要从空档案验证持久化、迁移或导入流程，可显式指定一个独立目录：

```sh
HEALTH_TEST_VAULT="$(mktemp -d /tmp/bodyjournal-dev.XXXXXX)" npm run dev
```

此目录用于本次启动的档案与应用配置，收件箱位于其中；退出后仍保留，方便检查。请自行记录并清理该目录，不要指向正式档案或 iCloud 收件箱。

## 数据与模型怎样配合

```text
iPhone 快捷指令 ── iCloud 收件箱 ─┐
Mac 录入／历史笔记导入 ──────────┤
                                ▼
                     导入校验 → 原文／原图归档
                                ▼
                     SQLite 记录、修订、档案
                         │              │
                         ▼              ▼
                    本地统计计算     用户点击分析／提问
                         │              ▼
                         │        选取相关上下文 → 模型
                         │              ▼
                         └──── 本地校验与计算 → 界面
```

- **确定性部分**：记录去重、日期与单位校验、训练解析、食材营养计算、能量区间、修订失效与备份恢复由本地代码处理。原文与原图归档保留，后续修改有修订历史。
- **模型部分**：理解用户选中的文字和图片、提取结构化信息、回答问题。请求使用应用显式组织的上下文；模型不能直接操作数据库、执行命令或读写任意文件。
- **落库边界**：结构化结果须经过本地校验，分析时的记录版本必须仍有效；营养汇总由本地代码根据食材目录、已确认标签或明确标注来源的估计参数计算，估计值与未匹配项保留区分。目标调整草案需要用户明确采纳。
- **活动计算**：v0.5.0 在本地按当天非训练步数相对平常参考的变化修正日常消耗。参考顺序为用户手填、此前28天中至少7个有效完整日的中位数、活动档位暂定范围；新资料将参考与活动系数固定成快照，滚动历史仅提供更新建议。跑步步数与训练热量分别扣重，实际步数优先于步频推导，部分覆盖或冲突数据不能冒充完整一天。
- **桌面边界**：React 渲染层通过预加载脚本中列出的操作调用主进程；窗口开启 `contextIsolation`、关闭 `nodeIntegration`、开启 `sandbox`，主进程同时检查调用来源。

## 目录

| 路径 | 职责 |
| --- | --- |
| `electron/main.ts`、`electron/preload.ts` | 桌面窗口、凭据存储、IPC 与系统交互 |
| `electron/core/` | 导入、SQLite、修订、备份、解析、营养和能量服务 |
| `electron/ai/` | 授权、模型请求、流式响应解析与上下文组织 |
| `src/shared/` | 两端共用的类型、计算和规则 |
| `src/ui/` | 助理、记录、能量、趋势与档案等界面 |
| `tests/` | 数据、计算规则、IPC 与模型响应契约测试 |
| `scripts/` | 开发启动、构建、打包、截图验证与数据生成 |
| `data/` | USDA 食材快照；来源与重建方式见 [数据说明](../data/README.md) |
| `shortcuts/unsigned/` | 可审查的快捷指令源文件 |
| `evidence/` | 使用示例档案生成的界面截图 |

## 构建与验证

```sh
npm test                 # Node 数据与模型契约测试
npm run build            # 类型检查、Vite 界面构建、主进程与预加载脚本打包
npm run test:ui          # 真实 Electron 窗口中的主要记录流程
npm run test:energy-ui   # 能量设置、目标、完整性、重启与受限窗口验证
npm run test:activity-ui # 活动字段更正、App 热量口径、步数修正与重复处理
npm run test:nutrition-ui # 原始单位、剩饭与本餐营养更正
npm run test:v05-ui       # 记忆依据、旧回答失效与本地评测
npm run test:steps-ui    # 自动参考、步频扣除、核对状态、历史日期与重启
```

界面测试前须先完成 `npm run build`。它们使用独立临时档案和合成数据，不验证真实账号授权、模型额度、餐食识别质量或手机实机同步。通用与能量测试会写入 `evidence/` 截图；活动与步数测试向系统临时目录写入截图。单元与契约测试通过也不代表个体能量估算已被实测验证。

`npm start` 启动已构建的桌面应用，不会先构建。需要验证打包应用时，界面脚本支持 `BODYJOURNAL_APP` 指向应用的可执行文件：

```sh
BODYJOURNAL_APP="/实际位置/身体手记.app/Contents/MacOS/BodyJournal" npm run test:ui
```

其余三个界面脚本也支持相同的 `BODYJOURNAL_APP` 参数。此方式验证实际打包应用，仍使用脚本创建的独立档案。

## 格式兼容与计算版本

v0.5.0 的数据库与完整备份格式为 **v4**，可恢复 v1、v2、v3 和 v4 完整备份；四个手机快捷指令的记录格式继续使用 v1。数据库从 v1、v2 或 v3 升级前会建立完整备份，恢复档案前也会备份当前内容。备份与本地原图均属于敏感数据，不应加入版本库。

能量方法标识位于 `src/shared/energy.ts`，新资料为 `mifflin-compendium2024-fixed-steps-v5`；升级前历史资料保留 v4。它与数据库格式版本独立：计算方法或引用来源改变时，旧回答与目标草案需要按依赖重新判定有效性，不能仅凭数据库无需迁移就继续使用旧结果。活动核对已保存和估算信息完整是两个状态，可选信息缺失不应抹掉已保存的确认。

验证迁移时请使用旧版合成备份，不要从真实档案抽样。兼容测试至少检查记录、原图、修订、手动活动更正、目标历史和备份往返；历史计算只允许引用所选日期及之前的有效依据。

## 本地打包

```sh
npm run package
```

该命令先运行完整构建，再生成 `release/身体手记-mac-arm64.zip`，并在 `release/build.json` 记录版本与构建位置。应用使用 ad-hoc 签名，打包脚本会执行签名验证；没有 Apple Developer ID 公证。

项目根目录的 `打开身体手记.command` 与 `查看示例.command` 会在需要时把本地压缩包解压到 `~/Applications/身体手记.app`，替换该位置的旧应用。前者打开正式档案，后者打开示例档案。它们查找的是中文文件名的本地构建包，与 Release 下载资产的英文文件名不同。

**对外分发请使用干净检出构建的产物。** 当前打包脚本会把整个 `shortcuts/` 目录作为资源复制；本机即使存在被 Git 忽略的签名快捷指令，也可能被打进包。已签名文件包含签名者的 Apple ID 签名验证记录，不应随公开安装包分发。公开仓库只保留 `unsigned` 源文件，手机安装步骤见 [快捷指令说明](../shortcuts/开始安装.md)。

## 维护者发布

[macOS 工作流](../.github/workflows/macos-package.yml) 有两个入口：

| 触发方式 | 结果 |
| --- | --- |
| 推送 `v*` 标签 | 按标签检出、测试、构建并发布同名 Release |
| Actions 手动运行，`tag` 留空 | 只构建，安装包作为 Artifact 保留 30 天 |
| Actions 手动运行，填写已有标签 | 按该标签构建并向同名 Release 上传资产；同名资产会被覆盖 |

发布前在干净检出中验证目标提交，更新 `package.json` 与 `package-lock.json` 的版本，并提交相关源码和文档。标签必须严格等于 `v` 加 `package.json` 的版本。以下以未来发布 **v0.4.1** 为例，实际使用时替换为准备发布的版本：

```sh
npm version 0.4.1 --no-git-tag-version
npm test
npm run build
git add package.json package-lock.json
git commit -m "chore: bump version to 0.4.1"
git tag v0.4.1
git push origin main v0.4.1
```

以上假定功能与文档已提交、当前分支为准备发布的 `main`。工作流会再次校验版本、安装依赖、运行测试与打包，把压缩包重命名为 `body-journal-mac-arm64.zip`，生成 `SHA256SUMS.txt`，解压检查签名，再上传 Release。它不运行桌面界面测试，也不验证真实模型或 iPhone。

发布后核对 Actions 结果、Release 标签、安装包与校验文件，并同步版本说明。纯文档整理通常无需升级应用版本或重新发布安装包。

新完整备份为 v4，可恢复 v1–v3。记忆版本与回答依赖由本地逻辑维护；不要让模型自行指定已确认版本。精度评测采用显式选择的本地文件，`npm run evaluate -- /path/to/data.json` 可输出 JSON 报告。

本轮本机打包使用Node24，并对实际打包应用完成隔离流程验证；Node26在当前打包依赖下曾以未完成顶层await退出。建议本机与CI打包统一使用Node24。

模型网络通过NetworkFetch注入；桌面主进程使用Electron net.fetch，测试默认动态调用全局fetch。不要为连接问题关闭TLS验证。实际连接可通过应用中的“测试图文连接”主动发起；`BodyJournal --check-connection`使用当前账号，仅发送自带测试图与测试文字，成功后退出，不读取个人记录组成提示。正常启动不自动测试。

`npm run test:analysis-ui` 使用临时合成档案和模拟传输，覆盖完整分析队列、失败重试、补充恢复与取消；不会发起真实模型请求。分析尝试状态是任务元数据，不增加原文修订；成功结果、原文更改和补充仍保留修订历史。
