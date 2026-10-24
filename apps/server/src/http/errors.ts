import type { ApiErrorBody, ApiErrorCode } from "@assistant/shared";
import { SessionFailed } from "@earendil-works/pi-durable";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error with a status and a stable code the client can switch on. The message says what to do next. */
export class ApiError extends Error {
	readonly status: ContentfulStatusCode;
	readonly code: ApiErrorCode;

	constructor(status: ContentfulStatusCode, code: ApiErrorCode, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export const invalidRequest = (message: string) => new ApiError(400, "invalid_request", message);
export const notFound = (message: string) => new ApiError(404, "not_found", message);

export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
	return { error: { code, message } };
}

export type ErrorLogger = Pick<Console, "error">;

export function errorHandler(logger: ErrorLogger): ErrorHandler {
	return (error, c) => {
		if (error instanceof ApiError) return c.json(errorBody(error.code, error.message), error.status);
		if (error instanceof SessionFailed) {
			logger.error("[http] Durable session failed:", error);
			return c.json(
				errorBody("unavailable", "The assistant's storage failed and it is restarting. Try again in a few seconds."),
				503,
			);
		}
		logger.error(`[http] ${c.req.method} ${c.req.path} failed:`, error);
		return c.json(
			errorBody("internal_error", "The server hit an unexpected error. The details are in the server log."),
			500,
		);
	};
}

export const notFoundHandler: NotFoundHandler = (c) =>
	c.json(errorBody("not_found", `No route for ${c.req.method} ${c.req.path}. The API lives under /api.`), 404);
