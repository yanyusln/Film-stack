// 离线与权限审计（W7-3 / 技术方案 §12 不联网原则、§17.3）：
// 确认无远端调用与遥测、CSP 不含外部域名且放行内联样式、权限最小化、
// asset scope 不放通用户目录、Android manifest 无网络权限、ffmpeg 参数不走 shell 拼接。
// 只读扫描，不联网、不改文件；任一项失败以 exit 1 结束，供 CI 卡口。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.cwd();
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
}

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git" || entry === "target")
        continue;
      walk(p, exts, out);
    } else if (exts.includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

function linesOf(file) {
  return readFileSync(file, "utf8").split(/\r?\n/);
}

/** 跳过注释行与本地协议白名单行，避免把说明文字当成真实调用 */
function isNoise(line) {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("#") ||
    /localhost|127\.0\.0\.1|ipc:|asset:|tauri\.app|w3\.org/.test(t)
  );
}

// ① 依赖黑名单：任何网络请求库或遥测 SDK 都不允许进入依赖树
const BANNED_DEPS = [
  "axios",
  "node-fetch",
  "superagent",
  "got",
  "request",
  "ws",
  "socket.io",
  "socket.io-client",
  "@sentry/browser",
  "@sentry/vue",
  "posthog-js",
  "mixpanel-browser",
  "amplitude-js",
  "@amplitude/analytics-browser",
  "@segment/analytics-next",
  "@vercel/analytics",
  "react-ga",
  "firebase",
];
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const all = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const hit = BANNED_DEPS.filter((d) => all[d]);
  record(
    "依赖无网络请求库 / 遥测 SDK",
    hit.length === 0,
    hit.length
      ? `命中：${hit.join(", ")}`
      : `已扫描 ${Object.keys(all).length} 个依赖`,
  );
}

// ② 源码无远端调用
{
  const files = [
    ...walk(join(ROOT, "src"), [".ts", ".vue", ".js"]),
    ...walk(join(ROOT, "src-tauri/src"), [".rs"]),
  ];
  const patterns = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /new\s+WebSocket/,
    /EventSource\s*\(/,
    /sendBeacon\s*\(/,
    /importScripts\s*\(/,
  ];
  const hits = [];
  for (const f of files) {
    linesOf(f).forEach((line, i) => {
      if (isNoise(line)) return;
      if (patterns.some((re) => re.test(line))) {
        hits.push(
          `${f.replace(ROOT + "\\", "")}:${i + 1} ${line.trim().slice(0, 80)}`,
        );
      }
    });
  }
  record(
    "源码无 fetch / XHR / WebSocket / 上报调用",
    hits.length === 0,
    hits.length
      ? hits.slice(0, 5).join(" | ")
      : `已扫描 ${files.length} 个源文件`,
  );
}

// ③ 构建产物无远程资源（未构建则跳过，不算失败）
{
  const dist = join(ROOT, "dist");
  if (!existsSync(dist)) {
    record("产物无远程 URL", true, "未构建，跳过");
  } else {
    const files = [
      ...walk(dist, [".js", ".css", ".html"]),
      ...(existsSync(join(dist, "index.html"))
        ? [join(dist, "index.html")]
        : []),
    ];
    const allow =
      /localhost|127\.0\.0\.1|0\.0\.0\.0|w3\.org|schemas\.microsoft\.com|schemas\.openxmlformats\.org|ns\.adobe\.com|purl\.org/;
    const hits = [];
    const notes = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/https?:\/\/[^\s"'()<>\\]+/g)) {
        if (allow.test(m[0])) continue;
        // 只把「加载型引用」判为失败：CSS url()、src/href、fetch/import；
        // 报错文案与注释里的文档链接不产生网络行为，记为提示。
        const before = text.slice(Math.max(0, m.index - 24), m.index);
        const loading =
          /(url\(\s*|url\('?|url\("?|href=|src=|fetch\(|import\()$/i.test(
            before,
          );
        const where = `${f.replace(ROOT + "\\", "")} -> ${m[0]}`;
        (loading ? hits : notes).push(where);
      }
    }
    record(
      "产物无远程资源加载",
      hits.length === 0,
      hits.length
        ? [...new Set(hits)].slice(0, 5).join(" | ")
        : `已扫描 ${files.length} 个产物文件${
            notes.length
              ? `；仅文档/报错文本中的链接 ${[...new Set(notes)].length} 处（无加载行为）`
              : ""
          }`,
    );
  }
}

// ④ CSP：不含外部域名，media-src 不放 https，connect-src 只走 ipc
{
  const confPath = join(ROOT, "src-tauri/tauri.conf.json");
  if (!existsSync(confPath)) {
    record("CSP 配置存在", false, "未找到 src-tauri/tauri.conf.json");
  } else {
    const conf = JSON.parse(readFileSync(confPath, "utf8"));
    const csp = conf?.app?.security?.csp ?? "";
    if (!csp) {
      record("CSP 配置存在", false, "app.security.csp 为空");
    } else {
      const hosts = [...csp.matchAll(/https?:\/\/([^\s;]+)/g)].map((m) => m[1]);
      const bad = hosts.filter(
        (h) => !/^(asset|ipc)\.localhost$|localhost|127\.0\.0\.1/.test(h),
      );
      record(
        "CSP 不含外部域名",
        bad.length === 0,
        bad.length
          ? `命中：${bad.join(", ")}`
          : `白名单内：${hosts.join(", ") || "无 http 源"}`,
      );
      const media = /media-src([^;]*)/.exec(csp)?.[1] ?? "";
      record("media-src 不放通 https", !/https:/.test(media), media.trim());
      const conn = /connect-src([^;]*)/.exec(csp)?.[1] ?? "";
      record(
        "connect-src 仅 ipc",
        /ipc:/.test(conn) && !/https?:\/\/(?!ipc\.localhost)/.test(conn),
        conn.trim(),
      );
    }
  }
}

// ⑤ ffmpeg：参数强类型数组传入，禁止 shell 拼接
{
  const files = walk(join(ROOT, "src-tauri/src"), [".rs"]);
  const forbidden = [
    /Command::new\("sh"\)/,
    /Command::new\("cmd"\)/,
    /sh\s+-c/,
    /cmd\s+\/C/,
  ];
  const bad = [];
  let commands = 0;
  for (const f of files) {
    let text = readFileSync(f, "utf8");
    // 只审计**进产物**的代码：测试模块（一律在文件末尾）里为了造超时会起 cmd/sleep，
    // 那是测试脚手架，不是应用的进程调用，不该让门禁失守。
    const testAt = text.indexOf("#[cfg(test)]");
    if (testAt >= 0) text = text.slice(0, testAt);
    if (!/Command::new\(/.test(text)) continue;
    commands += 1;
    if (forbidden.some((re) => re.test(text))) bad.push(`${f} 命中 shell 调用`);
    if (!/\.args?\(/.test(text)) bad.push(`${f} 未使用 .arg/.args 传参`);
  }
  record(
    "外部命令参数为强类型数组、不走 shell",
    bad.length === 0,
    bad.length ? bad.join(" | ") : `已检查 ${commands} 处 Command::new`,
  );
}

// ⑥ 内联样式：Tauri WebView 真会执行 CSP，default-src 'self' 会连带把 style 属性拦掉
{
  const confPath = join(ROOT, "src-tauri/tauri.conf.json");
  const conf = existsSync(confPath)
    ? JSON.parse(readFileSync(confPath, "utf8"))
    : {};
  const csp = conf?.app?.security?.csp ?? "";
  const style = /style-src([^;]*)/.exec(csp)?.[1] ?? "";
  record(
    "CSP 放行内联样式",
    /'unsafe-inline'|'unsafe-hashes'/.test(style),
    style.trim() ||
      "未声明 style-src（继承 default-src 'self'，style 属性会被拦）",
  );
}

// ⑦ 能力权限最小化：声明的插件权限必须在前端真的用到，用到却没声明也不行
{
  const capDir = join(ROOT, "src-tauri/capabilities");
  const caps = existsSync(capDir)
    ? readdirSync(capDir).filter((f) => f.endsWith(".json"))
    : [];
  const declared = new Set();
  for (const c of caps) {
    const perms =
      JSON.parse(readFileSync(join(capDir, c), "utf8"))?.permissions ?? [];
    for (const p of perms) declared.add(String(p).split(":")[0]);
  }
  // core 由 @tauri-apps/api 提供，不属于可选插件，不参与最小化判定
  const PLUGIN = {
    fs: "@tauri-apps/plugin-fs",
    sql: "@tauri-apps/plugin-sql",
    dialog: "@tauri-apps/plugin-dialog",
  };
  const srcText = [
    ...walk(join(ROOT, "src"), [".ts", ".vue", ".js"]),
    ...walk(join(ROOT, "e2e"), [".ts"]),
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const unused = [...declared].filter(
    (k) => PLUGIN[k] && !srcText.includes(PLUGIN[k]),
  );
  const missing = Object.entries(PLUGIN)
    .filter(([k, pkg]) => srcText.includes(pkg) && !declared.has(k))
    .map(([k]) => k);
  record(
    "能力权限与实际用到的插件一致",
    unused.length === 0 && missing.length === 0,
    unused.length
      ? `声明但未使用：${unused.join(", ")}`
      : missing.length
        ? `使用但未声明：${missing.join(", ")}`
        : `已声明：${[...declared].join(", ")}`,
  );
}

// ⑧ asset 协议 scope：静态放行只覆盖缩略图目录，不放通用户根目录
{
  const confPath = join(ROOT, "src-tauri/tauri.conf.json");
  const conf = existsSync(confPath)
    ? JSON.parse(readFileSync(confPath, "utf8"))
    : {};
  const allow = conf?.app?.security?.assetProtocol?.scope?.allow ?? [];
  const wide = allow.filter(
    (p) =>
      p === "**" ||
      /^\/(?!\*)/.test(p) ||
      /^\$(HOME|DESKTOP|DOCUMENT|DOWNLOAD|APPDATA)\/?(\*\*)?$/.test(p),
  );
  record(
    "asset scope 只放行缩略图目录",
    allow.length > 0 && wide.length === 0,
    allow.length
      ? wide.length
        ? `过宽：${wide.join(", ")}`
        : `allow：${allow.join(", ")}`
      : "未配置 asset scope",
  );
}

// ⑨ Android manifest：无网络与危险权限（C3 不联网）；未初始化 Android 工程则跳过
{
  const genAndroid = join(ROOT, "src-tauri/gen/android");
  let files = [];
  if (existsSync(genAndroid)) {
    files = walk(genAndroid, [".xml"]).filter((p) =>
      p.endsWith("AndroidManifest.xml"),
    );
  }
  if (!files.length) {
    record(
      "Android manifest 无网络权限",
      true,
      "未初始化 Android 工程（src-tauri/gen/android 不存在），跳过",
    );
  } else {
    const banned = [
      "INTERNET",
      "ACCESS_NETWORK_STATE",
      "READ_PHONE_STATE",
      "ACCESS_FINE_LOCATION",
      "ACCESS_COARSE_LOCATION",
      "READ_CONTACTS",
      "WRITE_EXTERNAL_STORAGE",
    ];
    const hits = [];
    const notes = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/android\.permission\.([A-Z_]+)/g)) {
        if (banned.includes(m[1])) hits.push(m[1]);
      }
      if (!/supportsPictureInPicture/.test(text))
        notes.push("未声明 supportsPictureInPicture");
      if (!/READ_MEDIA_VIDEO|READ_EXTERNAL_STORAGE/.test(text))
        notes.push("未声明媒体读取权限");
    }
    record(
      "Android manifest 无网络/危险权限",
      hits.length === 0,
      hits.length
        ? `命中：${[...new Set(hits)].join(", ")}`
        : `${files.length} 个 manifest${
            notes.length ? `；提示：${[...new Set(notes)].join("、")}` : ""
          }`,
    );
  }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`,
  );
}
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
