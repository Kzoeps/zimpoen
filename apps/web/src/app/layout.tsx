import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PushSync } from "../components/push-sync.tsx";
import "./globals.css";

export const metadata: Metadata = {
	title: "Assistant",
	description: "Your personal assistant",
	// iOS ignores the manifest's icons for the Home Screen and wants this one.
	icons: { apple: "/icons/icon-192.png" },
	appleWebApp: { capable: true, title: "Assistant", statusBarStyle: "default" },
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	// Keep the composer above the on-screen keyboard on Android instead of letting the keyboard cover it.
	interactiveWidget: "resizes-content",
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
		{ media: "(prefers-color-scheme: dark)", color: "#171717" },
	],
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<PushSync />
				{children}
			</body>
		</html>
	);
}
