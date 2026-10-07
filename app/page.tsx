import Link from "next/link";
import Image from "next/image";
import type { CSSProperties } from "react";
import DenShell from "./components/DenShell";
import { isFieldRole, navFor } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";

export const dynamic = "force-dynamic";

const features = [
  { key: "home", href: "/", icon: "⌂", title: "Home", copy: "Your daily command center", color: "#159d96" },
  { key: "chat", href: "/coach", icon: "●", title: "Chat with Coach Denny", copy: "Fast answers for every customer", color: "#35bdb5" },
  { key: "listen", href: "/score", icon: "≋", title: "Let Coach Denny Listen", copy: "Turn calls into coaching insights", color: "#f4b63f" },
  { key: "schedule", href: "/schedule", icon: "▣", title: "Denny’s Smart Scheduler", copy: "Find the best rep, date, and time", color: "#f23838" },
  { key: "talk", href: "/talk", icon: "◉", title: "Talk with Coach Denny", copy: "Your schedule and customer 360, by voice", color: "#0b7f79" },
] as const;

export default async function Home() {
  const access = await getCurrentAccess();
  const role = access?.role ?? "csr";
  const allowed = navFor(role);
  const visibleFeatures = features.filter((feature) => (allowed as readonly string[]).includes(feature.key));
  const field = isFieldRole(role);

  return (
    <DenShell title="Den Coach Denny" subtitle="Your AI teammate" theme="home">
      <section className="home-hero">
        <div className="home-copy">
          <p className="eyebrow">Same mission. A smarter way to work.</p>
          <h1 className="display-title">One smart place <span>to get the job done.</span></h1>
          <p>Ask questions. Review calls. Find the best appointment—in seconds.</p>
          <div className="hero-actions">
            {field
              ? <Link className="btn btn-teal" href="/talk">Talk with Denny <span aria-hidden="true">→</span></Link>
              : <Link className="btn btn-teal" href="/coach">Ask Denny <span aria-hidden="true">→</span></Link>}
            <Link className="btn btn-coral" href="/schedule">Open Smart Scheduler <span aria-hidden="true">→</span></Link>
          </div>
        </div>
        <div className="home-mascot" aria-hidden="true">
          <Image src="/brand/denny.png" alt="" width={500} height={500} priority />
        </div>
      </section>

      <section className="feature-grid" aria-label="Den Coach Denny tools">
        {visibleFeatures.map((feature) => (
          <Link key={feature.title} href={feature.href} className="feature-card surface" style={{ "--card-accent": feature.color } as CSSProperties}>
            <span className="feature-icon" aria-hidden="true">{feature.icon}</span>
            <span><h2>{feature.title}</h2><p>{feature.copy}</p></span>
          </Link>
        ))}
      </section>
    </DenShell>
  );
}
