/**
 * One question every catch block in this package asks: what do I put in the log
 * line?
 *
 * Its own leaf module because three files need it and none of them is a natural
 * home for the other two: `dispatch.ts` (the inbound path), `runtime-dispatch.ts`
 * (the agent-turn path, which imported it FROM `dispatch.ts` and so imported the
 * whole dispatch graph for four lines) and `sidecar.ts` (the durable stores,
 * which had its own private copy). A leaf with no imports can be reached by all
 * three without any of them growing a dependency on the others.
 *
 * Moved here unchanged, deliberately: the two copies were byte-identical, and a
 * "while I'm here" improvement to the text would edit log lines two suites assert
 * on in the same breath as a refactor.
 */

/** A human message from an unknown throwable. */
export function msgOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
