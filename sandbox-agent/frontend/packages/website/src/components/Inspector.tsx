"use client";

import { motion } from "framer-motion";

export function Inspector() {
  return (
    <section className="border-t border-white/10 py-48">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mb-12 text-center">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-2 text-2xl font-normal tracking-tight text-white md:text-4xl"
          >
            Built-in Debugger
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mx-auto max-w-xl text-base leading-relaxed text-zinc-500"
          >
            Inspect sessions, view event payloads, and troubleshoot without writing&nbsp;code.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="overflow-hidden rounded-xl border border-white/10"
        >
          <img src="/images/inspector.png" alt="Sandbox Agent Inspector" className="w-full" />
        </motion.div>
      </div>
    </section>
  );
}
