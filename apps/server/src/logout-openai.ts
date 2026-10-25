import { runLogoutOpenAI } from "./login/openai.ts";

// `pnpm logout:openai`: removes the saved sign-in.
const code = await runLogoutOpenAI({
	argv: process.argv.slice(2),
	env: process.env,
	print: (line) => console.log(line),
});
process.exit(code);
