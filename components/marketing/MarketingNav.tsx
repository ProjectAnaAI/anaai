"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Brand } from "@/components/brand/Brand";
import { DialogSurface } from "@/components/ui/dialog-surface";
const links = [
  ["Product", "#product"],
  ["How it works", "#how-it-works"],
  ["Use cases", "#use-cases"],
  ["Questions", "#questions"],
];
export function MarketingNav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const close = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, []);
  return (
    <header className="marketing-nav">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Link href="/" aria-label="AnaAI home">
        <Brand />
      </Link>
      <nav aria-label="Public navigation">
        {links.map(([label, href]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
      <div className="marketing-nav-actions">
        <Link className="marketing-signin" href="/login">
          Sign in
        </Link>
        <Link className="marketing-button primary compact" href="/signup">
          Get started
        </Link>
        <button
          className="marketing-menu"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <Menu size={22} />
        </button>
      </div>
      {open && (
        <DialogSurface
          className="marketing-menu-dialog"
          aria-label="Public navigation menu"
          onClose={() => setOpen(false)}
        >
          <div>
            <Brand />
            <button
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
            >
              <X size={22} />
            </button>
          </div>
          <nav>
            {links.map(([label, href]) => (
              <a key={href} href={href} onClick={() => setOpen(false)}>
                {label}
              </a>
            ))}
            <Link href="/login">Sign in</Link>
            <Link className="marketing-button primary" href="/signup">
              Get started
            </Link>
          </nav>
        </DialogSurface>
      )}
    </header>
  );
}
