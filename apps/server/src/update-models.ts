import { runUpdateModels } from "./model-catalog.ts";

// `pnpm models:update`: see docs/SETUP.md.
const code = await runUpdateModels({ env: process.env, print: (line) => console.log(line) });
process.exit(code);
