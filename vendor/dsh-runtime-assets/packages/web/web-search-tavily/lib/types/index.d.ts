/**
 * `@deepseek-ai/dsh-web-search-tavily`: registers a Tavily-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-exa`
 * registers an adapter into `ctx.web`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_INCLUDE_ANSWER, TAVILY_PROVIDER_ID, TavilySearchProvider, } from './provider.ts';
export type { TavilySearchProviderOptions } from './provider.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "web-search-tavily";
/** The web seam this provider registers into. */
export declare const inject: string[];
/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
    /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
    apiKey?: string;
    /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
    apiKeyEnv?: string;
    /** Endpoint base; `/search` is appended. Defaults to the public API. */
    baseURL?: string;
    /** Request a generated answer from Tavily. Defaults to true. */
    includeAnswer?: boolean;
    /** Default result count when a request carries no `maxResults`. Omitted = none. */
    numResults?: number;
}
export declare const Config: z<Config>;
/** Register the Tavily search provider with `ctx.web`. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map