import { decodeEntities } from "./html-text.ts";
import type { HttpClient } from "./http.ts";

export type SearchResult = { title: string; url: string; snippet: string };

/** Where a search goes. DuckDuckGo needs no key; Brave is used when the owner saved a key. */
export type SearchProvider = { name: string; search(query: string, count: number): Promise<SearchResult[]> };

const strip = (html: string): string =>
	decodeEntities(html.replace(/<[^>]+>/g, ""))
		.replace(/\s+/g, " ")
		.trim();

/** DuckDuckGo's HTML endpoint. It needs no key; its markup is what is parsed, so a change there shows up as no results. */
export function duckDuckGo(http: HttpClient): SearchProvider {
	return {
		name: "DuckDuckGo",
		async search(query, count) {
			const response = await http({
				method: "POST",
				url: "https://html.duckduckgo.com/html/",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
				maxBytes: 2 * 1024 * 1024,
			});
			if (response.status !== 200) throw new Error(`DuckDuckGo answered HTTP ${response.status}. Try again shortly.`);
			return parseDuckDuckGo(new TextDecoder().decode(response.body)).slice(0, count);
		},
	};
}

export function parseDuckDuckGo(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const blocks = html.split(/class="result__body"|class="result results_links/).slice(1);
	for (const block of blocks) {
		const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (link === null) continue;
		const url = realUrl(decodeEntities(link[1] ?? ""));
		if (url === undefined || /duckduckgo\.com\/y\.js/.test(url)) continue; // ads
		const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
		results.push({ title: strip(link[2] ?? ""), url, snippet: strip(snippet) });
	}
	return results;
}

/** DuckDuckGo sometimes links through `//duckduckgo.com/l/?uddg=<the real URL>`. */
function realUrl(href: string): string | undefined {
	try {
		const url = new URL(href, "https://duckduckgo.com");
		const target = url.hostname.endsWith("duckduckgo.com") ? url.searchParams.get("uddg") : undefined;
		return target ?? url.toString();
	} catch {
		return undefined;
	}
}

/** Brave Search API, with the owner's key. */
export function brave(http: HttpClient, apiKey: string): SearchProvider {
	return {
		name: "Brave",
		async search(query, count) {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));
			const response = await http({
				url: url.toString(),
				headers: { accept: "application/json", "x-subscription-token": apiKey },
				maxBytes: 2 * 1024 * 1024,
			});
			if (response.status === 401 || response.status === 403) {
				throw new Error("Brave refused the search key. Check BRAVE_API_KEY in <data>/secrets/search.json.");
			}
			if (response.status !== 200) throw new Error(`Brave answered HTTP ${response.status}. Try again shortly.`);
			const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (parsed.web?.results ?? [])
				.filter((item) => typeof item.url === "string")
				.map((item) => ({
					title: strip(item.title ?? ""),
					url: item.url as string,
					snippet: strip(item.description ?? ""),
				}));
		},
	};
}
