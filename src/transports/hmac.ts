import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a rine standard-webhook signature: `X-Rine-Signature: sha256=<hex>`,
 * where hex = HMAC-SHA256(rawBody, secret). Constant-time compare.
 */
export function verifyRineSignature(
	rawBody: Buffer | string,
	header: string | undefined,
	secret: string,
): boolean {
	if (!header || !secret) return false;
	const expectedHex = createHmac("sha256", secret)
		.update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
		.digest("hex");
	const expected = `sha256=${expectedHex}`;
	const a = Buffer.from(expected);
	const b = Buffer.from(header);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
