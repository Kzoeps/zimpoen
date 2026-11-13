import { chmod, rm, stat } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { CredBroker, CredRunRequest, CredRunResult } from "./broker.ts";

/**
 * The wire between the server and the separate `zimpoen-broker` process (plan §9): one request per connection, each
 * direction one line of JSON ended by `\n`. Sizes and times are capped on both ends, so a stuck or hostile peer can't
 * hold the other one.
 *
 *   → {"v":1,"op":"policy"}                ← {"ok":true,"policy":"<policy JSON text>"}
 *   → {"v":1,"op":"run","req":{...}}       ← {"ok":true,"result":{exitCode,output,redacted}}
 *   any error                              ← {"ok":false,"error":"<message for the model or the log>"}
 */
export const PROTOCOL_VERSION = 1;
/** A request is names and a few parameters: 64 KiB is far more than any policy allows. */
export const MAX_REQUEST_BYTES = 64 * 1024;
/** Output is capped at 1 MiB by the policy; JSON escaping can grow it up to 6x. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** How long the broker waits for a client to send its whole request line. */
export const REQUEST_READ_TIMEOUT_MS = 5_000;
/** Concurrent connections the broker serves; more are refused at once. */
export const MAX_CONNECTIONS = 8;

type Response = { ok: true; policy: string } | { ok: true; result: CredRunResult } | { ok: false; error: string };

export type BrokerSocketServerDeps = {
	broker: CredBroker;
	/** The policy text the server's tools decide with. The broker reads it; the server never needs the file. */
	policyText: string;
	warn?: (message: string) => void;
};

/**
 * Listen on `socketPath`. Who may connect is decided by file permissions: Node has no SO_PEERCRED, so the socket's
 * directory must not be reachable by others (see {@link checkSocketDirectory}) and the socket itself is made 0660.
 */
export async function listenBrokerSocket(socketPath: string, deps: BrokerSocketServerDeps): Promise<Server> {
	await checkSocketDirectory(dirname(socketPath));
	await rm(socketPath, { force: true }); // a socket left by a crashed broker; the directory is ours alone
	const server = createServer((socket) => serveConnection(socket, deps));
	server.maxConnections = MAX_CONNECTIONS;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	await chmod(socketPath, 0o660);
	return server;
}

/**
 * The directory holding the socket is the access check, so refuse to start when others can enter it. Group access is
 * how the server's user gets in (it is a member of the broker's group, docs/OPS.md "Broker").
 */
export async function checkSocketDirectory(dir: string): Promise<void> {
	let mode: number;
	try {
		mode = (await stat(dir)).mode;
	} catch (error) {
		throw new Error(
			`The broker socket directory ${dir} does not exist (${reason(error)}). With systemd, RuntimeDirectory= makes it; otherwise: install -d -m 0750 ${dir}`,
		);
	}
	if ((mode & 0o007) !== 0) {
		throw new Error(
			`The broker socket directory ${dir} is open to other users (mode ${(mode & 0o777).toString(8)}): anyone could ask the broker to run actions. Run: chmod 0750 ${dir}`,
		);
	}
}

function serveConnection(socket: Socket, deps: BrokerSocketServerDeps): void {
	socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => socket.destroy());
	socket.on("error", () => {});
	readLine(socket, MAX_REQUEST_BYTES).then(
		async (line) => {
			socket.setTimeout(0); // the run itself is bounded by the action's own timeout
			const response = await handle(line, deps);
			socket.end(`${JSON.stringify(response)}\n`);
		},
		(error: unknown) => {
			deps.warn?.(`[broker] dropped a connection: ${reason(error)}`);
			if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: reason(error) })}\n`);
		},
	);
}

async function handle(line: string, deps: BrokerSocketServerDeps): Promise<Response> {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return { ok: false, error: "The request is not JSON." };
	}
	if (!isRecord(message) || message.v !== PROTOCOL_VERSION) {
		return { ok: false, error: `Unsupported protocol version; this broker speaks v${PROTOCOL_VERSION}.` };
	}
	if (message.op === "policy") return { ok: true, policy: deps.policyText };
	if (message.op !== "run") return { ok: false, error: `Unknown operation '${String(message.op)}'.` };
	const req = parseRunRequest(message.req);
	if (typeof req === "string") return { ok: false, error: req };
	try {
		return { ok: true, result: await deps.broker.run(req) };
	} catch (error) {
		return { ok: false, error: reason(error) };
	}
}

/** The request as the broker accepts it, or why not. Every field is a string; nothing else passes through. */
function parseRunRequest(value: unknown): CredRunRequest | string {
	if (!isRecord(value)) return "The run request is missing.";
	const { project, credId, action, params, approvalId, callId } = value;
	if (typeof project !== "string" || typeof credId !== "string" || typeof action !== "string") {
		return "The run request needs project, credId and action as text.";
	}
	if (!isRecord(params) || !Object.values(params).every((v) => typeof v === "string")) {
		return "The run request's params must map names to text.";
	}
	for (const [name, v] of [
		["approvalId", approvalId],
		["callId", callId],
	] as const) {
		if (v !== undefined && typeof v !== "string") return `The run request's ${name} must be text.`;
	}
	return {
		project,
		credId,
		action,
		params: params as Record<string, string>,
		...(typeof approvalId === "string" ? { approvalId } : {}),
		...(typeof callId === "string" ? { callId } : {}),
	};
}

export type SocketBrokerOptions = {
	socketPath: string;
	/** How long one run may take end to end. The server passes the action's timeout plus a margin. */
	timeoutMs: (req: CredRunRequest) => number;
};

/** The server's side: a {@link CredBroker} that asks the broker process over its socket. */
export function createSocketBroker(options: SocketBrokerOptions): CredBroker {
	return {
		async run(req) {
			const response = await call(options.socketPath, { v: PROTOCOL_VERSION, op: "run", req }, options.timeoutMs(req));
			if (!("result" in response) || !isResult(response.result)) {
				throw new Error("The broker sent a reply without a result.");
			}
			return response.result;
		},
	};
}

/** The policy text the broker runs with. Used once at server start. */
export async function fetchBrokerPolicy(socketPath: string, timeoutMs = 5_000): Promise<string> {
	const response = await call(socketPath, { v: PROTOCOL_VERSION, op: "policy" }, timeoutMs);
	if (!("policy" in response) || typeof response.policy !== "string") {
		throw new Error("The broker sent a reply without its policy.");
	}
	return response.policy;
}

async function call(socketPath: string, message: object, timeoutMs: number): Promise<Exclude<Response, { ok: false }>> {
	const line = await new Promise<string>((resolve, reject) => {
		const socket = connect(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`The broker at ${socketPath} did not answer within ${timeoutMs} ms.`));
		}, timeoutMs);
		const fail = (error: unknown): void => {
			clearTimeout(timer);
			socket.destroy();
			reject(
				new Error(
					`Cannot reach the broker at ${socketPath} (${reason(error)}). Is zimpoen-broker running, and is this user in its group?`,
				),
			);
		};
		socket.once("error", fail);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(message)}\n`);
			readLine(socket, MAX_RESPONSE_BYTES).then((text) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(text);
			}, fail);
		});
	});
	let response: unknown;
	try {
		response = JSON.parse(line);
	} catch {
		throw new Error("The broker's reply is not JSON.");
	}
	if (!isRecord(response) || typeof response.ok !== "boolean") throw new Error("The broker's reply is malformed.");
	if (!response.ok) throw new Error(typeof response.error === "string" ? response.error : "The broker refused.");
	return response as Exclude<Response, { ok: false }>;
}

/** Read up to the first `\n`. Rejects past `maxBytes`, or when the peer closes first. */
function readLine(socket: Socket, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		const onData = (chunk: Buffer): void => {
			const newline = chunk.indexOf(0x0a);
			const part = newline === -1 ? chunk : chunk.subarray(0, newline);
			size += part.length;
			if (size > maxBytes) {
				done();
				reject(new Error(`The message is larger than ${maxBytes} bytes.`));
				return;
			}
			chunks.push(part);
			if (newline !== -1) {
				done();
				resolve(Buffer.concat(chunks).toString("utf8"));
			}
		};
		const onEnd = (): void => {
			done();
			reject(new Error("The connection closed before a whole message arrived."));
		};
		const onError = (error: Error): void => {
			done();
			reject(error);
		};
		const done = (): void => {
			socket.off("data", onData);
			socket.off("end", onEnd);
			socket.off("error", onError);
		};
		socket.on("data", onData);
		socket.on("end", onEnd);
		socket.on("error", onError);
	});
}

function isResult(value: unknown): value is CredRunResult {
	return (
		isRecord(value) &&
		typeof value.exitCode === "number" &&
		typeof value.output === "string" &&
		typeof value.redacted === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
