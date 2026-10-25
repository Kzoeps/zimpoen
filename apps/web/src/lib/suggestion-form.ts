import { ApiRequestError } from "./api.ts";

/**
 * After a press on Add or Dismiss failed: do the buttons stay off? Only a 409 keeps them off, because it means the other
 * answer was recorded first and its notice is on its way to settle the card; a second tap would be a second answer. Any
 * other failure (the server was unreachable, the suggestion was not found) leaves the owner free to press again.
 */
export function answeredTheOtherWay(failure: unknown): boolean {
	return failure instanceof ApiRequestError && failure.status === 409;
}
