/**
 * Wire types for the Tavily search API (`POST https://api.tavily.com/search`).
 * Types only — no runtime code. Tavily returns a flat `results[]`, an optional
 * generated `answer`, and image hits; each result carries a URL, title, and a
 * semantic `content` snippet.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */
/** Request body sent to Tavily's `/search` endpoint. */
export interface TavilySearchRequest {
    query: string;
    /** Tavily's returned result-count control; the seam enforces the bound on return. */
    max_results?: number;
    /** Ask Tavily to generate an answer summary (mapped to the seam's `content`). */
    include_answer?: boolean;
}
/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
    url: string;
    title?: string | null;
    content: string;
    score?: number | null;
}
/** Tavily's `/search` response envelope. */
export interface TavilySearchResponse {
    results?: TavilyResult[];
    /** Generated answer (only when `include_answer` is true). */
    answer?: string | null;
    query?: string;
}
/** Tavily's error response envelope (best-effort; fields vary by failure). */
export interface TavilyError {
    error?: string;
    message?: string;
}
//# sourceMappingURL=types.d.ts.map