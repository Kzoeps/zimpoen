import { handleShare } from "../../lib/share.ts";

/**
 * The Android share sheet posts here (`share_target` in the manifest). The work is in `lib/share.ts`, where it can be
 * tested; this file only supplies the server's address and `fetch`.
 */
export async function POST(request: Request): Promise<Response> {
	return await handleShare(request, {
		apiOrigin: process.env.ASSISTANT_API_ORIGIN ?? "http://127.0.0.1:3001",
		fetch,
	});
}
