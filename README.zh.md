# @brilliant751/dsh-web-search-litellm

> [English](README.md) | 中文

基于 [LiteLLM](https://github.com/BerriAI/litellm) `/v1/search` 端点的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）网页搜索 provider，接入 `ctx.web` 能力 seam。

一次搜索就是一次发往 LiteLLM 搜索端点的 HTTP 请求——**不消耗模型推理**，这一点不同于自带的 DeepSeek Anthropic 兼容 provider。它复用你现有的 LiteLLM 网关及其虚拟 key，让聊天与搜索走同一个代理。

## 安装

```sh
dsh plugin --profile web add @brilliant751/dsh-web-search-litellm
```

重启 `dsh web`。本包声明了 `dsh.bundle.patch`，因此 `dsh plugin add` 会把它追加进 `dsh.profile.bundles`，从而注册 `litellm` provider 并将其选为当前搜索后端。

## 工作原理

- 向 `ctx.web` 注册一个 id 为 `litellm` 的 `WebSearchProvider`。
- 调用 `POST {baseURL}/search`，请求体为 `{ query, search_tool_name }`，带 `Authorization: Bearer <key>` 头。
- 把 LiteLLM 返回的 `results[]`（`title` / `url` / `snippet` / `date`）映射成 seam 规范化的 `sources[]`。
- 面向模型的 `web_search` 工具保持不变（`@deepseek-ai/dsh-tool-web`），结果保留原生引用卡片。

## 配置

默认值写在 `cordis.patch.yml` 中：

| 键 | 默认值 | 含义 |
|-----|--------|------|
| `baseURL` | `https://your-litellm.example.com/v1` | LiteLLM 基础地址；`/search` 会被追加。这是 OpenAI 兼容基础地址，不是 Anthropic passthrough。 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭证引用，每次搜索时通过 `ctx.credentials` 解析（Models 页面写入），然后回退到环境变量。 |
| `searchToolName` | `google` | 要调用的 LiteLLM 搜索工具（见 `GET {baseURL}/search/tools`）。 |

在你自己 profile 的 `cordis.patch.yml` 或 `--patch` overlay 中覆盖任意值。注意：patch 会**整体替换目标行的 `config`**（不做合并），所以覆盖时必须重写完整配置：

```yaml
- insert:
    - id: web-search-litellm
      name: '@brilliant751/dsh-web-search-litellm'
      config:
        baseURL: https://your-litellm.example.com/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        searchToolName: google
```

要切回自带的 DeepSeek provider，把 `web.searchProvider` 改回 `deepseek-official`（或卸载本包）。

## 凭证解析顺序

1. 配置中的字面量 `apiKey`（不推荐——优先用凭证存储）。
2. `ctx.credentials` 解析 `apiKeyEnv`（Web UI 的 Models/Web-search 卡片会写入 `$DSH_HOME/.credentials.yaml`）。
3. `process.env[apiKeyEnv]`。

## 安全说明

安装本插件即意味着以你的权限运行其代码。它只会把你的 LiteLLM key 发送给配置的 `baseURL`。请只把 `baseURL` 指向你信任的网关。

## 许可证

MIT
