/**
 * Making the free-form fields of an inbound safe to put in a wake line.
 *
 * `from` and `type` reach this plugin unchecked on the A2A webhook path, and the wake line
 * is the one place the model reads them as plain words beside the plugin's own sentences.
 * The server only ever issues handles and types drawn from a closed character set, so a
 * value outside it is not a handle or a type at all: every character the server would not
 * have issued becomes `_`, and the length is capped. A newline, a bracket or a space cannot
 * survive to close the head early or start a sentence of its own. Handles go through
 * `cleanHandle` in rine-core, which the operator pin compares with too; the type is cleaned here.
 */

/** The longest type shown in a wake line; anything longer is cut. */
const MAX_FIELD_LENGTH = 128;

/** Characters in a message type (`rine.v1.task_request`). */
const OUTSIDE_TYPE = /[^A-Za-z0-9._-]/g;

function clean(value: string, outside: RegExp): string {
	return value.replace(outside, "_").slice(0, MAX_FIELD_LENGTH);
}

/** A message type as it may appear in a wake line. */
export function wakeType(type: string): string {
	return clean(type, OUTSIDE_TYPE);
}
