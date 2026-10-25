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
		// "Share → Assistant" on Android: the share sheet posts the title, text, link and files to /share, which stores the
		// files and opens the capture page. The service worker has no fetch handler, so the post reaches the route as it is.
		share_target: {
			action: "/share",
			method: "POST",
			enctype: "multipart/form-data",
			params: {
				title: "title",
				text: "text",
				url: "url",
				files: [
					{
						name: "files",
						accept: [
							"image/png",
							"image/jpeg",
							"image/gif",
							"image/webp",
							"application/pdf",
							"text/csv",
							"text/plain",
							".csv",
							".txt",
							".md",
						],
					},
				],
			},
		},
		background_color: "#171717",
		theme_color: "#171717",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
			{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
