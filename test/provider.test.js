import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LiteLLMSearchProvider } from "../index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context({ credential = "test-key", resolve } = {}) {
  return {
    get(service) {
      if (service !== "credentials") return void 0;
      return {
        resolve: resolve ?? (async () => credential === void 0 ? void 0 : { value: credential }),
      };
    },
  };
}

function provider(config = {}, ctx = context()) {
  return new LiteLLMSearchProvider(ctx, {
    baseURL: "https://litellm.test/v1",
    searchToolName: "test-search",
    ...config,
  });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function rejection(operation) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to reject");
}

describe("LiteLLM result mapping", () => {
  it("maps normalized source fields and known date aliases", () => {
    assert.deepEqual(provider().mapResults({
      results: [
        { url: "https://a.test", title: "A", snippet: "first", date: "2026-01-01" },
        { url: "https://b.test", last_updated: "2026-01-02" },
        { url: "https://c.test", published_at: "2026-01-03" },
      ],
    }), {
      sources: [
        { url: "https://a.test", title: "A", snippet: "first", publishedAt: "2026-01-01" },
        { url: "https://b.test", publishedAt: "2026-01-02" },
        { url: "https://c.test", publishedAt: "2026-01-03" },
      ],
      truncated: false,
    });
  });

  it("drops entries without a usable URL", () => {
    assert.deepEqual(provider().mapResults({ results: [{ title: "missing" }, { url: "" }] }), {
      sources: [],
      truncated: false,
    });
  });

  it("rejects an invalid response envelope instead of reporting no results", () => {
    assert.throws(
      () => provider().mapResults({ results: {} }),
      (error) => error.code === "WEB_PROVIDER_ERROR" && /results array/u.test(error.message),
    );
  });
});

describe("LiteLLM request mapping", () => {
  it("sends the selected tool, max_results, auth, and rejects redirects", async () => {
    let call;
    globalThis.fetch = async (...args) => {
      call = args;
      return jsonResponse({ results: [] });
    };

    await provider().search({ query: "hello", maxResults: 6 });

    assert.equal(call[0], "https://litellm.test/v1/search");
    assert.equal(call[1].method, "POST");
    assert.equal(call[1].redirect, "error");
    assert.equal(call[1].headers.authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(call[1].body), {
      query: "hello",
      search_tool_name: "test-search",
      max_results: 6,
    });
  });

  it("normalizes trailing slashes and caps LiteLLM max_results at 20", async () => {
    let call;
    globalThis.fetch = async (...args) => {
      call = args;
      return jsonResponse({ results: [] });
    };

    await provider({ baseURL: "https://litellm.test/v1///?ignored=yes#fragment" })
      .search({ query: "hello", maxResults: 50 });

    assert.equal(call[0], "https://litellm.test/v1/search");
    assert.equal(JSON.parse(call[1].body).max_results, 20);
  });

  it("omits max_results when the seam does not provide one", async () => {
    let body;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({ results: [] });
    };

    await provider().search({ query: "hello" });
    assert.equal(Object.hasOwn(body, "max_results"), false);
  });

  it("rejects an invalid maxResults before dispatch", async () => {
    globalThis.fetch = async () => assert.fail("fetch must not be called");
    const error = await rejection(provider().search({ query: "hello", maxResults: 0 }));
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /positive integer/u);
  });
});

describe("LiteLLM failures and cancellation", () => {
  it("keeps the HTTP status and provider detail", async () => {
    globalThis.fetch = async () => jsonResponse({ error: { message: "bad key" } }, { status: 401 });
    const error = await rejection(provider().search({ query: "hello" }));
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /HTTP 401\): bad key/u);
  });

  it("rejects a malformed successful response", async () => {
    globalThis.fetch = async () => jsonResponse({ object: "search" });
    const error = await rejection(provider().search({ query: "hello" }));
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /results array/u);
  });

  it("maps a network failure to WEB_PROVIDER_ERROR", async () => {
    globalThis.fetch = async () => { throw new TypeError("connection refused"); };
    const error = await rejection(provider().search({ query: "hello" }));
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /connection refused/u);
  });

  it("maps an invalid baseURL to WEB_PROVIDER_ERROR", async () => {
    globalThis.fetch = async () => assert.fail("fetch must not be called");
    const error = await rejection(provider({ baseURL: "not a url" }).search({ query: "hello" }));
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /baseURL is invalid/u);
    assert.ok(error.cause instanceof TypeError);
  });

  it("aborts while asynchronous credential resolution is pending", async () => {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const controller = new AbortController();
    const operation = provider({}, context({ resolve: () => pending }))
      .search({ query: "hello" }, controller.signal);

    controller.abort(new Error("cancelled"));
    const error = await rejection(operation);
    settle({ value: "late-key" });

    assert.equal(error.code, "WEB_ABORTED");
    assert.equal(error.cause, controller.signal.reason);
  });
});

describe("LiteLLM availability", () => {
  it("requires a parseable URL and a credential source", () => {
    assert.equal(provider().available(), true);
    assert.equal(provider({ baseURL: "not a url" }).available(), false);
    assert.equal(provider({}, { get: () => void 0 }).available(), false);
    assert.equal(provider({ apiKey: "literal" }, { get: () => void 0 }).available(), true);
  });
});
