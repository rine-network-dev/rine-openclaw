/**
 * The single `"default"` profile/account literal, shared so a rename touches one place.
 *
 * It is the rine credential *profile* key passed to core's
 * `getCredentialEntry`/`getOrRefreshToken` (the entry under `.default` in
 * credentials.json) and, identically, the OpenClaw single-account id for the rine
 * channel. Both are `"default"` by convention.
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Internal mcp tools the plugin depends on at runtime but does NOT expose to the agent.
 * Validated at startup (alongside `selectExposedTools`) so a rename of an mcp tool fails
 * fast at load, not at first reply. `rine_reply` backs the inbound→reply dispatch path.
 */
export const INTERNAL_TOOLS = ["rine_reply"] as const;
