// 容器可播性：内置播放器（WebView2/Chromium）只接受 mp4/m4v、webm、ogg，
// MKV 因与 webm 同源通常也能播；AVI/FLV/ASF/TS 一律不接受（放不了是容器层的事，
// 与里面是什么编码无关）。判定与 Rust `probe.rs::container_hint` 同源——改一处必须同步另一处。
//
// 只标**已知**放不了的容器：容器未知（老数据 null）时不吓唬人，等扫过一次再说。

const LABEL: Record<string, string> = {
  avi: "AVI",
  flv: "FLV",
  asf: "ASF",
  "mpeg-ts": "TS",
};

/**
 * 列表页角标：返回放不了的容器的短标签（`AVI` / `FLV` …），能播或未知返回 null。
 * 传进来的是 Rust 侧读文件头得到的容器名，不是扩展名。
 */
export function unplayableContainerLabel(
  container: string | null,
): string | null {
  if (!container) return null;
  const c = container.toLowerCase();
  if (c.startsWith("mp4") || c.includes("webm") || c.includes("matroska")) {
    return null;
  }
  // "asf / wmv" -> "asf"、"mp4 (isom)" -> "mp4"
  const short = c.split(/[\s(]/)[0];
  return LABEL[short] ?? null;
}
