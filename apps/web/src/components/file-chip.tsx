import { formatSize } from "@assistant/shared";
import { fileUrl } from "../lib/api.ts";
import type { UiAttachment } from "../lib/ui-messages.ts";

/** A file as a chip: a small picture for an image, an icon and the name otherwise; it opens the stored file. */
export function FileChip({
	file,
}: {
	file: Pick<UiAttachment, "id" | "name" | "mime"> & { sizeText?: string; size?: number };
}) {
	const size = file.sizeText ?? (file.size === undefined ? "" : formatSize(file.size));
	const isImage = file.mime.startsWith("image/");
	return (
		<a
			className="file-chip"
			href={fileUrl(file.id)}
			target="_blank"
			rel="noreferrer"
			title={`${file.name} · ${file.mime}`}
		>
			{isImage ? (
				// biome-ignore lint/performance/noImgElement: a stored upload served by the assistant's own API, at its natural size
				<img className="file-chip__thumb" src={fileUrl(file.id)} alt="" loading="lazy" />
			) : (
				<span className="file-chip__icon" aria-hidden="true">
					{file.mime === "application/pdf" ? "📕" : file.mime === "text/csv" ? "📊" : "📄"}
				</span>
			)}
			<span className="file-chip__name">{file.name}</span>
			{size !== "" ? <span className="card__muted file-chip__size">{size}</span> : null}
		</a>
	);
}
