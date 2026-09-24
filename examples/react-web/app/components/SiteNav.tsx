// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Field desk" },
  { href: "/specimens", label: "Specimens" },
  { href: "/video", label: "Video" },
  { href: "/playback", label: "Playback" },
  { href: "/log", label: "Field log" },
  { href: "/archive", label: "Archive" },
  { href: "/settings", label: "Settings" },
  { href: "/source-map-check", label: "Errors" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Main">
      <div className="site-nav-inner">
        <Link href="/" className="wordmark">
          Elytra
          <span className="demo-tag">Everframe demo</span>
        </Link>
        <div className="nav-links">
          {LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
