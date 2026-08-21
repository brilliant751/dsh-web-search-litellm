/**
 * LiteLLM search provider for the DeepSeek Harness web capability seam
 * (`ctx.web`). It calls LiteLLM's `/search` endpoint — a pure retrieval call,
 * not a model turn — and maps the returned `results[]` into the seam's
 * normalized `WebSearchResult`. One search is one HTTP request.
 *
 * This is a function/namespace plugin (`inject: ['web']`): it registers a
 * `WebSearchProvider` and exposes no model-facing tool of its own. The
 * model-facing `web_search` tool is owned by `@deepseek-ai/dsh-tool-web`.
 *
 * @module @brilliant751/dsh-web-search-litellm
 */
import { WebError } from "@deepseek-ai/dsh-web";

/** Stable id this provider registers under (matches `web.searchProvider`). */
export const PROVIDER_ID = "litellm";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-litellm";

/** The web seam this provider registers into. */
export const inject = ["web"];

/** Default LiteLLM base URL (`/search` is appended). */
const DEFAULT_BASE_URL = "https://your-litellm.example.com/v1";
/** Default credential reference, resolved per search. */
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
/** Default LiteLLM search tool name. */
const DEFAULT_SEARCH_TOOL = "google";
/** Attribution header sent on every request. */
const USER_AGENT = "dsh-web-search-litellm/0.1.0";

/** True for a fetch/AbortSignal abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
  return (error instanceof DOMException && error.name === "AbortError") ||
    error?.name === "AbortError";
}

/** The LiteLLM-backed search provider. */
export class LiteLLMSearchProvider {
  id = PROVIDER_ID;

  /**
   * @param ctx - the plugin context, for lazy credential resolution.
   * @param config - the row's config snapshot (baseURL, apiKeyEnv, searchToolName, apiKey).
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config ?? {};
  }

  /**
   * Cheap local usability check — never makes network calls. Returns true
   * when the endpoint is parseable and a credential is reachable through one
   * of: a literal `apiKey`, the credentials service, or the environment.
   * Actual key resolution happens per search.
   */
  available() {
    const baseURL = this.config.baseURL ?? DEFAULT_BASE_URL;
    if (!URL.canParse(baseURL)) return false;
    if ((this.config.apiKey?.length ?? 0) > 0) return true;
    const apiKeyEnv = this.config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    try {
      if (this.ctx.get("credentials") !== void 0) return true;
    } catch {
      // fall through to the environment check
    }
    return (process.env[apiKeyEnv]?.length ?? 0) > 0;
  }

  /**
   * Run one search against LiteLLM `/search`.
   * @param request - `{ query, maxResults? }`; the seam enforces `maxResults`.
   * @param signal - optional abort signal.
   * @returns the normalized result (sources mapped from `results[]`).
   */
  async search(request, signal) {
    const baseURL = this.config.baseURL ?? DEFAULT_BASE_URL;
    const apiKeyEnv = this.config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    const searchToolName = this.config.searchToolName ?? DEFAULT_SEARCH_TOOL;

    const apiKey = await this.resolveApiKey(apiKeyEnv, signal);
    this.throwIfAborted(signal);

    const endpoint = `${baseURL}/search`;
    const body = {
      query: request.query,
      search_tool_name: searchToolName,
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== void 0 ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw this.aborted(signal, error);
      throw new WebError(`LiteLLM search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }

    if (!response.ok) {
      let message = `LiteLLM search error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        const detail = typeof parsed.error === "string" ? parsed.error
          : parsed.error?.message ?? parsed.message ?? parsed.detail;
        if (detail !== void 0 && String(detail).length > 0) message = String(detail);
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw this.aborted(signal, error);
      }
      throw new WebError(message, "WEB_PROVIDER_ERROR");
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw this.aborted(signal, error);
      throw new WebError(`LiteLLM returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }

    return this.mapResults(data);
  }

  /** Map LiteLLM `{ results: [{title,url,snippet,date}] }` to seam sources. */
  mapResults(data) {
    const results = Array.isArray(data?.results) ? data.results : [];
    const sources = results
      .filter((item) => typeof item?.url === "string" && item.url.length > 0)
      .map((item) => {
        const source = { url: item.url };
        if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
        if (typeof item.snippet === "string" && item.snippet.length > 0) source.snippet = item.snippet;
        const publishedAt = item.date ?? item.last_updated ?? item.published_at;
        if (typeof publishedAt === "string" && publishedAt.length > 0) source.publishedAt = publishedAt;
        return source;
      });
    // The seam enforces `maxResults`; this provider returns everything it got.
    return { sources, truncated: false };
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * Order: literal `apiKey`, then the credentials service, then the process
   * environment. Throws `WEB_PROVIDER_CREDENTIAL_MISSING` when none resolves.
   */
  async resolveApiKey(apiKeyEnv, signal) {
    this.throwIfAborted(signal);
    if ((this.config.apiKey?.length ?? 0) > 0) return this.config.apiKey;
    let resolved;
    try {
      const credentials = this.ctx.get("credentials");
      if (credentials !== void 0) {
        const entry = await credentials.resolve(apiKeyEnv);
        resolved = entry?.value;
      }
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw this.aborted(signal, error);
      throw new WebError(`LiteLLM search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (resolved !== void 0 && resolved.length > 0) return resolved;
    const ambient = process.env[apiKeyEnv];
    if (ambient !== void 0 && ambient.length > 0) return ambient;
    throw new WebError(
      `LiteLLM search has no API key for "${apiKeyEnv}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-litellm config`,
      "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
  }

  /** Throw the provider's stable cancellation error when already aborted. */
  throwIfAborted(signal) {
    if (signal?.aborted === true) throw this.aborted(signal);
  }

  /** Build the provider's stable cancellation error, retaining the reason. */
  aborted(signal, fallback) {
    return new WebError("LiteLLM search aborted", "WEB_ABORTED", {
      cause: signal?.aborted === true ? signal.reason : fallback,
    });
  }
}

/** Register the LiteLLM search provider into `ctx.web`. */
export function apply(ctx, config) {
  ctx.web.registerSearchProvider(new LiteLLMSearchProvider(ctx, config));
}
