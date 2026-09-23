# Trae Maker MCP Skills

通用 AI Work / Seedance 技能包，位于 `skills/aiwork-seedance/`，可供
Codex、Claude Code、DSH、Qoder 等支持 Agent Skills 或本地脚本的客户端使用。

## 安装

在目标电脑上下载本仓库后，进入技能目录运行：

```powershell
cd skills/aiwork-seedance
./install.cmd
```

安装程序会在用户目录保存网关地址和加密后的 API Key；密钥不会写入仓库。
也可以把该目录直接加入客户端的 skills 搜索路径。
需要标准 MCP 接入的客户端，可使用 [`skills/aiwork-seedance/mcp/README.md`](skills/aiwork-seedance/mcp/README.md)
中的 stdio 配置；它与脚本共用同一套网关配置。

星链维度分流系统的公网地址为 `https://api.gemstory.cn/v1`。旧配置中的
`https://www.gemstory.cn` 会在运行时自动迁移到正式 API 域名；其他自定义网关地址不变。

## 支持

- Seedance 文生视频、图生视频、参考视频
- 本地 `image_paths` / `video_paths` 上传
- 拖拽附件的 Base64/data URL 上传
- 任务状态查询、轮询、幂等提交和 MP4 下载
- `generate` 完成后自动下载到本机 `Downloads`；不再把查询地址作为最终结果
- 本机、局域网和公网网关地址

本地素材必须显式传入，不会扫描目录；不要把 API Key、JWT、Cookie 或本机账号数据提交到仓库。
