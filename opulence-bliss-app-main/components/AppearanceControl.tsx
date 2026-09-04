"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";

const OPTIONS = [
  { value: "system", label: "Use device setting", icon: "◐" },
  { value: "light", label: "Light", icon: "☀" },
  { value: "dark", label: "Dark", icon: "☾" },
] as const;

type Appearance = (typeof OPTIONS)[number]["value"];

export default function AppearanceControl() {
  const path = usePathname() ?? "";
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    function close(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!mounted) return null;

  const selected = (theme ?? "system") as Appearance;
  const dark = resolvedTheme === "dark";
  const portal = path.startsWith("/account") || path.startsWith("/worker");

  return (
    <div ref={root} className={`appearance-control${portal ? " portal" : ""}`}>
      {open && (
        <div className="appearance-menu" role="menu" aria-label="Appearance">
          <strong>Appearance</strong>
          <span>Choose how Opulence Bliss looks on this device.</span>
          {OPTIONS.map((option) => {
            const active = selected === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={
                  active ? "appearance-option active" : "appearance-option"
                }
                onClick={() => {
                  setTheme(option.value);
                  setOpen(false);
                }}
              >
                <span aria-hidden="true">{option.icon}</span>
                {option.label}
                <span className="appearance-check" aria-hidden="true">
                  {active ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="appearance-trigger"
        aria-label={`Appearance: ${selected}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{dark ? "☾" : "☀"}</span>
        <span className="appearance-trigger-label">Appearance</span>
      </button>
    </div>
  );
}
