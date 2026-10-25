/**
 * Money as the thread and the tools write it. Everywhere an amount is stored or computed it is an integer count of minor
 * units (chhertum, cents, paise); this file only turns one into text. The server and the web app both use it, so a card
 * and the model's text say "Nu. 1,234.50" the same way.
 */

/** Currencies whose minor unit is not a hundredth (ISO 4217). Every other currency has two decimals. */
const EXPONENT: Readonly<Record<string, number>> = {
	BIF: 0,
	CLP: 0,
	DJF: 0,
	GNF: 0,
	ISK: 0,
	JPY: 0,
	KMF: 0,
	KRW: 0,
	PYG: 0,
	RWF: 0,
	UGX: 0,
	UYI: 0,
	VND: 0,
	VUV: 0,
	XAF: 0,
	XOF: 0,
	XPF: 0,
	BHD: 3,
	IQD: 3,
	JOD: 3,
	KWD: 3,
	LYD: 3,
	OMR: 3,
	TND: 3,
};

/** How many decimals the minor unit of a currency has: 2 for BTN, USD and INR, 0 for JPY, 3 for KWD. */
export const currencyExponent = (currency: string): number => EXPONENT[currency] ?? 2;

/**
 * The largest amount a ledger accepts, in minor units (Nu. 100 billion). It keeps every sum of thousands of entries well
 * inside what a JavaScript number and a SQLite integer hold exactly.
 */
export const MAX_MINOR = 10_000_000_000_000;

/** `1,234.50` for 123450 minor units of a currency with two decimals; no sign, no currency. */
export function formatAmount(minor: number, currency: string): string {
	const exponent = currencyExponent(currency);
	const factor = 10 ** exponent;
	const abs = Math.abs(minor);
	const whole = Math.floor(abs / factor);
	const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return exponent === 0 ? grouped : `${grouped}.${String(abs - whole * factor).padStart(exponent, "0")}`;
}

/** What goes before the amount: `Nu.` for the Ngultrum, the code for everything else (a `$` could be five currencies). */
export const currencyLabel = (currency: string): string => (currency === "BTN" ? "Nu." : currency);

/**
 * `Nu. 1,234.50`, `USD 500.00`, `-Nu. 80.00`. `sign: "always"` also writes the plus of an amount that came in. Always
 * the same wording: tool results, cards and the daily facts all go through it.
 */
export function formatMoney(minor: number, currency: string, options: { sign?: "always" } = {}): string {
	const sign = minor < 0 ? "-" : options.sign === "always" && minor > 0 ? "+" : "";
	return `${sign}${currencyLabel(currency)} ${formatAmount(minor, currency)}`;
}

/** `12.5%` for 125: shares are kept in tenths of a percent, whole numbers, so the arithmetic is never a float's. */
export const formatTenths = (tenths: number): string => `${Math.floor(tenths / 10)}.${tenths % 10}%`;
