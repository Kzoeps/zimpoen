// A stand-in for pi-web-access's MCP server: answers web_search with the process id, and exits after a call when its
// argument says so, as a crash would. Tests check that the client starts a new one.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-web", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const args = (request.params.arguments ?? {}) as { query?: string };
	if (args.query === "crash") setTimeout(() => process.exit(1), 10);
	return { content: [{ type: "text", text: `pid ${process.pid} env ${process.env.FAKE_KEY ?? "-"}` }] };
});
await server.connect(new StdioServerTransport());
