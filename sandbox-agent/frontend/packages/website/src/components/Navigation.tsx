"use client";

import { useState, useEffect } from "react";
import { Menu, X } from "lucide-react";
import { GitHubStars } from "./GitHubStars";

function NavItem({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="px-3 py-2 text-sm font-normal text-zinc-400 transition-colors duration-200 hover:text-white">
      {children}
    </a>
  );
}

export function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="fixed top-0 z-50 w-full max-w-[1200px] md:left-1/2 md:top-4 md:-translate-x-1/2 md:px-8">
      <div
        className={`relative before:pointer-events-none before:absolute before:inset-[-1px] before:z-20 before:hidden before:rounded-xl before:border before:content-[''] before:transition-colors before:duration-300 before:ease-in-out md:before:block ${
          isScrolled ? "before:border-white/10" : "before:border-transparent"
        }`}
      >
        {/* Background with blur */}
        <div
          className={`absolute inset-0 -z-[1] hidden overflow-hidden rounded-xl transition-all duration-300 ease-in-out md:block ${
            isScrolled ? "bg-[#09090b]/80 backdrop-blur-lg" : "bg-transparent backdrop-blur-none"
          }`}
        />

        <header
          className={`bg-[#09090b]/60 border-b-transparent sticky top-0 z-10 flex flex-col items-center border-b backdrop-blur-md pt-2 pb-2 md:static md:bg-transparent md:rounded-xl md:max-w-[1200px] md:border-transparent md:backdrop-blur-none transition-all hover:opacity-100 ${
            isScrolled ? "opacity-100" : "opacity-80"
          }`}
        >
          <div className="flex w-full items-center justify-between px-3">
            {/* Left side: Logo + Nav */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <a href="https://rivet.dev" className="flex items-center">
                  <img src="/rivet-icon.svg" alt="Rivet" className="size-8" />
                </a>
                <span className="text-white/20">|</span>
                <a href="/" className="flex items-center">
                  <img src="/logos/sandboxagent.svg" alt="Sandbox Agent SDK" className="h-6 w-auto" />
                </a>
              </div>

              {/* Desktop Nav */}
              <div className="hidden md:flex items-center ml-2">
                <NavItem href="/docs">Docs</NavItem>
                <NavItem href="https://github.com/rivet-dev/sandbox-agent/releases">Changelog</NavItem>
              </div>
            </div>

            {/* Right side */}
            <div className="hidden md:flex flex-row items-center gap-2">
              <a
                href="https://discord.gg/auCecybynK"
                className="inline-flex items-center justify-center whitespace-nowrap rounded-md border border-white/10 px-4 py-2 h-10 text-sm hover:border-white/20 text-white/90 hover:text-white transition-colors"
                aria-label="Discord"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
              <GitHubStars
                repo="rivet-dev/sandbox-agent"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/10 bg-white/5 px-4 py-2 h-10 text-sm text-white shadow-sm hover:border-white/20 transition-colors"
              />
            </div>

            {/* Mobile menu button */}
            <button className="md:hidden text-zinc-400 hover:text-white p-2 transition-colors" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </header>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border border-white/10 bg-[#09090b]/95 backdrop-blur-lg rounded-xl mt-2 mx-2 shadow-xl">
          <div className="px-4 py-4 space-y-1">
            <a
              href="/docs"
              className="block py-2.5 px-3 text-white/80 hover:text-white hover:bg-white/5 rounded-lg transition-colors font-medium"
              onClick={() => setMobileMenuOpen(false)}
            >
              Docs
            </a>
            <a
              href="https://github.com/rivet-dev/sandbox-agent/releases"
              className="block py-2.5 px-3 text-white/80 hover:text-white hover:bg-white/5 rounded-lg transition-colors font-medium"
              onClick={() => setMobileMenuOpen(false)}
            >
              Changelog
            </a>
            <div className="border-t border-white/10 pt-3 mt-3 space-y-1">
              <a
                href="https://discord.gg/auCecybynK"
                className="flex items-center gap-3 py-2.5 px-3 text-white/80 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Discord"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
                <span className="font-medium">Discord</span>
              </a>
              <GitHubStars
                repo="rivet-dev/sandbox-agent"
                className="flex items-center gap-3 py-2.5 px-3 text-white/80 hover:text-white hover:bg-white/5 rounded-lg transition-colors w-full"
                onClick={() => setMobileMenuOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
