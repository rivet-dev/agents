"use client";

import { motion } from "framer-motion";
import { Code, Server, GitBranch } from "lucide-react";
import { CopyButton } from "./ui/CopyButton";

const sdkCodeRaw = `import { SandboxAgent } from "sandbox-agent";
import { local } from "sandbox-agent/local";

const client = await SandboxAgent.start({
  sandbox: local(),
});

await client.createSession("my-session", {
  agent: "claude-code",
});

await client.postMessage("my-session", {
  message: "Hello, world!",
});

for await (const event of client.streamEvents("my-session")) {
  console.log(event.type, event.data);
}`;

function SdkCodeHighlighted() {
  return (
    <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
      <code>
        <span className="text-purple-400">import</span>
        <span className="text-zinc-300">{" { "}</span>
        <span className="text-white">SandboxAgent</span>
        <span className="text-zinc-300">{" } "}</span>
        <span className="text-purple-400">from</span>
        <span className="text-zinc-300"> </span>
        <span className="text-green-400">"sandbox-agent"</span>
        <span className="text-zinc-300">;</span>
        {"\n"}
        <span className="text-purple-400">import</span>
        <span className="text-zinc-300">{" { "}</span>
        <span className="text-white">local</span>
        <span className="text-zinc-300">{" } "}</span>
        <span className="text-purple-400">from</span>
        <span className="text-zinc-300"> </span>
        <span className="text-green-400">"sandbox-agent/local"</span>
        <span className="text-zinc-300">;</span>
        {"\n\n"}
        <span className="text-purple-400">const</span>
        <span className="text-zinc-300"> client = </span>
        <span className="text-purple-400">await</span>
        <span className="text-zinc-300"> SandboxAgent.</span>
        <span className="text-blue-400">start</span>
        <span className="text-zinc-300">{"({"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  sandbox: local(),"}</span>
        {"\n"}
        <span className="text-zinc-300">{"});"}</span>
        {"\n\n"}
        <span className="text-purple-400">await</span>
        <span className="text-zinc-300"> client.</span>
        <span className="text-blue-400">createSession</span>
        <span className="text-zinc-300">(</span>
        <span className="text-green-400">"my-session"</span>
        <span className="text-zinc-300">{", {"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  agent: "}</span>
        <span className="text-green-400">"claude-code"</span>
        <span className="text-zinc-300">,</span>
        {"\n"}
        <span className="text-zinc-300">{"});"}</span>
        {"\n\n"}
        <span className="text-purple-400">await</span>
        <span className="text-zinc-300"> client.</span>
        <span className="text-blue-400">postMessage</span>
        <span className="text-zinc-300">(</span>
        <span className="text-green-400">"my-session"</span>
        <span className="text-zinc-300">{", {"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  message: "}</span>
        <span className="text-green-400">"Hello, world!"</span>
        <span className="text-zinc-300">,</span>
        {"\n"}
        <span className="text-zinc-300">{"});"}</span>
        {"\n\n"}
        <span className="text-purple-400">for await</span>
        <span className="text-zinc-300"> (</span>
        <span className="text-purple-400">const</span>
        <span className="text-zinc-300"> event </span>
        <span className="text-purple-400">of</span>
        <span className="text-zinc-300"> client.</span>
        <span className="text-blue-400">streamEvents</span>
        <span className="text-zinc-300">(</span>
        <span className="text-green-400">"my-session"</span>
        <span className="text-zinc-300">{")) {"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  console."}</span>
        <span className="text-blue-400">log</span>
        <span className="text-zinc-300">(event.type, event.data);</span>
        {"\n"}
        <span className="text-zinc-300">{"}"}</span>
      </code>
    </pre>
  );
}

const sandboxCommand = `curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh`;

const sourceCommands = `git clone https://github.com/rivet-dev/sandbox-agent
cd sandbox-agent
cargo run -p sandbox-agent --release`;

export function GetStarted() {
  return (
    <section id="get-started" className="border-t border-white/10 py-48">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mb-12">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-2 text-2xl font-normal tracking-tight text-white md:text-4xl"
          >
            Get Started
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-xl text-base leading-relaxed text-zinc-500"
          >
            Choose the installation method that works best for your use case.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="grid grid-cols-1 gap-4 md:grid-cols-3"
        >
          {/* Option 1: SDK */}
          <div className="group flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="mb-4 flex items-center gap-3">
              <div className="text-zinc-500">
                <Code className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-base font-normal text-white">TypeScript SDK</h3>
                <p className="text-xs text-zinc-500">Embed in your application</p>
              </div>
            </div>

            <p className="mb-4 text-sm leading-relaxed text-zinc-500">
              Import the TypeScript SDK directly into your Node or browser application. Full type safety and streaming support.
            </p>

            <div className="flex-1 flex flex-col">
              <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0c0c0e] flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2">
                  <span className="text-[10px] font-medium text-zinc-500">example.ts</span>
                  <CopyButton text={sdkCodeRaw} />
                </div>
                <SdkCodeHighlighted />
              </div>
            </div>
          </div>

          {/* Option 2: HTTP API */}
          <div className="group flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="mb-4 flex items-center gap-3">
              <div className="text-zinc-500">
                <Server className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-base font-normal text-white">HTTP API</h3>
                <p className="text-xs text-zinc-500">Run as a server</p>
              </div>
            </div>

            <p className="mb-4 text-sm leading-relaxed text-zinc-500">
              Run as an HTTP server and connect from any language. Deploy to E2B, Daytona, Vercel, or your own infrastructure.
            </p>

            <div className="flex-1 flex flex-col">
              <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0c0c0e] flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2">
                  <span className="text-[10px] font-medium text-zinc-500">terminal</span>
                  <CopyButton text={sandboxCommand} />
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed flex-1">
                  <code>
                    <span className="text-zinc-500">$ </span>
                    <span className="text-zinc-300">curl -fsSL \</span>
                    {"\n"}
                    <span className="text-zinc-300">{"    "}</span>
                    <span className="text-green-400">https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh</span>
                    <span className="text-zinc-300"> | </span>
                    <span className="text-blue-400">sh</span>
                  </code>
                </pre>
              </div>
            </div>
          </div>

          {/* Option 3: Open Source */}
          <div className="group flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/20">
            <div className="mb-4 flex items-center gap-3">
              <div className="text-zinc-500">
                <GitBranch className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-base font-normal text-white">Open Source</h3>
                <p className="text-xs text-zinc-500">Full control</p>
              </div>
            </div>

            <p className="mb-4 text-sm leading-relaxed text-zinc-500">
              Clone the repo and build with Cargo. Customize, contribute, or embed directly in your Rust project.
            </p>

            <div className="flex-1 flex flex-col">
              <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0c0c0e] flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2">
                  <span className="text-[10px] font-medium text-zinc-500">terminal</span>
                  <CopyButton text={sourceCommands} />
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed flex-1">
                  <code>
                    <span className="text-zinc-500">$ </span>
                    <span className="text-blue-400">git clone</span>
                    <span className="text-zinc-300"> </span>
                    <span className="text-green-400">https://github.com/rivet-dev/sandbox-agent</span>
                    {"\n"}
                    <span className="text-zinc-500">$ </span>
                    <span className="text-blue-400">cd</span>
                    <span className="text-zinc-300"> sandbox-agent</span>
                    {"\n"}
                    <span className="text-zinc-500">$ </span>
                    <span className="text-blue-400">cargo run</span>
                    <span className="text-zinc-300"> -p sandbox-agent --release</span>
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
