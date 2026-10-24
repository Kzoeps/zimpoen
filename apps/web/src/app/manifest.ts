import type { MetadataRoute } from "next";

/**
 * What makes the assistant installable ("Add to Home screen" on Android, "Add to Dock" on a laptop) and, on iPhone,
 * what lets Web Push work at all: iOS only delivers notifications to an installed web app.
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Assistant",
		short_name: "Assistant",
		description: "Your personal assistant",
		start_url: "/chat/pa",
		scope: "/",
		display: "standalone",
		background_color: "#171717",
		theme_color: "#171717",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
			{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
