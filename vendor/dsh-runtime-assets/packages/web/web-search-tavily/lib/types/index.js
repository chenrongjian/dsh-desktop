/**
 * `@deepseek-ai/dsh-web-search-tavily`: registers a Tavily-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-exa`
 * registers an adapter into `ctx.web`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import { TavilySearchProvider, TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_INCLUDE_ANSWER, } from "./provider.js";
export { TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_INCLUDE_ANSWER, TAVILY_PROVIDER_ID, TavilySearchProvider, } from "./provider.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily';
/** The web seam this provider registers into. */
export const inject = ['web'];
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY';
export const Config = z.object({
    apiKey: z.string().role('secret'),
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    baseURL: z.string(),
    includeAnswer: z.boolean(),
    numResults: z.number().step(1).min(1),
});
/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx, config) {
    const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
    const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
        ? config.apiKey
        : undefined;
    ctx.web.registerSearchProvider(new TavilySearchProvider({
        // A literal key wins; otherwise resolve the credential reference through
        // the credentials seam, falling back to the ambient environment layer.
        resolveApiKey: async () => {
            if (literalApiKey !== undefined)
                return literalApiKey;
            const credentials = ctx.get('credentials');
            if (credentials !== undefined)
                return (await credentials.resolve(apiKeyEnv))?.value;
            const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
            return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
        },
        baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
        includeAnswer: config.includeAnswer ?? TAVILY_DEFAULT_INCLUDE_ANSWER,
        ...config.numResults !== undefined ? { numResults: config.numResults } : {},
    }));
}
//# sourceMappingURL=index.js.map