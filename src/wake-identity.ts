/**
 * Who a wake line says an inbound is from, the key its session lives under, and where its
 * answer is said to go.
 *
 * The handle on an inbound is not covered by the sender's signature, so it is a label and
 * never evidence. For the operator's own message every one of these comes from the pin the
 * channel was configured with. For anyone else it comes from the sanitised handle, except
 * that a handle written like the console seat's (the pinned seat handle, or the local part
 * `ops`) shows the sender's agent id instead: a stranger named `ops@somewhere` must not read as the operator, and
 * the seat's own message that did not earn operator class must not read as one either.
 */

import {
	cleanHandle,
	looksLikeSeat,
	type OperatorPin,
	type OperatorVerdict,
} from "@rine-network/core";
import type { RineInbound } from "./types.js";

/** A sender as the wake presents it. */
export interface WakeSender {
	/** The one-token identity: session peer, sender id and sender address. */
	id: string;
	/** What a model reads after "from" and "back to". */
	label: string;
}

/** The sender a wake line names for `msg`, given the verdict on it and the configured pin. */
export function wakeSender(
	msg: RineInbound,
	verdict: OperatorVerdict,
	pin: OperatorPin | null,
): WakeSender {
	if (verdict.senderClass !== "other" && pin !== null) {
		return { id: pin.agentId, label: `your operator (${pin.agentId})` };
	}
	const handle = cleanHandle(msg.fromHandle);
	const id =
		looksLikeSeat(pin, handle) ? cleanHandle(msg.fromAgentId ?? "unknown") : handle;
	return { id, label: id };
}
