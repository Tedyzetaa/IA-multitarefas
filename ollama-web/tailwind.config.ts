import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        // Off-white / light theme surface
        surface: {
          light: "#FAF9F6",
          "light-raised": "#FFFFFF",
          "light-sunken": "#F0EEE7",
          dark: "#1E1E1D",
          "dark-raised": "#292927",
          "dark-sunken": "#141413",
        },
        // Anthropic-style clay/terracotta accent
        accent: {
          DEFAULT: "#D97757",
          hover: "#C4653F",
          soft: "#F3E3DB",
        },
        border: {
          light: "#E8E6DF",
          dark: "#383836",
        },
        ink: {
          light: "#2B2A28",
          dark: "#ECECE9",
          muted: "#87867F",
        },
      },
      borderRadius: {
        xl2: "1.25rem",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        fadeIn: {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
      },
      animation: {
        blink: "blink 1s step-start infinite",
        fadeIn: "fadeIn 0.2s ease-out",
        slideIn: "slideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
