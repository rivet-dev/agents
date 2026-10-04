"use client";

import { Workflow, Database, Server } from "lucide-react";
import { FeatureIcon } from "./ui/FeatureIcon";

const problems = [
  {
    title: "Universal Agent API",
    desc: "Claude Code, Codex, OpenCode, Amp, and Pi each have different APIs. We provide a single interface to control them all.",
    icon: Workflow,
    color: "text-accent",
  },
  {
    title: "Universal Transcripts",
    desc: "Every agent has its own event format. Our universal schema normalizes them all — stream, store, and replay with ease.",
    icon: Database,
    color: "text-purple-400",
  },
  {
    title: "Run Anywhere",
    desc: "Lightweight Rust daemon runs locally or in any environment. One command to bridge coding agents to your system.",
    icon: Server,
    color: "text-green-400",
  },
];

export function ProblemsSolved() {
  return (
    <section id="features" className="py-24 bg-[#0f0f11] border-y border-white/5">
      <div className="max-w-7xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-semibold text-white mb-4">Why Coding Agent SDK?</h2>
          <p className="text-zinc-400 max-w-xl mx-auto">Solving the three fundamental friction points of agentic software development.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {problems.map((item, idx) => (
            <div key={idx} className="group p-8 rounded-xl bg-white/[0.02] border border-white/5 hover:border-accent/30 transition-all duration-300">
              <FeatureIcon icon={item.icon} color={item.color} />
              <h3 className="text-xl font-semibold text-white mb-3">{item.title}</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
