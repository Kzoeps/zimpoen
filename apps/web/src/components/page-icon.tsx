/** Flat icons for the owner's pages, drawn to sit next to the ninja bot avatars. */

export type PageIconName = "profile" | "activity" | "usage" | "settings";

export function PageIcon({ name, size = 26 }: { name: PageIconName; size?: number }) {
	return (
		<svg className={`page-icon page-icon--${name}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
			{ICONS[name]}
		</svg>
	);
}

const ICONS: Record<PageIconName, React.ReactElement> = {
	// The owner: a hooded figure wearing a forehead protector.
	profile: (
		<g>
			<path d="M8 60c0-14 10.7-22 24-22s24 8 24 22Z" fill="#3b3f4a" />
			<circle cx="32" cy="24" r="15" fill="#f1c9a5" />
			<path d="M17 20a15 15 0 0 1 30 0Z" fill="#2a2d35" />
			<rect x="16" y="18" width="32" height="6" fill="#22304a" />
			<rect x="25" y="17.5" width="14" height="7" rx="1.5" fill="#c9ced8" stroke="#8a919e" strokeWidth="0.8" />
			<rect x="25" y="27" width="4" height="6" rx="2" fill="#2a2d35" />
			<rect x="35" y="27" width="4" height="6" rx="2" fill="#2a2d35" />
		</g>
	),
	// What happened: an open mission scroll.
	activity: (
		<g>
			<rect x="14" y="10" width="36" height="44" fill="#f3e6c4" stroke="#c9b27c" strokeWidth="1.2" />
			<rect x="9" y="6" width="46" height="7" rx="3.5" fill="#b4372f" />
			<rect x="9" y="51" width="46" height="7" rx="3.5" fill="#b4372f" />
			<path d="M21 22h22M21 30h22M21 38h14" stroke="#7a6640" strokeWidth="2.6" strokeLinecap="round" />
		</g>
	),
	// Tokens spent: three kunai of rising length.
	usage: (
		<g>
			<Kunai x={16} top={34} />
			<Kunai x={32} top={22} />
			<Kunai x={48} top={10} />
		</g>
	),
	// Settings: a shuriken that spins on hover.
	settings: (
		<g className="page-icon__spin">
			<path
				d="M32 4l6 20 20 8-20 6-6 22-6-22-20-6 20-8Z"
				fill="#8c93a1"
				stroke="#5d6370"
				strokeWidth="1.2"
				strokeLinejoin="round"
			/>
			<circle cx="32" cy="32" r="5" fill="var(--bg-subtle)" stroke="#5d6370" strokeWidth="1.2" />
		</g>
	),
};

function Kunai({ x, top }: { x: number; top: number }) {
	return (
		<g>
			<path d={`M${x} ${top}l5 14h-10Z`} fill="#9aa1ae" stroke="#5d6370" strokeWidth="1" strokeLinejoin="round" />
			<rect x={x - 1.6} y={top + 14} width="3.2" height={44 - top} fill="#6b7280" />
			<circle cx={x} cy={top + 14 + (44 - top) + 3} r="3" fill="none" stroke="#6b7280" strokeWidth="1.6" />
		</g>
	);
}
