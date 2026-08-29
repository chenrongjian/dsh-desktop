/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API
 * (`POST /search`). It maps each result's `content` to `snippet`, maps the
 * top-level generated `answer` (when requested) to the seam's `content`, and
 * drops entries without a portable snippet — the seam has no other field to
 * derive a snippet from, and inventing one would lie.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */
import { WebError } from '@deepseek-ai/dsh-web';
/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily';
/** Default Tavily search endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
/** Ask Tavily for a generated answer by default (fed into the seam's `content`). */
export const TAVILY_DEFAULT_INCLUDE_ANSWER = true;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1';
/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no portable snippet (an entry with blank content is dropped — the seam has no
 * other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank content snippet.
 */
export function mapTavilyResult(result) {
    const snippet = result.content?.trim() ?? '';
    if (snippet.length === 0)
        return undefined;
    return {
        url: result.url,
        ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
        snippet,
    };
}
/**
 * Map a Tavily response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapTavilyResult}).
 */
export function mapTavilyResponse(response) {
    const sources = (response.results ?? [])
        .map(mapTavilyResult)
        .filter((source) => source !== undefined);
    // The optional generated answer, when present, becomes the seam's `content`.
    // The web service owns the final `maxResults` truncation, so the provider
    // reports `truncated: false`.
    const answer = response.answer?.trim() ?? '';
    return {
        sources,
        ...answer.length > 0 ? { content: answer } : {},
        truncated: false,
    };
}
/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider {
    options;
    id = TAVILY_PROVIDER_ID;
    constructor(options) {
        this.options = options;
    }
    available() {
        // A base URL that cannot parse leaves the provider unusable regardless of key.
        return URL.canParse(this.options.baseURL)
            && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults));
    }
    async search(request, signal) {
        const apiKey = await this.options.resolveApiKey();
        if (apiKey === undefined || apiKey.length === 0) {
            throw new WebError('Tavily search unavailable: no API key', 'WEB_PROVIDER_ERROR');
        }
        // A per-request bound wins over the configured default; either may be absent.
        const numResults = request.maxResults ?? this.options.numResults;
        let response;
        try {
            response = await fetch(`${this.options.baseURL}/search`, {
                method: 'POST',
                // Credential-bearing request must fail on redirect, never follow it.
                redirect: 'error',
                headers: {
                    'content-type': 'application/json',
                    'accept': 'application/json',
                    'user-agent': USER_AGENT,
                },
                body: JSON.stringify({
                    api_key: apiKey,
                    query: request.query,
                    include_answer: this.options.includeAnswer,
                    ...numResults !== undefined ? { max_results: numResults } : {},
                }),
                ...signal !== undefined ? { signal } : {},
            });
        }
        catch (error) {
            if (isAbortError(error))
                throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error });
            throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
        if (!response.ok) {
            const status = response.status;
            let message = `Tavily API error (HTTP ${status})`;
            try {
                const parsed = await response.json();
                const detail = parsed.error ?? parsed.message;
                if (detail !== undefined && detail.length > 0)
                    message = detail;
            }
            catch (error) {
                // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
                // into a generic HTTP-error message — cancellation is not a provider
                // error (the seam's cancellation contract).
                if (isAbortError(error))
                    throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error });
                // Otherwise: the HTTP status is already captured in `message` above; a
                // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
                // cost a richer provider message, never the real error.
            }
            throw new WebError(message, 'WEB_PROVIDER_ERROR');
        }
        try {
            const payload = await response.json();
            return mapTavilyResponse(payload);
        }
        catch (error) {
            if (isAbortError(error))
                throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error });
            throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
    }
}
/** True for a request limit that can be sent to Tavily (a positive whole number). */
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
//# sourceMappingURL=provider.js.map