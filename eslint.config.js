// ESLint 9 flat config（Vue 3 + TypeScript）。
// 规则取保守集：vue essential + 基础推荐（不做类型感知），保证提交门禁可跑通且不误伤。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import globals from "globals";

const tsRules = {
  // TS 文件关闭基础规则，避免与 TS 变体重复/误报（类型声明参数等）
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "vue/multi-word-component-names": "off",
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src-tauri/**",
      "node_modules/**",
      "tmp/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "*.min.js",
    ],
  },
  js.configs.recommended,
  ...pluginVue.configs["flat/essential"],
  {
    // TS / MTS：顶层用 TS 解析器
    files: ["**/*.{ts,mts}"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: { ...globals.browser },
    },
    rules: tsRules,
  },
  {
    // Vue SFC：vue-eslint-parser + 内层 TS 解析器
    files: ["**/*.vue"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
      globals: { ...globals.browser },
    },
    rules: tsRules,
  },
  {
    // Playwright：配置与用例跑在 node 侧，但用例里也会碰 window/document
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // 构建/工具链配置跑在 node 侧：vite.config.ts 要读 TAURI_ENV_PLATFORM / TAURI_DEV_HOST
    // 来区分「桌面钉 127.0.0.1」与「移动端监听 0.0.0.0」，不能按浏览器全局报 no-undef
    files: ["**/*.config.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
);
