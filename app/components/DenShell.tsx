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
  theme?: "home" | "chat" | "listen" | "schedule" | "owner";
};

const navItems = [
  { href: "/", label: "Home", theme: "home", icon: "home" },
  { href: "/coach", label: "Chat with Coach Denny", theme: "chat", icon: "chat" },
  { href: "/score", label: "Let Coach Denny Listen", theme: "listen", icon: "wave" },
  { href: "/schedule", label: "Denny’s Smart Scheduler", theme: "schedule", icon: "calendar" },
  { href: "/owner", label: "Owner Dashboard", theme: "owner", icon: "owner" },
] as const;

function NavIcon({ name }: { name: string }) {
  if (name === "home") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></svg>;
  if (name === "chat") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a4 4 0 0 1-4 4H9l-5 3 1.5-4.5A8 8 0 1 1 20 15Z" /></svg>;
  if (name === "wave") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></svg>;
  if (name === "owner") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18M5 16l5-5 4 3 5-8M16 6h3v3" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" /></svg>;
}

export default function DenShell({ title, subtitle, children, theme = "home" }: DenShellProps) {
  const pathname = usePathname();
  const [ownerAllowed, setOwnerAllowed] = useState(theme === "owner");
  useEffect(() => {
    if (ownerAllowed) return;
    fetch("/api/owner/access", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setOwnerAllowed(data.allowed === true))
      .catch(() => undefined);
  }, [ownerAllowed]);

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
          <div className="connection-pill"><span className="online-dot" /> Connected</div>
        </header>

        <nav className="den-nav" aria-label="Main navigation">
          {navItems.filter((item) => item.theme !== "owner" || ownerAllowed).map((item) => {
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
