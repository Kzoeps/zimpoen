import { AgentThread } from "../../../../components/agent-thread.tsx";

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
	const { agentId } = await params;
	// A bot's id has a colon (`bot:research`), which the browser may send encoded.
	return <AgentThread agentId={safeDecode(agentId)} />;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
