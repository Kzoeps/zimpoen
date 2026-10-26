import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Outbound HTTP for the web tools, to the public internet only. The address is checked where the connection is made (the
 * socket's own DNS lookup), so a name that resolves to a public address when checked and a private one when used (DNS
 * rebinding) is still refused, and so is every redirect hop. "Private" is the server itself, the home network and the
 * tailnet: the assistant must never be a way to reach the services next to it.
 */

/** Addresses that are not the public internet. */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10], // carrier-grade NAT, which is also where Tailscale puts the tailnet
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
	["64:ff9b::", 96],
	["2001:db8::", 32],
] as const) {
	PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** Is this IP address on the public internet? An IPv4 address written as IPv6 is judged as IPv4. */
export function isPublicAddress(address: string): boolean {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (mapped !== undefined) return isPublicAddress(mapped);
	const family = isIP(address);
	if (family === 0) return false;
	return !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Host names that are never public, whatever they resolve to. */
const PRIVATE_NAMES = /(^|\.)(localhost|local|internal|lan|home|ts\.net|home\.arpa)$/i;

export class BlockedAddress extends Error {
	constructor(what: string) {
		super(`${what} is not on the public internet, and the assistant only reads public web pages.`);
		this.name = "BlockedAddress";
	}
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `dns.lookup` that refuses to hand a private address to the socket. */
function publicLookup(hostname: string, options: object, callback: LookupCallback): void {
	dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error !== null) return callback(error, []);
		const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
		if (blocked !== undefined || addresses.length === 0) {
			return callback(new BlockedAddress(`${hostname} (${blocked?.address ?? "no address"})`), []);
		}
		const all = (options as { all?: boolean }).all === true;
		if (all) return callback(null, addresses);
		const first = addresses[0] as LookupAddress;
		return callback(null, first.address, first.family);
	});
}

export type HttpResponse = { url: string; status: number; contentType: string; body: Uint8Array; truncated: boolean };

export type HttpRequest = {
	method?: "GET" | "POST";
	url: string;
	headers?: Record<string, string>;
	body?: string;
	/** Bytes kept from the body; the rest is dropped and `truncated` is set. */
	maxBytes: number;
	timeoutMs?: number;
};

/** What the web tools send requests through. Tests give a fake one. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
export const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

/** Parse and check a URL the model gave: http or https, a public-looking host, no credentials in it. */
export function checkUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`'${raw.slice(0, 200)}' is not a URL. Give a full address starting with https://.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Only http and https pages can be read, not ${url.protocol} addresses.`);
	}
	if (url.username !== "" || url.password !== "") throw new Error("A URL with a user name or password is refused.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (PRIVATE_NAMES.test(host) || (isIP(host) !== 0 && !isPublicAddress(host))) throw new BlockedAddress(host);
	return url;
}

/** The real client: Node's http(s) with the public-only lookup, redirects followed by hand and checked each time. */
export const publicHttp: HttpClient = async (request) => {
	let url = checkUrl(request.url);
	let method = request.method ?? "GET";
	let body = request.body;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await once(url, method, body, request);
		const location = response.redirect;
		if (location === undefined) return response.result;
		url = checkUrl(new URL(location, url).toString());
		// 303, and in practice 301/302 after a POST, become a GET.
		method = "GET";
		body = undefined;
	}
	throw new Error(`More than ${MAX_REDIRECTS} redirects.`);
};

function once(
	url: URL,
	method: "GET" | "POST",
	body: string | undefined,
	request: HttpRequest,
): Promise<{ redirect?: string; result: HttpResponse }> {
	const send = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = send(
			url,
			{
				method,
				lookup: publicLookup as never,
				headers: {
					"user-agent": USER_AGENT,
					accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.5",
					"accept-language": "en",
					...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
					...request.headers,
				},
				timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			},
			(res: IncomingMessage) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location !== undefined) {
					res.resume();
					return resolve({ redirect: res.headers.location, result: empty(url, status) });
				}
				const chunks: Buffer[] = [];
				let size = 0;
				let truncated = false;
				res.on("data", (chunk: Buffer) => {
					if (size >= request.maxBytes) {
						truncated = true;
						res.destroy();
						return;
					}
					const room = request.maxBytes - size;
					chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
					size += Math.min(chunk.length, room);
					if (chunk.length > room) truncated = true;
				});
				const done = () =>
					resolve({
						result: {
							url: url.toString(),
							status,
							contentType: String(res.headers["content-type"] ?? ""),
							body: new Uint8Array(Buffer.concat(chunks)),
							truncated,
						},
					});
				res.on("end", done);
				res.on("close", done);
				res.on("error", (error) => (truncated ? done() : reject(error)));
			},
		);
		req.on("timeout", () => req.destroy(new Error(`${url.host} did not answer within the time limit.`)));
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const empty = (url: URL, status: number): HttpResponse => ({
	url: url.toString(),
	status,
	contentType: "",
	body: new Uint8Array(),
	truncated: false,
});
