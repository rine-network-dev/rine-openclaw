/** ~3× the server heartbeat (~30s): no bytes for this long => dead socket, reconnect. */
const IDLE_TIMEOUT_MS = 90_000;

export interface SseEvent {
	event: string;
	id?: string;
	data: string;
}

/** Parse a complete SSE event block (lines split on `\n`). */
export function parseSseBlock(block: string): SseEvent | undefined {
	let event = "message";
	let id: string | undefined;
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue; // comment
		const idx = line.indexOf(":");
		const field = idx === -1 ? line : line.slice(0, idx);
		const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") dataLines.push(value);
	}
	if (dataLines.length === 0 && !id) return undefined;
	return { event, id, data: dataLines.join("\n") };
}

/**
 * `reader.read()` with an idle watchdog: if no chunk arrives within `IDLE_TIMEOUT_MS`,
 * cancel the reader and throw so the reconnect loop takes over (a silently-dead socket
 * never surfaces a `done`). Resets on every chunk because each call starts a fresh timer.
 */
export async function readWithIdleWatchdog(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const idle = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			void reader.cancel().catch(() => {});
			reject(new Error(`SSE idle timeout (${IDLE_TIMEOUT_MS}ms, no bytes)`));
		}, IDLE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([reader.read(), idle]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
