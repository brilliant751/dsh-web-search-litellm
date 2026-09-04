# @brilliant751/dsh-web-search-litellm

> English | [中文](README.zh.md)

A [LiteLLM](https://github.com/BerriAI/litellm) `/v1/search`-backed web search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web capability seam (`ctx.web`).

One search is one HTTP request to LiteLLM's search endpoint — **no model turn**, unlike the shipped DeepSeek Anthropic-compatible provider. It reuses your LiteLLM gateway and its virtual key, so chat and search go through the same proxy.

## Install

```sh
dsh plugin --profile web add @brilliant751/dsh-web-search-litellm
```

Restart `dsh web`. The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to `dsh.profile.bundles`, which registers the `litellm` provider and selects it as the active search backend.

## LiteLLM prerequisite

LiteLLM routes search through a named search tool. The name is local to your
gateway—it is not the provider type. The bundled default expects a tool named
`google`. For example, a LiteLLM `config.yaml` can map that name to Google PSE:

```yaml
search_tools:
  - search_tool_name: google
    litellm_params:
      search_provider: google_pse
      api_key: os.environ/GOOGLE_PSE_API_KEY
```

Google PSE also expects `GOOGLE_PSE_ENGINE_ID` in the LiteLLM server environment.
Other supported `search_provider` values can use the same local tool name.

Before configuring DSH, verify that the gateway key can see the tool:

```sh
curl https://your-litellm.example.com/v1/search/tools \
  -H 'Authorization: Bearer YOUR_LITELLM_VIRTUAL_KEY'
```

The response's `data[].search_tool_name` must contain the name configured below.

## How it works

- Registers a `WebSearchProvider` with id `litellm` into `ctx.web`.
- Calls `POST {baseURL}/search` with `{ query, search_tool_name }` and `Authorization: Bearer <key>`.
- Maps LiteLLM's `results[]` (`title` / `url` / `snippet` / `date`) into the seam's normalized `sources[]`.
- The model-facing `web_search` tool is unchanged (`@deepseek-ai/dsh-tool-web`); results keep the native citation card.

## Configuration

Defaults live in `cordis.patch.yml`:

| Key | Default | Meaning |
|-----|---------|---------|
| `baseURL` | `https://your-litellm.example.com/v1` | LiteLLM base; `/search` is appended. OpenAI-compatible base, not the Anthropic passthrough. |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference, resolved per search through `ctx.credentials` (the Models page writes it), then the DSH launch environment. |
| `searchToolName` | `google` | The LiteLLM search tool to invoke (see `GET {baseURL}/search/tools`). |

The package exports a Cordis `Config` schema, so compatible DSH configuration
surfaces can render these fields and keep a literal `apiKey` redacted. The
bundle patch remains the portable source of initial values.

Override any value from your profile's own `cordis.patch.yml` or a `--patch` overlay. A patch **replaces a targeted row's whole `config`** (it does not merge), so restate the complete config when overriding:

```yaml
- insert:
    - id: web-search-litellm
      name: '@brilliant751/dsh-web-search-litellm'
      config:
        baseURL: https://your-litellm.example.com/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        searchToolName: google
```

To switch back to the shipped DeepSeek provider, override `web.searchProvider` back to `deepseek-official` (or uninstall this bundle).

## Credential resolution

1. A literal `apiKey` in the config (not recommended — prefer the credential store).
2. `ctx.credentials` resolving `apiKeyEnv` (the Web UI's Models/Web-search card writes `$DSH_HOME/.credentials.yaml`).
3. The DSH launch-environment snapshot: inherited process variables, then the
   project `.env`, then the Harness home `.env`.

## Compatibility

Version `0.1.1` supports the DSH web seam prerelease lines from
`0.1.0-rc.6` through `0.1.2-rc.1` and requires Node.js 20 or newer.

## Troubleshooting

- **Configured provider is unavailable:** check that `baseURL` is an absolute
  URL, `searchToolName` is non-empty, and `apiKeyEnv` resolves in the credential
  store or launch environment.
- **HTTP 401/403:** the virtual key must be allowed to call the selected LiteLLM
  search tool; this permission is separate from chat model access.
- **Unknown search tool/model:** call `GET {baseURL}/search/tools` and copy an
  exact `search_tool_name` into the plugin config.
- **Invalid search response:** confirm the configured route is LiteLLM's Search
  API and that the gateway returns a `results` array.

## Security note

Installing this plugin runs its code with your permissions. It sends your LiteLLM key to the configured `baseURL` only. Point `baseURL` only at a gateway you trust.

## License

MIT
