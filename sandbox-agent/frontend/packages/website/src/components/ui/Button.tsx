import type { ReactNode } from "react";

interface ButtonProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  href?: string;
  onClick?: () => void;
  className?: string;
}

export function Button({ children, variant = "primary", size = "md", href, onClick, className = "" }: ButtonProps) {
  const baseStyles = "inline-flex items-center justify-center font-medium rounded-lg transition-all";

  const variants = {
    primary: "bg-white text-black hover:bg-zinc-200",
    secondary: "bg-[#0f0f11] border border-white/10 text-white hover:bg-white/[0.06]",
    ghost: "text-zinc-400 hover:text-white",
  };

  const sizes = {
    sm: "h-9 px-4 text-sm",
    md: "h-12 px-8 text-sm",
    lg: "h-14 px-10 text-base",
  };

  const classes = `${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`;

  if (href) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }

  return (
    <button onClick={onClick} className={classes}>
      {children}
    </button>
  );
}
