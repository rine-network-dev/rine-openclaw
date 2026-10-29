import { vi } from "vitest";

// The channel answers a woken turn with the turn's final text. The dispatch helper and the
// outbound senders are mocked, so the suites play the host's part: they fire the hooks for what
// the model did and then call `deliver` with the final text. This module holds the mocks and is
// imported before anything that loads the dispatcher, so they are in place when it does.

export type DeliverFn = (payload: { text?: string }) => Promise<void>;

/** What each inbound message's turn does once the host wakes it, by message id. */
export const turns = new Map<string, (deliver: DeliverFn) => Promise<void>>();

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: { messageId: string; deliver: DeliverFn }) =>
		turns.get(params.messageId)?.(params.deliver),
}));

/** Message ids a final text was sent back to, as a 1:1 reply. */
export const replySpy = vi.fn(async (_messageId: string) => ({}));
export const textSpy = vi.fn(async () => ({ messageId: "srv-1" }));
vi.mock("../src/outbound.js", () => ({
	sendRineReply: (_client: unknown, msg: { id: string }) => replySpy(msg.id),
	sendRineText: (...args: unknown[]) => textSpy(...(args as [])),
}));
