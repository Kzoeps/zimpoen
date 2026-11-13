import type { AgentId, AnyAgentId } from "@assistant/shared";
import type { CSSProperties, ReactElement } from "react";

/*
 * Each agent is a flat shape with two white eyes (after Grok Bot's avatars), dressed as a ninja: every one wears the
 * Akatsuki robe (black, high collar, red clouds) and either a forehead protector or a straw hat. The avatar is also the
 * working indicator: it bounces and blinks while the agent runs, instead of three dots.
 */

type Look = {
	color: string;
	/** The body, drawn in a 64 x 64 box. Also the clip of the robe and headband, so they follow the silhouette. */
	body: ReactElement;
	/** Where the robe's collar starts and where the eyes sit. */
	collarY: number;
	eyeY: number;
	headwear: "headband" | "hat";
	/** Red eyes instead of white ones. */
	sharingan?: boolean;
};

const LOOKS: Record<AgentId, Look> = {
	pa: {
		color: "#7c4dff",
		body: <circle cx="32" cy="36" r="25" />,
		collarY: 44,
		eyeY: 31,
		headwear: "hat",
		sharingan: true,
	},
	inbox: {
		color: "#1785ff",
		body: (
			<path d="M32 9c4 0 6.5 3.8 9.5 9l13 24.5c4.3 8.3 1.4 12.5-7.5 12.5h-30c-8.9 0-11.8-4.2-7.5-12.5l13-24.5C25.5 12.8 28 9 32 9Z" />
		),
		collarY: 45,
		eyeY: 35,
		headwear: "headband",
	},
	health: {
		color: "#10c46e",
		body: <rect x="5" y="17" width="54" height="38" rx="19" />,
		collarY: 44,
		eyeY: 32,
		headwear: "headband",
	},
	accountant: {
		color: "#ff6a00",
		body: (
			<>
				<circle cx="21" cy="38" r="15" />
				<circle cx="35" cy="28" r="16" />
				<circle cx="46" cy="41" r="14" />
				<circle cx="31" cy="46" r="12" />
			</>
		),
		collarY: 45,
		eyeY: 33,
		headwear: "hat",
	},
};

/** A bot the PA created has no look of its own: it wears the Health body in grey. */
const BOT_LOOK: Look = { ...LOOKS.health, color: "#6b7280" };

const lookOf = (id: AnyAgentId): Look => (id.startsWith("bot:") ? BOT_LOOK : LOOKS[id as AgentId]);

export function agentColor(id: AnyAgentId): string {
	return lookOf(id).color;
}

/** The agent's colour as a CSS variable, for the thread around it (bubbles, send button, background tint). */
export function agentStyle(id: AnyAgentId): CSSProperties {
	return { "--agent": lookOf(id).color } as CSSProperties;
}

export function BotAvatar({ id, size = 28, working = false }: { id: AnyAgentId; size?: number; working?: boolean }) {
	const look = lookOf(id);
	const clip = `bot-clip-${id.replace(":", "-")}`;
	const eye = look.sharingan === true ? "#e3262f" : "#ffffff";
	return (
		<svg
			className={`bot${working ? " bot--working" : ""}`}
			width={size}
			height={size}
			viewBox="0 0 64 64"
			aria-hidden="true"
			focusable="false"
		>
			<defs>
				<clipPath id={clip}>{look.body}</clipPath>
			</defs>
			<g className="bot__figure">
				<g fill={look.color}>{look.body}</g>
				<g clipPath={`url(#${clip})`}>
					{look.headwear === "headband" ? <Headband y={look.eyeY - 13} /> : null}
					<Robe y={look.collarY} />
				</g>
				<g className="bot__eyes" fill={eye}>
					<rect x="22" y={look.eyeY - 5} width="6" height="11" rx="3" transform={`rotate(12 25 ${look.eyeY})`} />
					<rect x="36" y={look.eyeY - 5} width="6" height="11" rx="3" transform={`rotate(12 39 ${look.eyeY})`} />
					{look.sharingan === true ? (
						<g fill="#1a0000">
							<circle cx="25" cy={look.eyeY + 1} r="1.4" />
							<circle cx="39" cy={look.eyeY + 1} r="1.4" />
						</g>
					) : null}
				</g>
				{look.headwear === "hat" ? <StrawHat /> : null}
			</g>
		</svg>
	);
}

/** Black robe up to the collar, with the inner lining showing and two red clouds. */
function Robe({ y }: { y: number }) {
	return (
		<g>
			<path d={`M0 ${y + 2}Q32 ${y - 5} 64 ${y + 2}V64H0Z`} fill="#121214" />
			<path d={`M27 ${y + 1}L32 ${y + 9}L37 ${y + 1}`} fill="none" stroke="#3a3a44" strokeWidth="1.6" />
			<RedCloud x={14} y={y + 9} />
			<RedCloud x={44} y={y + 7} />
		</g>
	);
}

function RedCloud({ x, y }: { x: number; y: number }) {
	return (
		<g fill="#d7262e" stroke="#ffffff" strokeWidth="1">
			<path
				d={`M${x - 6} ${y + 2}a3 3 0 0 1 2.6-4.4a3.6 3.6 0 0 1 6.6-.8a3 3 0 0 1 3.4 3.6a2.4 2.4 0 0 1-1.4 3.6h-9.4a2.4 2.4 0 0 1-1.8-2Z`}
			/>
		</g>
	);
}

/** A cloth band across the forehead with a metal plate and a swirl. */
function Headband({ y }: { y: number }) {
	return (
		<g>
			<rect x="0" y={y} width="64" height="7" fill="#22304a" />
			<rect x="22" y={y - 0.5} width="20" height="8" rx="2" fill="#c9ced8" stroke="#8a919e" strokeWidth="0.8" />
			<path
				d={`M30 ${y + 4.5}a2.2 2.2 0 1 1 3.4 1.6l2.6 1.4`}
				fill="none"
				stroke="#4b5260"
				strokeWidth="1.1"
				strokeLinecap="round"
			/>
		</g>
	);
}

/** A conical straw hat with paper charms hanging from the brim. */
function StrawHat() {
	return (
		<g>
			<path d="M3 19L32 2L61 19Q32 25 3 19Z" fill="#d8b46a" stroke="#9c7a35" strokeWidth="1" />
			<path d="M32 2L18 21M32 2L46 21M32 2V22" stroke="#b08d47" strokeWidth="0.8" />
			<rect x="9" y="19" width="3" height="9" rx="1" fill="#f3efe3" stroke="#b9b29e" strokeWidth="0.5" />
			<rect x="52" y="19" width="3" height="11" rx="1" fill="#f3efe3" stroke="#b9b29e" strokeWidth="0.5" />
		</g>
	);
}
