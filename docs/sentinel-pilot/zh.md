# Sentinel：部署与域名

**结果：**域名、DNS、HTTPS 和 API 检查均通过，重复运行扣款为 0 美元。
网站：[sentinelproof.click](https://sentinelproof.click/)。
应用报告仍存在下文所述的 ATLAS 限制。

## 测试范围

工厂此前已经创建 Sentinel，并将其部署到 Vercel。本次测试重新部署现有版本，
在所有者的 Porkbun 账户中注册 `sentinelproof.click`，然后将域名连接到原有
Vercel 项目。Porkbun 提供域名和 DNS，应用仍由 Vercel 托管。
本次测试不代表从零创建应用，也不代表工厂已经实现全程无人值守。

## 预算与凭据

授权范围为注册一个域名一年，总价不超过 3 美元。实际扣款为 1.54 美元，
余额从 10 美元变为 8.46 美元。自动续费已关闭。
本次查询的续费价格为 10.81 美元；未来续费前必须重新查询价格。
注册使用账户已有联系人信息，并启用 WHOIS 隐私保护。
如需验证注册人邮箱，应由所有者完成。

Porkbun 生产环境密钥保存在
`~/.config/domain-kit/porkbun/production/api-key` 和 `secret-key` 中，
文件权限为 `0600`。Vercel 令牌仅在工厂服务器上通过 SSH 使用，不复制到
本地。本次操作不向 GitHub 写入任何内容。

## 从 aicom 根目录运行

```bash
node domain-kit/scripts/sentinel-live-pilot.mjs preflight
node domain-kit/scripts/sentinel-live-pilot.mjs deploy
node domain-kit/scripts/sentinel-live-pilot.mjs run
```

首次购买前运行 `preflight`，调用官方 dry-run 接口，不扣款。注册成功后，
域名不再处于可注册状态。`deploy` 只创建一次重新部署；后续运行检查同一次
部署。若仍在构建，请稍后再次运行。
`run` 只有在网站和 `/api/health` 检查通过后才允许购买。
重复执行 `run` 会复用已保存的购买凭证和部署，不会再次购买。
退出码 `2` 表示 DNS 或 HTTPS 尚未就绪。

DNS 配置完成后，程序自动等待：每次检查之间暂停 20 秒，等待窗口为 10 分钟。
已开始的网络请求按其自身超时结束。状态分别表示等待 DNS、证书、HTTPS、
应用或服务商响应。只有域名验证、DNS、证书、网页以及 API 和数据库检查
全部通过，才会标记为 `ready`。进度保存在
`data/sentinel-live/setup-status.json` 中。超时后仍标记为等待，并以退出码 `2`
结束。可运行 `node domain-kit/scripts/sentinel-live-pilot.mjs verify`
继续配置，不进入购买流程。进程退出后不会在后台轮询；需重新运行或由外部
调度器恢复。权限错误需要操作者处理。

## 恢复与验收

加密状态保存在被 Git 忽略的 `domain-kit/data/sentinel-live/` 中。
不要为了重试而删除状态。注册商响应丢失时，使用同一操作标识重试。
超过 23 小时后，结果未知的操作必须人工核对，不能重新购买。
`pilot.lock` 防止并发运行；异常终止后，删除锁之前必须确认记录的进程已退出。

验收要求：Vercel 确认域名和 DNS 配置正确，HTTPS 可访问 Sentinel，
API 健康检查成功，重复运行时余额不变。
浏览器中的安全报告功能需要单独验证；域名可用并不能证明外部数据服务正常。

这是面向账户所有者、单一域名和固定项目的有限测试，不是生产级域名转售服务。
现有的沙盒供应商适配器保持不变。

## 已发现的应用限制

在原有 Vercel 地址和新域名上，浏览器中的柏林示例均返回了 `UNKNOWN`：
付费 ATLAS 能力 `atlas.situation.brief@v1` 在当前免费模式下不可用。
本次测试没有额外支付 ATLAS 费用。这是独立的应用功能限制，
不是域名注册或 DNS 错误。
