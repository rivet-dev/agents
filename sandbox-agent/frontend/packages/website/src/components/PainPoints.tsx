"use client";

import { motion } from "framer-motion";
import { Shield, Layers, Database, X, Check } from "lucide-react";

const frictions = [
  {
    icon: Shield,
    title: "Coding Agents Need Sandboxes",
    problem:
      "You can't let AI execute arbitrary code on your production servers. Coding agents need isolated environments, but existing SDKs assume local execution.",
    solution: "A server that runs inside the sandbox and exposes HTTP/SSE.",
  },
  {
    icon: Layers,
    title: "Every Coding Agent is Different",
    problem:
      "Claude Code, Codex, OpenCode, Amp, and Pi each have proprietary APIs, event formats, and behaviors. Swapping coding agents means rewriting your entire integration.",
    solution: "One HTTP API. Write your code once, swap coding agents with a config change.",
  },
  {
    icon: Database,
    title: "Sessions Are Ephemeral",
    problem: "Coding agent transcripts live in the sandbox. When the process ends, you lose everything. Debugging and replay become impossible.",
    solution: "Universal event schema streams to your storage. Persist to Postgres or Rivet, replay later, audit everything.",
  },
];

export function PainPoints() {
  return (
    <section className="border-t border-white/10 py-48">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mb-12">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-2 text-2xl font-normal tracking-tight text-white md:text-4xl"
          >
            Running coding agents remotely is hard.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-2xl text-base leading-relaxed text-zinc-500"
          >
            The Sandbox Agent SDK is a server that runs inside your sandbox. Your app connects remotely to control Claude Code, Codex, OpenCode, Amp, or Pi —
            streaming events, handling permissions, managing sessions.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="grid grid-cols-1 gap-8 md:grid-cols-3"
        >
          {frictions.map((friction) => (
            <div key={friction.title} className="flex flex-col border-t border-white/10 pt-6">
              <div className="mb-3 text-zinc-500">
                <friction.icon className="h-4 w-4" />
              </div>
              <h3 className="mb-4 text-base font-normal text-white">{friction.title}</h3>
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <X className="h-3 w-3 text-zinc-600" />
                  <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Problem</span>
                </div>
                <p className="text-sm leading-relaxed text-zinc-500">{friction.problem}</p>
              </div>
              <div className="mt-auto border-t border-white/5 pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Check className="h-3 w-3 text-green-400" />
                  <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Solution</span>
                </div>
                <p className="text-sm leading-relaxed text-zinc-300">{friction.solution}</p>
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
