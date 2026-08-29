//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-web-search-tavily`.
* @module @deepseek-ai/dsh-web-search-tavily/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-web-search-tavily";
/** Cordis companion plugin name. */
const name = "web-search-tavily-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this package exposes no independent event sequence or mutable data relation
* beyond contracts enforced at its owning seam.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
