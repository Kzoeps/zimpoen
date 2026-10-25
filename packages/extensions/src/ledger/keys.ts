/**
 * What two spellings of a name have in common: lower case, accents dropped, letters and digits of any script, single
 * spaces. `Phone/Internet`, `phone internet` and `PHONE  INTERNET` are one key. Accounts, categories and merchants are
 * matched by it, so the owner never has to type a name exactly. Only the marks that decorate a Latin, Greek or Cyrillic
 * letter go (`é`, `ñ`, `ö`); the vowel signs of Devanagari or Tibetan are part of the word, and "किरण" and "करण" are two names.
 */
export const nameKey = (text: string): string =>
	text
		.normalize("NFKD")
		.replace(/(?<=[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]\p{M}*)\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
		.trim();

/**
 * A merchant's key without the words that only tell one charge from the next (an order number, the last digits of a
 * card): `DRUK MART 123456` and `Druk Mart 98765` are one merchant. Words with three or more digits are dropped; when
 * nothing is left the plain key stays.
 */
export function merchantKey(text: string): string {
	const key = nameKey(text);
	const kept = key.split(" ").filter((word) => (word.match(/\d/g)?.length ?? 0) < 3);
	return kept.length === 0 ? key : kept.join(" ");
}
