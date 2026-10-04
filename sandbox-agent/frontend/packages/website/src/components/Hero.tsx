"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Terminal, Check, ArrowRight } from "lucide-react";

const ADAPTERS = [
  { label: "Claude Code", color: "#D97757", x: 20, y: 70, logo: "/logos/claude.svg" },
  { label: "Codex", color: "#10A37F", x: 132, y: 70, logo: "openai" },
  { label: "Pi", color: "#06B6D4", x: 244, y: 70, logo: "pi" },
  { label: "Amp", color: "#F59E0B", x: 76, y: 155, logo: "/logos/amp.svg" },
  { label: "OpenCode", color: "#8B5CF6", x: 188, y: 155, logo: "opencode" },
];

function UniversalAPIDiagram() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % ADAPTERS.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative w-full aspect-[4/3] sm:aspect-[16/9] bg-[#0c0c0e] rounded-xl border border-white/10 overflow-hidden flex items-center justify-center shadow-2xl">
      {/* Background Dots - color changes with active adapter */}
      <div
        className="absolute inset-0 opacity-[0.15] pointer-events-none transition-all duration-1000"
        style={{
          backgroundImage: `radial-gradient(circle, ${ADAPTERS[activeIndex].color} 1px, transparent 1px)`,
          backgroundSize: "24px 24px",
        }}
      />

      <svg viewBox="0 0 800 450" className="w-full h-full relative z-10">
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
          <filter id="invert-white" colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" />
          </filter>
        </defs>

        {/* YOUR APP NODE - Glass dark effect with backdrop blur */}
        <foreignObject x="60" y="175" width="180" height="100">
          <div className="w-full h-full rounded-xl border border-white/10 bg-[#09090b]/60 backdrop-blur-md flex items-center justify-center">
            <span className="text-white text-xl font-bold">Your App</span>
          </div>
        </foreignObject>

        {/* HTTP/SSE LINE */}
        <g>
          <path d="M240 225 L360 225" stroke="#3B82F6" strokeWidth="2" strokeDasharray="6 4" fill="none" opacity="0.6" />
          <circle r="4" fill="#3B82F6" filter="url(#glow)">
            <animateMotion path="M240 225 L360 225" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle r="4" fill="#3B82F6" filter="url(#glow)">
            <animateMotion path="M360 225 L240 225" dur="2s" repeatCount="indefinite" />
          </circle>

          <rect x="255" y="195" width="90" height="22" rx="11" fill="#111" stroke="#333" strokeWidth="1" />
          <text x="300" y="210" fill="#60A5FA" textAnchor="middle" fontSize="11" fontWeight="800" fontFamily="monospace">
            HTTP / SSE
          </text>
        </g>

        {/* SANDBOX BOUNDARY - Glass dark effect with backdrop blur */}
        <foreignObject x="360" y="45" width="410" height="360">
          <div className="w-full h-full rounded-xl border border-white/10 bg-[#09090b]/60 backdrop-blur-md">
            <div className="text-white text-sm font-extrabold tracking-[0.2em] text-center pt-4">SANDBOX</div>
          </div>
        </foreignObject>

        {/* SANDBOX AGENT SDK */}
        <g transform="translate(385, 110)">
          <rect width="360" height="270" rx="20" fill="rgba(0,0,0,0.4)" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          <text x="180" y="35" fill="#FFFFFF" textAnchor="middle" fontSize="18" fontWeight="800">
            Sandbox Agent Server
          </text>

          {/* PROVIDER ADAPTERS */}
          {ADAPTERS.map((p, i) => {
            const isActive = i === activeIndex;
            return (
              <g key={i} transform={`translate(${p.x}, ${p.y})`}>
                <rect
                  width="95"
                  height="58"
                  rx="10"
                  fill={isActive ? "#1A1A1E" : "#111"}
                  stroke={isActive ? p.color : "#333"}
                  strokeWidth={isActive ? 2 : 1.5}
                />
                <g opacity={isActive ? 1 : 0.4}>
                  {p.logo === "openai" ? (
                    <svg x="36.75" y="8" width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
                        fill="#ffffff"
                      />
                    </svg>
                  ) : p.logo === "opencode" ? (
                    <svg x="38.5" y="8" width="17" height="22" viewBox="0 0 32 40" fill="none">
                      <path d="M24 32H8V16H24V32Z" fill="#4B4646" />
                      <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#F1ECEC" />
                    </svg>
                  ) : p.logo === "pi" ? (
                    <svg x="36.75" y="8" width="22" height="22" viewBox="0 0 800 800" fill="none">
                      <path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
                      <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
                    </svg>
                  ) : (
                    <image href={p.logo} x="36.75" y="8" width="22" height="22" filter="url(#invert-white)" />
                  )}
                </g>
                <text x="47.5" y="46" fill="#FFFFFF" textAnchor="middle" fontSize="10" fontWeight="600" opacity={isActive ? 1 : 0.4}>
                  {p.label}
                </text>
              </g>
            );
          })}

          {/* Active Agent Label */}
          <text
            x="180"
            y="250"
            fill={ADAPTERS[activeIndex].color}
            textAnchor="middle"
            fontSize="12"
            fontWeight="800"
            fontFamily="monospace"
            letterSpacing="0.1em"
          >
            CONNECTED TO {ADAPTERS[activeIndex].label.toUpperCase()}
          </text>
        </g>
      </svg>
    </div>
  );
}

const CopyInstallButton = () => {
  const [copied, setCopied] = useState(false);
  const installCommand = "npx skills add rivet-dev/skills -s sandbox-agent";
  const shortCommand = "npx skills add rivet-dev/skills";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="relative group w-full sm:w-auto">
      <button
        onClick={handleCopy}
        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white font-mono"
      >
        {copied ? <Check className="h-4 w-4 text-green-400" /> : <Terminal className="h-4 w-4 flex-shrink-0" />}
        <span className="hidden sm:inline">{installCommand}</span>
        <span className="sm:hidden">{shortCommand}</span>
      </button>
      <div className="absolute left-1/2 -translate-x-1/2 top-full mt-3 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 ease-out text-xs text-zinc-500 whitespace-nowrap pointer-events-none font-mono">
        Give this to your coding agent
      </div>
    </div>
  );
};

export function Hero() {
  const [scrollOpacity, setScrollOpacity] = useState(1);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const updateViewportMode = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      if (mobile) {
        setScrollOpacity(1);
      }
    };

    const handleScroll = () => {
      if (window.innerWidth < 1024) {
        setScrollOpacity(1);
        return;
      }
      const scrollY = window.scrollY;
      const windowHeight = window.innerHeight;
      const fadeStart = windowHeight * 0.15;
      const fadeEnd = windowHeight * 0.5;
      const opacity = 1 - Math.min(1, Math.max(0, (scrollY - fadeStart) / (fadeEnd - fadeStart)));
      setScrollOpacity(opacity);
    };

    updateViewportMode();
    handleScroll();
    window.addEventListener("resize", updateViewportMode);
    window.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("resize", updateViewportMode);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  return (
    <section className="relative flex min-h-screen flex-col overflow-hidden pb-24 lg:pb-0">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-zinc-900/20 via-transparent to-transparent pointer-events-none" />

      {/* Main content */}
      <div
        className="flex flex-1 flex-col justify-start pt-32 lg:justify-center lg:pt-0 lg:pb-20 px-6"
        style={isMobile ? undefined : { opacity: scrollOpacity, filter: `blur(${(1 - scrollOpacity) * 8}px)` }}
      >
        <div className="mx-auto w-full max-w-7xl">
          <div className="flex flex-col gap-12 lg:flex-row lg:items-center lg:justify-between lg:gap-16 xl:gap-24">
            {/* Left side - Text content */}
            <div className="max-w-xl lg:max-w-2xl">
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="mb-6 text-3xl font-semibold leading-[1.1] tracking-tight text-white md:text-5xl"
              >
                Run Coding Agents in Sandboxes.
                <br />
                <span className="text-zinc-400">Control Them Over HTTP.</span>
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="mb-8 text-lg text-zinc-500 leading-relaxed"
              >
                The Sandbox Agent SDK is a server that runs inside your sandbox. Your app connects remotely to control Claude Code, Codex, OpenCode, Amp, or Pi
                — streaming events, handling permissions, managing sessions.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="flex flex-col gap-3 sm:flex-row"
              >
                <a
                  href="/docs"
                  className="selection-dark inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-white px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-zinc-200"
                >
                  Read the Docs
                  <ArrowRight className="h-4 w-4" />
                </a>
                <CopyInstallButton />
              </motion.div>
            </div>

            {/* Right side - Diagram */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.3 }}
              className="flex-1 w-full max-w-2xl"
            >
              <UniversalAPIDiagram />
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
