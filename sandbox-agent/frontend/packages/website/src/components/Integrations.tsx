"use client";

const integrations = ["Daytona", "E2B", "AI SDK", "Anthropic", "OpenAI", "Docker", "Fly.io", "AWS Nitro", "Postgres", "ClickHouse", "Rivet"];

export function Integrations() {
  return (
    <section id="integrations" className="py-24 bg-[#0f0f11]/50 border-t border-white/5 relative overflow-hidden">
      <div className="max-w-4xl mx-auto px-6 text-center">
        <h2 className="text-3xl font-semibold text-white mb-6">Works with your stack</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {integrations.map((item) => (
            <div
              key={item}
              className="h-16 flex items-center justify-center rounded-xl border border-white/5 bg-white/[0.02] text-zinc-300 font-mono text-sm hover:border-accent/40 hover:text-accent transition-all cursor-default"
            >
              {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
