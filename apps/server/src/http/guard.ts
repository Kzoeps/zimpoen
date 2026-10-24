import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";

/**
 * Browser-facing request checks, applied to every API request in both authentication modes.
 *
 * 1. `Host` must be a name this server is meant to answer to. Without it, a web page whose DNS name is re-pointed at
 *    127.0.0.1 ("DNS rebinding") is same-origin with this API from the browser's point of view and can read and call
 *    everything, with or without a valid identity header. The Next dev proxy rewrites `Host` to the API's own address,
 *    so `X-Forwarded-Host`, which it sets to what the browser used, is checked too when it is present.
 * 2. A browser that marks a state-changing request as coming from another site (`Sec-Fetch-Site`) is refused. This
 *    complements the JSON content-type rule in `validation.ts`, which is what protects browsers that do not send the
 *    header.
 *
 * The full rule, and what it means for M2 uploads, is in `docs/design-notes.md`.
 */

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type HostPolicy = {
	/**
	 * Is this the `Host` header of a request meant for this server? A request without one passes: HTTP/1.1 requires the
	 * header (Node answers 400 without it) and every browser sends it, so only an HTTP/1.0 client from this machine
	 * can omit it, and that is not the DNS-rebinding case this check exists for.
	 */
	allows(host: string | undefined): boolean;
	/** Is this `X-Forwarded-Host` (one or more comma-separated hosts) a name this server is meant to be reached by? */
	allowsForwarded(forwarded: string): boolean;
	/** The accepted `Host` values, for error messages. */
	list(): string[];
};

/**
 * `port` is the port the server is actually listening on. `publicHosts` are the names the owner reaches it by through
 * Tailscale Serve (`ASSISTANT_PUBLIC_HOST`): compared exactly as written, so one without a port matches the `Host`
 * header of a request on the default HTTPS port.
 */
export function createHostPolicy(port: number, publicHosts: readonly string[]): HostPolicy {
	const accepted = [...LOOPBACK_NAMES.map((name) => `${name}:${port}`), ...publicHosts.map(normalize)];
	const names = new Set([...LOOPBACK_NAMES, ...publicHosts.map((host) => hostnameOf(normalize(host)))]);
	return {
		allows: (host) => host === undefined || accepted.includes(normalize(host)),
		allowsForwarded: (forwarded) => forwarded.split(",").every((host) => names.has(hostnameOf(normalize(host)))),
		list: () => accepted,
	};
}

export function requestGuard(policy: HostPolicy): MiddlewareHandler {
	const refuseHost = (host: string): ApiError =>
		new ApiError(
			403,
			"forbidden",
			`This server does not answer to the host '${shorten(host)}'. It serves ${policy.list().join(", ")}. ` +
				"If you open the assistant through Tailscale Serve, set ASSISTANT_PUBLIC_HOST to that host name and restart.",
		);

	return async (c, next) => {
		const host = c.req.header("host");
		if (!policy.allows(host)) throw refuseHost(host ?? "");
		const forwarded = c.req.header("x-forwarded-host");
		if (forwarded !== undefined && !policy.allowsForwarded(forwarded)) throw refuseHost(forwarded);

		const site = c.req.header("sec-fetch-site");
		if (STATE_CHANGING.has(c.req.method) && site !== undefined && site !== "same-origin" && site !== "none") {
			throw new ApiError(
				403,
				"forbidden",
				`Refused a ${c.req.method} that the browser marked as coming from another site (Sec-Fetch-Site: ${shorten(site)}). ` +
					"Use the assistant from its own address.",
			);
		}
		await next();
	};
}

const normalize = (host: string): string => host.trim().toLowerCase();

/** `[::1]:3000` is `[::1]`, `a.example:80` is `a.example`. */
function hostnameOf(host: string): string {
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end === -1 ? host : host.slice(0, end + 1);
	}
	const colon = host.lastIndexOf(":");
	return colon === -1 ? host : host.slice(0, colon);
}

const shorten = (value: string): string => (value.length > 80 ? `${value.slice(0, 80)}…` : value);
