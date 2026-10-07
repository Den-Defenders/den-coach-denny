"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type DenShellProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  theme?: "home" | "chat" | "listen" | "schedule" | "owner" | "talk" | "team";
};

type NavKey = "home" | "chat" | "listen" | "schedule" | "talk" | "owner" | "team";

const navItems = [
  { key: "home", href: "/", label: "Home", theme: "home", icon: "home" },
  { key: "chat", href: "/coach", label: "Chat with Coach Denny", theme: "chat", icon: "chat" },
  { key: "listen", href: "/score", label: "Let Coach Denny Listen", theme: "listen", icon: "wave" },
  { key: "schedule", href: "/schedule", label: "Denny’s Smart Scheduler", theme: "schedule", icon: "calendar" },
  { key: "talk", href: "/talk", label: "Talk with Coach Denny", theme: "talk", icon: "mic" },
  { key: "owner", href: "/owner", label: "Owner Dashboard", theme: "owner", icon: "owner" },
  { key: "team", href: "/team", label: "Team", theme: "team", icon: "team" },
] as const satisfies readonly { key: NavKey; href: string; label: string; theme: string; icon: string }[];

type MeResponse = { displayName?: string; nav?: NavKey[] };

function NavIcon({ name }: { name: string }) {
  if (name === "home") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></svg>;
  if (name === "chat") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a4 4 0 0 1-4 4H9l-5 3 1.5-4.5A8 8 0 1 1 20 15Z" /></svg>;
  if (name === "wave") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></svg>;
  if (name === "mic") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>;
  if (name === "team") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></svg>;
  if (name === "owner") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18M5 16l5-5 4 3 5-8M16 6h3v3" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" /></svg>;
}

export default function DenShell({ title, subtitle, children, theme = "home" }: DenShellProps) {
  const pathname = usePathname();
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: MeResponse) => setMe(data))
      .catch(() => undefined);
  }, []);

  // Until /api/me answers, show only the tile for the page we are on. The
  // server (proxy.ts) enforces access either way; this only tidies the menu.
  const visibleNav = me?.nav
    ? navItems.filter((item) => me.nav?.includes(item.key))
    : navItems.filter((item) => item.theme === theme);

  return (
    <div className={`den-bg theme-${theme}`}>
      <div className="den-shell">
        <header className="den-header">
          <Link href="/" className="den-brand" aria-label="Den Coach Denny home">
            <Image className="den-logo" src="/brand/den-logo.png" alt="Den Defenders Security Doors" width={190} height={97} priority />
            <span className="brand-divider" aria-hidden="true" />
            <Image className="den-avatar" src="/brand/denny-avatar.png" alt="Coach Denny" width={68} height={68} priority />
            <span className="brand-copy">
              <strong>Den Coach Denny</strong>
              <span>Your AI teammate for faster answers, better calls, and smarter scheduling.</span>
            </span>
          </Link>
          <div className="connection-pill">
            <span className="online-dot" /> {me?.displayName ? me.displayName : "Connected"}
            <a href="/auth/logout" className="sign-out-link">Sign out</a>
          </div>
        </header>

        <nav className="den-nav" aria-label="Main navigation">
          {visibleNav.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={`nav-tile nav-${item.theme}${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                <span className="nav-icon"><NavIcon name={item.icon} /></span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <main className="den-main">
          <div className="sr-only"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
          {children}
        </main>

        <footer className="status-bar" aria-label="System status">
          <span><i className="status-icon">✓</i> ServiceTitan Connected</span>
          <span><i className="status-icon">✓</i> Live Territory Rules</span>
          <span><i className="status-icon">✓</i> Routes Verified</span>
        </footer>
      </div>
    </div>
  );
}
