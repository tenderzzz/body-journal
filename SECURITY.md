# 安全问题反馈

身体手记处理个人健康记录和模型凭据。若问题可能造成凭据泄露、越权访问档案、任意文件读写或执行代码，请先私下报告，避免在公开 Issue 中发布利用细节或真实数据。

## 如何报告

1. 使用仓库已启用的 [私密漏洞报告入口](https://github.com/tenderzzz/body-journal/security/advisories/new)（需要登录 GitHub）。
2. 如果无法访问，可在 [Issues](https://github.com/tenderzzz/body-journal/issues/new) 中只写“希望私下报告一个安全问题，请提供联系渠道”，不要附复现细节、漏洞附件、凭据或健康数据。待维护者提供渠道后再继续。

报告中请尽量说明受影响的版本或提交、macOS 版本、复现条件、潜在影响与最小复现步骤。使用合成数据；不要测试他人的账号或档案。若怀疑凭据已泄露，请同时通过相应服务商撤销或更换凭据。

## 维护范围

这是个人维护的 0.x 项目，安全修复优先针对最新公开源码和最新发布版本；没有长期支持分支，也不承诺固定响应时限。普通安装问题、功能建议和不涉及安全影响的错误，请使用 [Issue 模板](https://github.com/tenderzzz/body-journal/issues/new/choose)。

## 使用前了解

- 发布包为 macOS Apple Silicon 的 ad-hoc 签名构建，未经过 Apple Developer ID 公证。
- 健康档案、完整备份和可读导出没有应用层加密；模型凭据单独使用系统保护机制保存。
- 模型调用会发送相关原文、图片或检索上下文，具体范围见[数据与隐私](docs/privacy.md)。

技术实现入口：[`electron/main.ts`](electron/main.ts)（凭据保护与窗口权限）、[`electron/core/store.ts`](electron/core/store.ts)（档案、路径与备份校验）、[`electron/ai/auth.ts`](electron/ai/auth.ts)（授权）、[`electron/ai/service.ts`](electron/ai/service.ts)（模型请求）。
