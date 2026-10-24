import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import type { AuthConfig } from "../config.ts";
import { ApiError } from "./errors.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const OWNER_HEADER = "Tailscale-User-Login";

/**
 * PLAN §5.5: Tailscale Serve proxies to this server from the same machine and names the signed-in user in
 * `Tailscale-User-Login`. Only the owner may call the API.
 *
 * Both checks matter. The server listens on loopback only, so the address check holds by construction; it guards against
 * a later change of the bind address. The header is trusted only because nothing but Tailscale Serve can reach loopback
 * from outside this machine. With `ASSISTANT_AUTH=off` (local development) every request is allowed.
 */
export function authMiddleware(auth: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		if (auth.mode === "off") return next();

		const address = getConnInfo(c).remote.address;
		if (address === undefined || !LOOPBACK.has(address)) {
			throw new ApiError(
				401,
				"unauthorized",
				"This API only accepts requests that arrive through Tailscale Serve on this machine.",
			);
		}
		const login = c.req.header(OWNER_HEADER);
		if (login === undefined || login.trim() === "") {
			throw new ApiError(
				401,
				"unauthorized",
				`The ${OWNER_HEADER} header is missing. Open the assistant through its Tailscale Serve address, not directly.`,
			);
		}
		if (login.trim().toLowerCase() !== auth.ownerLogin.toLowerCase()) {
			throw new ApiError(401, "unauthorized", `${login.trim()} is not allowed to use this assistant.`);
		}
		return next();
	};
}
