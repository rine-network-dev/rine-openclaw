import type { PluginLogger } from "openclaw/plugin-sdk";
import type { OnMessage } from "../dispatch.js";
import type { RineClient } from "../rine-client.js";
import type { RineConfig } from "../types.js";

/** Everything a transport needs. Built once by the notify service. */
export interface TransportContext {
	client: RineClient;
	config: RineConfig;
	agentId: string;
	logger: PluginLogger;
	/** Shared dedupe + mark-after-success dispatch path. */
	onMessage: OnMessage;
	/** Service-owned abort signal (created in start, aborted in stop). */
	signal: AbortSignal;
	/** Poll token URL from credentials.json (`.default.poll_url`). */
	pollUrl?: string;
}
