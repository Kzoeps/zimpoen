import { createInterface } from "node:readline/promises";
import { runLoginOpenAI } from "./login/openai.ts";

// `pnpm login:openai`: see docs/SETUP.md.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = await runLoginOpenAI({
	argv: process.argv.slice(2),
	env: process.env,
	print: (line) => console.log(line),
	ask: (question, signal) => rl.question(question, signal === undefined ? {} : { signal }),
});
rl.close();
process.exit(code);
