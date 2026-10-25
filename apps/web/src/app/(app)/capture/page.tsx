import { Suspense } from "react";
import { CaptureView } from "../../../components/capture-view.tsx";

/**
 * Where "Share → Assistant" on Android ends up (`/share` stores the files and redirects here). `useSearchParams` needs a
 * Suspense boundary: the page itself is built ahead of time, without knowing what will be shared.
 */
export default function CapturePage() {
	return (
		<Suspense fallback={<p className="placeholder">Loading…</p>}>
			<CaptureView />
		</Suspense>
	);
}
