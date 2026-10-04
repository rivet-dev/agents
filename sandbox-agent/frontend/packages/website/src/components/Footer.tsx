"use client";

import { motion } from "framer-motion";

const footer = {
  products: [
    { name: "Actors", href: "https://rivet.dev/docs/actors" },
    { name: "Sandbox Agent SDK", href: "/docs" },
  ],
  developers: [
    { name: "Documentation", href: "/docs" },
    { name: "Changelog", href: "https://github.com/rivet-dev/sandbox-agent/releases" },
    { name: "Blog", href: "https://www.rivet.dev/blog/" },
  ],
  legal: [
    { name: "Terms", href: "https://rivet.dev/terms" },
    { name: "Privacy Policy", href: "https://rivet.dev/privacy" },
    { name: "Acceptable Use", href: "https://rivet.dev/acceptable-use" },
  ],
  social: [
    {
      name: "Discord",
      href: "https://discord.gg/auCecybynK",
      icon: (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      ),
    },
    {
      name: "GitHub",
      href: "https://github.com/rivet-dev/sandbox-agent",
      icon: (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      ),
    },
    {
      name: "Twitter",
      href: "https://x.com/rivet_dev",
      icon: (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      ),
    },
  ],
};

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#09090b]">
      <div className="mx-auto max-w-6xl px-6 py-16 lg:py-20">
        <div className="xl:grid xl:grid-cols-12 xl:gap-16">
          {/* Logo & Social */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="space-y-6 xl:col-span-4"
          >
            <a href="https://rivet.dev" className="inline-block">
              <img src="/rivet-logo-text-white.svg" alt="Rivet" className="h-6 w-auto opacity-90 hover:opacity-100 transition-opacity" />
            </a>
            <p className="text-sm leading-6 text-zinc-500">Infrastructure for software that thinks</p>
            <div className="flex space-x-4">
              {footer.social.map((item) => (
                <a key={item.name} href={item.href} className="text-zinc-500 hover:text-white transition-colors" target="_blank" rel="noopener noreferrer">
                  <span className="sr-only">{item.name}</span>
                  {item.icon}
                </a>
              ))}
            </div>
          </motion.div>

          {/* Links */}
          <div className="mt-12 grid grid-cols-2 gap-8 md:grid-cols-3 xl:col-span-8 xl:mt-0">
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.5, delay: 0.1 }}>
              <h3 className="text-sm font-semibold leading-6 text-white">Products</h3>
              <ul role="list" className="mt-4 space-y-3">
                {footer.products.map((item) => (
                  <li key={item.name}>
                    <a href={item.href} className="text-sm leading-6 text-zinc-500 hover:text-white transition-colors">
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.15 }}
            >
              <h3 className="text-sm font-semibold leading-6 text-white">Developers</h3>
              <ul role="list" className="mt-4 space-y-3">
                {footer.developers.map((item) => (
                  <li key={item.name}>
                    <a href={item.href} className="text-sm leading-6 text-zinc-500 hover:text-white transition-colors">
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.5, delay: 0.2 }}>
              <h3 className="text-sm font-semibold leading-6 text-white">Legal</h3>
              <ul role="list" className="mt-4 space-y-3">
                {footer.legal.map((item) => (
                  <li key={item.name}>
                    <a href={item.href} className="text-sm leading-6 text-zinc-500 hover:text-white transition-colors">
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>
        </div>

        {/* Bottom */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-12 border-t border-white/10 pt-8"
        >
          <p className="text-xs text-zinc-600 text-center">&copy; {new Date().getFullYear()} Rivet Gaming, Inc. All rights reserved.</p>
        </motion.div>
      </div>
    </footer>
  );
}
