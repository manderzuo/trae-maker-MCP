# AI Work Seedance — MCP server

`server.mjs` 把本技能的 PowerShell runner 桥接成标准 **MCP stdio 服务**，任何支持
MCP 的客户端（DSH / Claude Code / Codex / 其他）都能把 Seedance 当成原生工具调用。

它是**薄协议层**，不是第二套实现：上传、幂等、轮询、下载与 DPAPI 凭据解密全部委托给
`../scripts/aiwork-seedance.ps1`。本目录下的代码不读取、不打印、不转发 API Key。

零依赖，只需 Windows 上已有的 Node（≥ 18，实测 v24）与 Windows PowerShell 5.1。

## 暴露的工具

| 工具 | 网关请求 | 副作用 |
|---|---|---|
| `seedance_doctor` | `GET /health` + 鉴权后的 `GET /v1/models` | 无（不计费，先调它） |
| `seedance_upload` | `POST /v1/assets` | 存一份显式指定的素材 |
| `seedance_submit` | `POST /v1/videos/generations` + `Idempotency-Key` | **建一个视频任务（消耗积分）** |
| `seedance_status` | `GET /v1/videos/{id}` | 无 |
| `seedance_wait` | 轮询 `GET /v1/videos/{id}` | 无 |
| `seedance_download` | `GET /v1/videos/{id}/content` | 写本地 MP4，默认 Downloads |
| `seedance_generate` | 以上编排 | 建任务 + 完成后自动下载 |

在 DSH 中以 `mcp__aiwork__seedance_submit` 这类名字出现（前缀由 `serverName` 决定）。

## 挂载到 DSH

先在本机跑一次 `install.cmd` 配置网关与 Key（写入 `%APPDATA%\AIWork\seedance-skill.json`，
Key 经 Windows DPAPI 用户级加密）。**配置文件不进 yml**，所以凭据不会出现在任何仓库或配置里。

然后在 `~/.dsh/profiles/web-desktop/cordis.patch.yml` 追加一条（或用 设置 → 插件 里的
MCP 管理界面填写），随后重载配置 / 重启服务生效：

```yaml
- insert:
    - id: mcp-aiwork-seedance
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: aiwork
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'C:\Users\<you>\.agents\skills\aiwork-seedance\mcp\server.mjs'
        # wait 的默认 45 秒适配 60 秒默认值；用 seedance_generate 必须抬高这里。
        toolCallTimeoutMs: 600000
```

`command` 也可以指向 EAC 自带的 node：
`C:\Users\<you>\AppData\Local\Deepseek Harness EAC\dsh-desktop\vendor\node\node.exe`。

### 超时怎么配

DSH 的 `toolCallTimeoutMs` 默认 **60 秒**，而视频生成通常要几分钟。两条路线：

- **分段调用（推荐）**：`submit` → 反复 `wait`（默认上限 45 秒）。等待超时**不是错误**，
  返回 `finished=false` 且保留 `task_id`，再调 `wait` 续等即可，60 秒默认值就够用。
- **一次性 `generate`**：把 `toolCallTimeoutMs` 抬到 `timeout_seconds + 60` 秒以上
  （例如 `600000` 配 `timeout_seconds: 540`）。

### stdio 子进程环境

DSH 会**清洗**掉名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量再启动子进程，
所以 `AIWORK_API_KEY` 走系统环境变量不会传进来——这正是本设计用 DPAPI 配置文件的原因。
确需用环境变量时，在配置项的 `env:` 里显式声明（它合并在被清洗的环境之上）：

```yaml
        env:
          AIWORK_GATEWAY_BASE_URL: 'https://your-gateway.example.com/v1'
          AIWORK_API_KEY: !!js 'process.env.MY_AIWORK_KEY'
```

注意这样 Key 会经由父进程环境传递，不如 DPAPI 配置文件稳妥。

## 可选环境变量

| 变量 | 作用 |
|---|---|
| `AIWORK_PS_EXE` | 覆盖 PowerShell 路径（默认 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`；也可指向 pwsh 7） |
| `AIWORK_MCP_MAX_WAIT_SECONDS` | 服务端允许的单次等待上限，默认 3600 |
| `AIWORK_MCP_VERBOSE` | 仅测试脚本使用：打印桥接的 stderr |

## 自测

```powershell
node mcp\smoke-test.mjs        # 协议、转义、目录形状、参数校验、runner 失败上抛
node mcp\integration-test.mjs  # 本地假网关跑通 doctor→submit(双图)→wait→download→generate
```

两者都不建任务、不花积分，且刻意用**文件重定向**而不是管道做 stdio，
因此在禁止匿名管道的受限环境里也能跑。

## Windows PowerShell 5.1 的三个硬约束（已由字节级实测确认）

1. **`-File` 不能传数组**：`-ImagePath a,b` 静默绑成 1 个元素（逗号留在字符串里），
   `-ImagePath a b` 会把第二个值灌进位置参数 `Action`。所以桥接一律用
   `-Command "& runner -ImagePath @('a','b')"`。
2. **`exit` 不传播**：`-Command "& script.ps1"` 里脚本的 `exit 1` 既不设置
   `$LASTEXITCODE`，也不改变进程退出码；只有当 runner 调用是**最后一条语句**时
   非零退出才可见。桥接据此把 runner 调用放在命令末尾，并且只用退出码作辅助信号。
3. **`.ps1` 源文件必须带 UTF-8 BOM**：无 BOM 时 PS 5.1 按 GBK 解码源码，中文串的尾字节
   会吞掉紧随的单引号，导致脚本**语法解析失败**（不只是乱码）。本目录只交付 `.mjs`
   （Node 直接按 UTF-8 读），新增 `.ps1` 时务必带 BOM。
   重定向到文件的 stdout/stderr 恒为 UTF-8，所以桥接按 UTF-8 解码，中文错误消息原样上抛。

## 安全边界

- API Key 只存在于 DPAPI 加密的用户配置文件；不出现在命令行、日志、回复文本里
  （`integration-test.mjs` 第 8 组断言专门盯这一条）。
- 素材路径必须显式给出，桥接与 runner 都不扫描目录。
- 网关返回的 URL 只作为数据；下载始终走已配置网关的鉴权 content 路由，且不会带 Key 跟随跨站跳转。
- 等待超时、任务进行中都不会被包装成"失败"，以避免模型用新键重复提交而二次扣费。
