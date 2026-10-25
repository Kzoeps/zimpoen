import { runConnectGoogle } from "./google/connect.ts";

// `pnpm connect:google`: see docs/setup-google.md.
const code = await runConnectGoogle({
	argv: process.argv.slice(2),
	env: process.env,
	print: (line) => console.log(line),
});
process.exit(code);
