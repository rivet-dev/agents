"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const faqs = [
  {
    question: "Does this replace the Vercel AI SDK?",
    answer:
      "No, they're complementary. AI SDK is for building chat interfaces and calling LLMs. This SDK is for controlling autonomous coding agents that write code and run commands. Use AI SDK for your UI, use this when you need a coding agent to actually code.",
  },
  {
    question: "Which coding agents are supported?",
    answer: "Claude Code, Codex, OpenCode, Amp, and Pi. The SDK normalizes their APIs so you can swap between them without changing your code.",
  },
  {
    question: "How is session data persisted?",
    answer:
      "This SDK does not handle persisting session data. Events stream in a universal JSON schema that you can persist anywhere. Consider using Postgres or <a href='https://rivet.gg' target='_blank' rel='noopener noreferrer' class='text-orange-400 hover:underline'>Rivet Actors</a> for data persistence.",
  },
  {
    question: "Can I run this locally or does it require a sandbox provider?",
    answer: "Both. Run locally for development, deploy to E2B, Daytona, or Vercel Sandboxes for production.",
  },
  {
    question: "Does it support [platform]?",
    answer:
      "The server is a single Rust binary that runs anywhere with a curl install. If your platform can run Linux binaries (Docker, VMs, etc.), it works. See the deployment guides for E2B, Daytona, and Vercel Sandboxes.",
  },
  {
    question: "Can I use this with my personal API keys?",
    answer:
      "Yes. Use <code>sandbox-agent credentials extract-env</code> to extract API keys from your local agent configs (Claude Code, Codex, OpenCode, Amp, Pi) and pass them to the sandbox environment.",
  },
  {
    question: "Why Rust and not [language]?",
    answer:
      "Rust gives us a single static binary, fast startup, and predictable memory usage. That makes it easy to run inside sandboxes or in CI without shipping a large runtime, such as Node.js.",
  },
  {
    question: "Why can't I just run coding agents locally?",
    answer:
      "You can for development. But in production, you need isolation. Coding agents execute arbitrary code — that can't happen on your servers. Sandboxes provide the isolation; this SDK provides the HTTP API to control coding agents remotely.",
  },
  {
    question: "How is this different from the agent's official SDK?",
    answer:
      "Official SDKs assume local execution. They spawn processes and expect interactive terminals. This SDK runs a server inside a sandbox that you connect to over HTTP — designed for remote control from the start.",
  },
  {
    question: "Why not just SSH into the sandbox?",
    answer:
      "Coding agents expect interactive terminals with proper TTY handling. SSH with piped commands breaks tool confirmations, streaming output, and human-in-the-loop flows. The SDK handles all of this over a clean HTTP API.",
  },
];

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-t border-white/10 first:border-t-0">
      <button onClick={() => setIsOpen(!isOpen)} className="group flex w-full items-center justify-between py-5 text-left">
        <span className="text-base font-normal text-white pr-4 group-hover:text-zinc-300 transition-colors">{question}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm leading-relaxed text-zinc-500" dangerouslySetInnerHTML={{ __html: answer }} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function FAQ() {
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
            Frequently Asked Questions
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mx-auto max-w-xl text-base leading-relaxed text-zinc-500"
          >
            Common questions about running agents in sandboxes.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mx-auto max-w-3xl"
        >
          {faqs.map((faq, index) => (
            <FAQItem key={index} question={faq.question} answer={faq.answer} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}
