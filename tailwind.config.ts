import type { Config } from "tailwindcss";

// 设计令牌集中在 src/styles/tokens.css（@theme）；此处仅声明内容扫描与三端断点。
// 断点对齐技术方案 §9.1：sm 360 / md 600 / lg 840 / xl 1440（min-width）。
export default {
  content: ["./index.html", "./src/**/*.{vue,ts,tsx}"],
  darkMode: "class",
  theme: {
    screens: {
      sm: "360px",
      md: "600px",
      lg: "840px",
      xl: "1440px",
    },
    extend: {},
  },
} satisfies Config;
