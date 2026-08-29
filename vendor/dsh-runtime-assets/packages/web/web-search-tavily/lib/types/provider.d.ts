/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API
 * (`POST /search`). It maps each result's `content` to `snippet`, maps the
 * top-level generated `answer` (when requested) to the seam's `content`, and
 * drops entries without a portable snippet — the seam has no other field to
 * derive a snippet from, and inventing one would lie.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import type { TavilyResult, TavilySearchResponse } from './types.ts';
/** Stable id this provider registers under. */
export declare const TAVILY_PROVIDER_ID = "tavily";
/** Default Tavily search endpoint; `/search` is the operation. */
export declare const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
/** Ask Tavily for a generated answer by default (fed into the seam's `content`). */
export declare const TAVILY_DEFAULT_INCLUDE_ANSWER = true;
/** Resolved provider options (the entrypoint's `apply` supplies env-var and constant defaults). */
export interface TavilySearchProviderOptions {
    /** Resolve the Tavily API key for each search; `undefined` makes the provider unavailable. */
    resolveApiKey: () => Promise<string | undefined>;
    /** Endpoint base; `/search` is appended. */
    baseURL: string;
    /** Request a generated answer from Tavily (mapped to the seam's `content`). */
    includeAnswer: boolean;
    /** Default result count when a request carries no `maxResults`. */
    numResults?: number;
}
/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no portable snippet (an entry with blank content is dropped — the seam has no
 * other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank content snippet.
 */
export declare function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined;
/**
 * Map a Tavily response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapTavilyResult}).
 */
export declare function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult;
/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export declare class TavilySearchProvider implements WebSearchProvider {
    private readonly options;
    readonly id = "tavily";
    constructor(options: TavilySearchProviderOptions);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
//# sourceMappingURL=provider.d.ts.map