import { createInterface } from "node:readline/promises";
import { runConnectGoogle } from "./google/connect.ts";

// `pnpm connect:google`: see docs/setup-google.md.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = await runConnectGoogle({
	argv: process.argv.slice(2),
	env: process.env,
	print: (line) => console.log(line),
	ask: (question, signal) => rl.question(question, { signal }),
});
rl.close();
process.exit(code);
