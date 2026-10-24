"use client";

import { createContext, useContext } from "react";
import type { ThreadStore } from "../lib/thread-store.ts";
import type { AgentsState } from "../lib/use-agents.ts";

export type ChatContextValue = AgentsState & { store: ThreadStore };

export const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function useChat(): ChatContextValue {
	const value = useContext(ChatContext);
	if (value === undefined) throw new Error("useChat() must be used inside <ChatShell>.");
	return value;
}
