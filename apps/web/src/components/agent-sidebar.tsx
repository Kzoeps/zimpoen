"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useChat } from "./chat-context.tsx";

export function AgentSidebar() {
	const { agents, error } = useChat();
	const pathname = usePathname();

	return (
		<nav className="sidebar" aria-label="Agents">
			<div className="sidebar__brand">Assistant</div>
			<ul className="sidebar__list">
				{agents?.map((agent) => {
					const active = pathname === `/chat/${agent.id}`;
					return (
						<li key={agent.id}>
							<Link
								href={`/chat/${agent.id}`}
								className={`agent${active ? " agent--active" : ""}`}
								aria-current={active ? "page" : undefined}
							>
								<span className="agent__avatar" aria-hidden="true">
									{agent.avatar}
								</span>
								<span className="agent__name">{agent.name}</span>
								{agent.busy ? (
									<span className="agent__busy" role="status" aria-label={`${agent.name} is working`} />
								) : null}
							</Link>
						</li>
					);
				})}
			</ul>
			<Link
				href="/settings"
				className={`agent agent--settings${pathname === "/settings" ? " agent--active" : ""}`}
				aria-current={pathname === "/settings" ? "page" : undefined}
			>
				<span className="agent__avatar" aria-hidden="true">
					⚙️
				</span>
				<span className="agent__name">Settings</span>
			</Link>
			{error !== undefined && agents === undefined ? <p className="sidebar__error">{error}</p> : null}
		</nav>
	);
}
