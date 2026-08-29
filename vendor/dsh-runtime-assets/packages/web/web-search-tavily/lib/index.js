import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
//#region lib/types/provider.js
/**
* `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API
* (`POST /search`). It maps each result's `content` to `snippet`, maps the
* top-level generated `answer` (when requested) to the seam's `content`, and
* drops entries without a portable snippet — the seam has no other field to
* derive a snippet from, and inventing one would lie.
* @module @deepseek-ai/dsh-web-search-tavily/provider
*/
/** Stable id this provider registers under. */
const TAVILY_PROVIDER_ID = "tavily";
/** Default Tavily search endpoint; `/search` is the operation. */
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
/** Ask Tavily for a generated answer by default (fed into the seam's `content`). */
const TAVILY_DEFAULT_INCLUDE_ANSWER = true;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "deepseek-harness/0.0.1";
/**
* Map one Tavily result to a normalized source, or `undefined` when it carries
* no portable snippet (an entry with blank content is dropped — the seam has no
* other field to derive a snippet from, and inventing one would lie).
*
* @param result - one entry of Tavily's `results[]`.
* @returns the normalized source, or `undefined` when the entry has no
*   non-blank content snippet.
*/
function mapTavilyResult(result) {
	const snippet = result.content?.trim() ?? "";
	if (snippet.length === 0) return void 0;
	return {
		url: result.url,
		...result.title != null && result.title.length > 0 ? { title: result.title } : {},
		snippet
	};
}
/**
* Map a Tavily response envelope to a normalized search result.
*
* @param response - the parsed `POST /search` response body.
* @returns the normalized result; snippet-less entries are dropped
*   ({@link mapTavilyResult}).
*/
function mapTavilyResponse(response) {
	const sources = (response.results ?? []).map(mapTavilyResult).filter((source) => source !== void 0);
	const answer = response.answer?.trim() ?? "";
	return {
		sources,
		...answer.length > 0 ? { content: answer } : {},
		truncated: false
	};
}
/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var TavilySearchProvider = class {
	options;
	id = TAVILY_PROVIDER_ID;
	constructor(options) {
		this.options = options;
	}
	available() {
		return URL.canParse(this.options.baseURL) && (this.options.numResults === void 0 || isPositiveInteger(this.options.numResults));
	}
	async search(request, signal) {
		const apiKey = await this.options.resolveApiKey();
		if (apiKey === void 0 || apiKey.length === 0) throw new WebError("Tavily search unavailable: no API key", "WEB_PROVIDER_ERROR");
		const numResults = request.maxResults ?? this.options.numResults;
		let response;
		try {
			response = await fetch(`${this.options.baseURL}/search`, {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify({
					api_key: apiKey,
					query: request.query,
					include_answer: this.options.includeAnswer,
					...numResults !== void 0 ? { max_results: numResults } : {}
				}),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Tavily search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Tavily search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Tavily API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = parsed.error ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch (error) {
				if (isAbortError(error)) throw new WebError("Tavily search aborted", "WEB_ABORTED", { cause: error });
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapTavilyResponse(await response.json());
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Tavily search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
};
/** True for a request limit that can be sent to Tavily (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
//#endregion
//#region lib/types/index.js
/**
* `@deepseek-ai/dsh-web-search-tavily`: registers a Tavily-backed `WebSearchProvider`
* with `ctx.web`. A function/namespace plugin (NOT a default-export service):
* a search provider does not own the `ctx.web` key — it registers INTO the
* seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-exa`
* registers an adapter into `ctx.web`. The key is owned by `@deepseek-ai/dsh-web`.
*
* @module @deepseek-ai/dsh-web-search-tavily
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-tavily";
/** The web seam this provider registers into. */
const inject = ["web"];
const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	includeAnswer: z.boolean(),
	numResults: z.number().step(1).min(1)
});
/** Register the Tavily search provider with `ctx.web`. */
function apply(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	ctx.web.registerSearchProvider(new TavilySearchProvider({
		resolveApiKey: async () => {
			if (literalApiKey !== void 0) return literalApiKey;
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		baseURL: config.baseURL ?? "https://api.tavily.com",
		includeAnswer: config.includeAnswer ?? true,
		...config.numResults !== void 0 ? { numResults: config.numResults } : {}
	}));
}
//#endregion
export { Config, TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_INCLUDE_ANSWER, TAVILY_PROVIDER_ID, TavilySearchProvider, apply, inject, name };
