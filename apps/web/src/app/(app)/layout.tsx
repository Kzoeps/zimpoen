import type { ReactNode } from "react";
import { ChatShell } from "../../components/chat-shell.tsx";

export default function AppLayout({ children }: { children: ReactNode }) {
	return <ChatShell>{children}</ChatShell>;
}
