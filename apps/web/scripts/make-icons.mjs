// Draws the app icons (a compass needle on the accent colour) and writes them as PNG files, with no image library:
// `node apps/web/scripts/make-icons.mjs`. The output is committed; run this only to change the artwork.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

const ACCENT = [47, 109, 246];
const WHITE = [255, 255, 255];

/** Is (x, y), in a unit square, inside the triangle a-b-c? */
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
	const side = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
	const d1 = side(x, y, ax, ay, bx, by);
	const d2 = side(x, y, bx, by, cx, cy);
	const d3 = side(x, y, cx, cy, ax, ay);
	return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** The needle: a long diamond tilted 45 degrees, its upper half white and its lower half translucent. */
function needle(x, y, scale) {
	const cx = 0.5;
	const cy = 0.5;
	const half = 0.3 * scale;
	const wide = 0.085 * scale;
	// Rotate the point by -45 degrees around the centre, then test against an upright diamond.
	const dx = x - cx;
	const dy = y - cy;
	const u = (dx + dy) * Math.SQRT1_2;
	const v = (dy - dx) * Math.SQRT1_2;
	const top = inTriangle(u, v, [0, -half], [-wide, 0], [wide, 0]);
	const bottom = inTriangle(u, v, [0, half], [-wide, 0], [wide, 0]);
	return top ? 1 : bottom ? 0.55 : 0;
}

/**
 * `shape`: "square" fills the whole canvas (for maskable icons the platform crops it), "rounded" draws a rounded
 * square on a transparent background, "glyph" draws only the white needle on transparent (notification badge).
 */
function render(size, shape, scale) {
	const pixels = Buffer.alloc(size * size * 4);
	const samples = 3;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let sy = 0; sy < samples; sy++) {
				for (let sx = 0; sx < samples; sx++) {
					const x = (px + (sx + 0.5) / samples) / size;
					const y = (py + (sy + 0.5) / samples) / size;
					const ink = needle(x, y, scale);
					let bg = 1;
					if (shape === "rounded") {
						const radius = 0.22;
						const qx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
						const qy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
						bg = Math.hypot(qx, qy) <= radius ? 1 : 0;
					}
					if (shape === "glyph") {
						if (ink > 0) {
							r += 255;
							g += 255;
							b += 255;
							a += 255 * Math.min(ink * 1.4, 1);
						}
						continue;
					}
					if (bg === 0) continue;
					const mix = ink;
					r += ACCENT[0] * (1 - mix) + WHITE[0] * mix;
					g += ACCENT[1] * (1 - mix) + WHITE[1] * mix;
					b += ACCENT[2] * (1 - mix) + WHITE[2] * mix;
					a += 255;
				}
			}
			const n = samples * samples;
			const alpha = a / n;
			const at = (py * size + px) * 4;
			// Colours were summed only over covered samples; divide by the covered share to avoid dark edges.
			const covered = Math.max(alpha / 255, 1e-9) * n;
			pixels[at] = Math.round(r / covered);
			pixels[at + 1] = Math.round(g / covered);
			pixels[at + 2] = Math.round(b / covered);
			pixels[at + 3] = Math.round(alpha);
		}
	}
	return pixels;
}

function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const rows = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y++) {
		rows[y * (size * 4 + 1)] = 0; // no filter
		pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const icons = [
	["icon-192.png", 192, "rounded", 1],
	["icon-512.png", 512, "rounded", 1],
	// Platforms crop a maskable icon to a circle or squircle: keep the artwork inside the central 80%.
	["maskable-512.png", 512, "square", 0.78],
	["badge-96.png", 96, "glyph", 1.25],
];
for (const [name, size, shape, scale] of icons) {
	writeFileSync(join(out, name), png(size, render(size, shape, scale)));
	console.log(`wrote ${name}`);
}
