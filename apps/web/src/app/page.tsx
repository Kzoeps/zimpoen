import { redirect } from "next/navigation";

/** The front door is the PA. */
export default function Home(): never {
	redirect("/chat/pa");
}
