import Link from "next/link";
import { getCurrentAccess } from "@/lib/currentAccess";

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  const access = await getCurrentAccess();
  const unavailable = access?.role === "unavailable";

  return (
    <div className="den-bg">
      <div className="den-shell">
        <section className="surface" style={{ padding: 32, maxWidth: 640, margin: "60px auto" }}>
          <h1 className="display-title" style={{ fontSize: 40 }}>
            {unavailable ? "Denny can't check your access right now" : "Your Denny access isn't turned on"}
          </h1>
          <p style={{ fontSize: 18, lineHeight: 1.5 }}>
            {unavailable
              ? "The team list could not be reached. Please try again in a minute."
              : access?.needsEmailVerification
              ? `You're on the team, but the email on this login${access.email ? ` (${access.email})` : ""} hasn't been verified yet. Open the verification email from Auth0 (or ask an owner to resend it), then sign out and back in.`
              : `You're signed in${access?.email ? ` as ${access.email}` : ""}, but this login hasn't been added to the Den Coach Denny team yet, or it was turned off. Ask an owner to add you on the Team page.`}
          </p>
          <div className="hero-actions">
            <Link className="btn btn-teal" href="/">Try again</Link>
            <a className="btn btn-outline" href="/auth/logout">Sign out</a>
          </div>
        </section>
      </div>
    </div>
  );
}
