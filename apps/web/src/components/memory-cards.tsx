"use client";

import type { MemoryCard, MemoryFactView, MemoryListCard } from "@assistant/shared";
import Link from "next/link";

/** Who a remembered line is for, in words. */
export const scopeLabel = (scope: MemoryFactView["scope"]): string =>
	scope === "shared" ? "every agent" : `the ${scope} agent`;

const kindLabel = (fact: MemoryFactView): string => (fact.kind === "preference" ? "Preference" : "Fact");

/** `remember`: what was kept, and where the owner can change it. */
export function MemoryCardView({ card }: { card: MemoryCard }) {
	const { fact } = card;
	return (
		<section className="card" aria-label="Memory">
			<header className="card__head">
				<span aria-hidden="true">🧠</span> {card.event === "saved" ? "Remembered" : "Already remembered"}{" "}
				<span className="card__muted">
					· {kindLabel(fact)} for {scopeLabel(fact.scope)}
				</span>
			</header>
			<p className="card__title">{fact.text}</p>
			<p className="card__muted">
				Read, edit or delete it on the <Link href="/profile">profile page</Link>.
			</p>
		</section>
	);
}

/** `recall`: the lines that matched. */
export function MemoryListView({ card }: { card: MemoryListCard }) {
	return (
		<section className="card" aria-label="Memory search">
			<header className="card__head">
				<span aria-hidden="true">🧠</span> {card.heading}{" "}
				<span className="card__muted">· {card.total === 0 ? "nothing" : `${card.total} found`}</span>
			</header>
			<ul className="facts">
				{card.facts.map((fact) => (
					<li key={fact.id}>
						{fact.text}{" "}
						<span className="card__muted">
							({kindLabel(fact).toLowerCase()}, {scopeLabel(fact.scope)})
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
