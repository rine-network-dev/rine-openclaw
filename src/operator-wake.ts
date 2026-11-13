/**
 * The wake path's verdict on one inbound: is it the operator's word, an earlier operator
 * message, or another party's.
 *
 * It runs in `deliver`, so a message the retry sweep opened later is classified the same
 * way as a live one. The decision is `rine-core`'s `classifyShown`, the function the
 * tool rows run, so the wake and a later read cannot disagree about one message. A group
 * invite is another party's row whatever signed it, and writes nothing to the ledger. The
 * wake does not show the body, so it does not use up a statement: the read that shows the
 * text does, and a read of ciphertext that differs from the one classified here is data.
 */

import {
	type OperatorVerdict,
	classifyShown,
	openInbound,
} from "@rine-network/core";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { readabilityArgsFor } from "./inbound.js";
import type { RineClient } from "./rine-client.js";
import type { RineConfig, RineInbound } from "./types.js";

export type WakeClassifier = (msg: RineInbound) => Promise<OperatorVerdict>;

export function makeWakeClassifier(deps: {
	client: RineClient;
	config: RineConfig;
	agentId: string;
	logger: PluginLogger;
}): WakeClassifier {
	const { client, config, agentId, logger } = deps;
	const operator = {
		pin: config.operator,
		selfAgentId: agentId,
		configDir: client.configDir,
		now: Date.now,
		warn: (message: string) => logger.warn(`rine: ${message}`),
	};
	return async function classifyWake(msg) {
		// The readability probe already opened this row once. A second open is spent only
		// when a seat could be the sender, so with no pin, or on a group post, the
		// classifier is given no result and answers from the row's shape alone.
		const opened =
			operator.pin === null || msg.isGroup
				? null
				: await openInbound(
						readabilityArgsFor(msg, {
							client: client.client,
							configDir: client.configDir,
							agentId,
						}),
					);
		return classifyShown(operator, msg.type, {
			rowId: msg.id,
			contextOnly: msg.contextOnly,
			fromAgentId: msg.fromAgentId ?? "",
			encryptionVersion: msg.encryptionVersion,
			encryptedPayload: msg.encryptedPayload,
			result: opened?.kind === "opened" ? opened.result : null,
			rendersText: false,
		});
	};
}
