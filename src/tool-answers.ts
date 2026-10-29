/**
 * What the model already did during the turn an inbound message started: the sends it made through
 * a rine tool, and whether its last answer was the silent token.
 *
 * `deliver` answers a turn with its final text. When the model already answered through
 * `rine_send` or `rine_send_and_wait` (this plugin does not expose `rine_reply`) into the
 * inbound message's conversation, or to its group, that text is a second message the peer stores
 * and pays for. The `after_tool_call` hook records what the model's send tools delivered
 * (`tool-answer-hook.ts`) and `deliver` reads it.
 *
 * Every record belongs to the turn that made it. Two inbound messages from one peer share a
 * session and may run at once, so the session alone cannot say whose send, or whose NO_REPLY, a
 * record is. The host's model runs can: `after_tool_call`, `llm_input` and `llm_output` all carry
 * the run id, and `llm_input`'s prompt is the pointer text naming the inbound message, so
 * `claimRun` binds a run to the turn whose message it was woken for. A record belongs to the turn
 * its run is bound to; failing that, to the turn running alone on the session when the record was
 * made (a run the operator has not opted into `llm_input` for, or one the plugin did not
 * dispatch). A record made while two turns run and bound to neither belongs to nobody: the answer
 * errs toward being delivered, and a model answer of that kind neither silences a turn nor lifts
 * another turn's silence.
 *
 * A turn's records are dropped when it ends, all of them once the last turn on the session ends,
 * and when the first turn on a session starts, so a run the plugin never dispatched cannot silence
 * a later turn. A record older than ten minutes counts for nothing, and the map holds at most a
 * thousand sessions, because the hook sees every session the host runs.
 *
 * The state lives on `globalThis` because the hooks and `deliver` run in different module
 * instances: the hooks belong to the discovery registry's load of this plugin (the one the host's
 * hook runner is built from), `deliver` to the full registry's.
 */
const STATE = Symbol.for("@rine-network/openclaw.toolAnswers.v2");
const TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 1000;

/** One delivered send tool call, and the turn it belongs to when that is known. */
type Send = { owner?: Turn; keys: Set<string>; at: number };

/** A turn running on a session, and the host runs bound to it. */
export type Turn = {
	sessionKey: string;
	marker: string;
	runs: Set<string>;
	/** Whether the model's last answer on a run bound to this turn was the silent token. */
	silent: boolean;
};

type State = { sends: Map<string, Send[]>; turns: Map<string, Turn[]> };

const state = ((globalThis as { [STATE]?: State })[STATE] ??= {
	sends: new Map<string, Send[]>(),
	turns: new Map<string, Turn[]>(),
});

/** The inbound message's place: its conversation, its group when it has one, else its peer. */
export type TurnPlace = { conversationId: string; groupHandle?: string; peerHandle?: string };

/** What a delivered send tool call named. */
export type SendTarget = { conversationId?: string; groupHandle?: string; peerHandle?: string };

const conversationKey = (id: string): string => `conversation:${id}`;
const groupKey = (handle: string): string => `group:${handle.toLowerCase()}`;
const peerKey = (handle: string): string => `peer:${handle.toLowerCase()}`;

/** The words naming an inbound message in the pointer text the model is woken with. */
export const messageMarker = (messageId: string): string => `message ${messageId}`;

/** How many turns are running on the session. */
function turnsRunning(sessionKey: string): number {
	return state.turns.get(sessionKey)?.length ?? 0;
}

/** A turn starts on the session; the first one drops whatever a run nobody dispatched left. */
export function openTurn(sessionKey: string, messageId: string): Turn {
	if (turnsRunning(sessionKey) === 0) state.sends.delete(sessionKey);
	const turn: Turn = { sessionKey, marker: messageMarker(messageId), runs: new Set(), silent: false };
	state.turns.set(sessionKey, [...(state.turns.get(sessionKey) ?? []), turn]);
	return turn;
}

/** A turn ends: its records go with it, and the session's all go once no turn is left. */
export function closeTurn(turn: Turn): void {
	const left = (state.turns.get(turn.sessionKey) ?? []).filter((t) => t !== turn);
	if (left.length === 0) {
		state.turns.delete(turn.sessionKey);
		state.sends.delete(turn.sessionKey);
		return;
	}
	state.turns.set(turn.sessionKey, left);
	const kept = (state.sends.get(turn.sessionKey) ?? []).filter((s) => s.owner !== turn);
	state.sends.set(turn.sessionKey, kept);
}

/** Bind a host run to the one running turn whose message its prompt names. */
export function claimRun(sessionKey: string, runId: string, prompt: string): void {
	const turns = state.turns.get(sessionKey) ?? [];
	if (turns.some((t) => t.runs.has(runId))) return;
	const named = turns.filter((t) => prompt.includes(t.marker));
	if (named.length === 1) named[0]?.runs.add(runId);
}

/** The turn a record made in a host run belongs to: the run's own, else the turn running alone. */
function ownerOf(sessionKey: string, runId: string | undefined): Turn | undefined {
	const turns = state.turns.get(sessionKey) ?? [];
	return turns.find((t) => runId !== undefined && t.runs.has(runId)) ?? (turns.length === 1 ? turns[0] : undefined);
}

/** A model call of a host run ended: its turn is silent if the last thing the model said was the silent token. */
export function recordModelAnswer(sessionKey: string, runId: string | undefined, silent: boolean): void {
	const owner = ownerOf(sessionKey, runId);
	if (owner) owner.silent = silent;
}

/** Record what a delivered send tool call went to, as the newest record, then drop what is stale or past the bound. */
export function recordSend(sessionKey: string, runId: string | undefined, target: SendTarget): void {
	const owner = ownerOf(sessionKey, runId);
	const keys = new Set<string>();
	if (target.conversationId) keys.add(conversationKey(target.conversationId));
	if (target.groupHandle) keys.add(groupKey(target.groupHandle));
	if (target.peerHandle) keys.add(peerKey(target.peerHandle));
	const now = Date.now();
	const sends = (state.sends.get(sessionKey) ?? []).filter((s) => now - s.at <= TTL_MS);
	state.sends.delete(sessionKey);
	state.sends.set(sessionKey, [...sends, { owner, keys, at: now }]);
	for (const [key, held] of state.sends) {
		if (state.sends.size <= MAX_SESSIONS && now - (held.at(-1)?.at ?? 0) <= TTL_MS) break;
		state.sends.delete(key);
	}
}

/** Why a send tool already answered this turn, or undefined when none did. */
export function toolAnswer(turn: Turn, place: TurnPlace): string | undefined {
	const now = Date.now();
	const mine = (state.sends.get(turn.sessionKey) ?? []).filter(
		(s) => s.owner === turn && now - s.at <= TTL_MS,
	);
	const sent = (key: string): boolean => mine.some((s) => s.keys.has(key));
	if (place.groupHandle && sent(groupKey(place.groupHandle))) {
		return `a rine send tool already sent to its group (${place.groupHandle})`;
	}
	if (sent(conversationKey(place.conversationId))) {
		return `a rine send tool already sent into its conversation (${place.conversationId})`;
	}
	if (place.peerHandle && sent(peerKey(place.peerHandle))) {
		return `a rine send tool already sent to its sender (${place.peerHandle})`;
	}
	return undefined;
}
