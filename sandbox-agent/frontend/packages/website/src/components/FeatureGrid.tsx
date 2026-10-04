"use client";

import { motion } from "framer-motion";
import { Workflow, Server, Database, Download, Globe, Plug } from "lucide-react";

export function FeatureGrid() {
  return (
    <section id="features" className="border-t border-white/10 py-48">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mb-12">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-2 text-2xl font-normal tracking-tight text-white md:text-4xl"
          >
            How it works.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-xl text-base leading-relaxed text-zinc-500"
          >
            A server runs inside your sandbox. Your app connects over HTTP to control any coding agent.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"
        >
          {/* Universal Agent API - Span full width */}
          <div className="group col-span-full flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500 transition-colors group-hover:text-orange-400">
                <Workflow className="h-4 w-4" />
              </div>
              <h4 className="text-base font-normal text-white">Universal Agent API</h4>
            </div>
            <p className="text-zinc-500 leading-relaxed text-base max-w-2xl">
              Claude Code, Codex, OpenCode, and Amp each have different APIs. We provide a single, unified interface to control them all.
            </p>
          </div>

          {/* Streaming Events */}
          <div className="group flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500 transition-colors group-hover:text-green-400">
                <Server className="h-4 w-4" />
              </div>
              <h4 className="text-base font-normal text-white">Streaming Events</h4>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Real-time SSE stream of everything the agent does. Persist to your storage, replay sessions, audit everything.
            </p>
          </div>

          {/* Universal Schema */}
          <div className="group flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500 transition-colors group-hover:text-purple-400">
                <Database className="h-4 w-4" />
              </div>
              <h4 className="text-base font-normal text-white">Universal Schema</h4>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Standardized session schema that covers all features of all agents. Includes tool calls, permission requests, file edits, etc.
            </p>
          </div>

          {/* Runs Inside Any Sandbox */}
          <div className="group lg:col-span-2 flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500 transition-colors group-hover:text-blue-400">
                <Globe className="h-4 w-4" />
              </div>
              <h4 className="text-base font-normal text-white">Runs Inside Any Sandbox</h4>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Lightweight static binary. One curl command to install inside E2B, Daytona, Vercel Sandboxes, or Docker.
            </p>
          </div>

          {/* Session Management */}
          <div className="group lg:col-span-2 flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500 transition-colors group-hover:text-amber-400">
                <Download className="h-4 w-4" />
              </div>
              <h4 className="text-base font-normal text-white">Session Management</h4>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Create sessions, send messages, persist transcripts. Full session lifecycle management over HTTP.
            </p>
          </div>

          {/* OpenCode SDK & UI Support */}
          <div className="group lg:col-span-2 flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500 transition-colors group-hover:text-pink-400">
                <Plug className="h-4 w-4" />
              </div>
              <h4 className="text-base font-normal text-white">OpenCode Support</h4>
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-500 transition-colors group-hover:text-pink-400 group-hover:border-pink-400/30">
                Experimental
              </span>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">Connect OpenCode CLI, SDK, or web UI to control agents through familiar OpenCode tooling.</p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
