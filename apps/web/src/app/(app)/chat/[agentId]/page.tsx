import { AgentThread } from "../../../../components/agent-thread.tsx";

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
	const { agentId } = await params;
	return <AgentThread agentId={agentId} />;
}
