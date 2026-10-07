// 容器可播性：内置播放器（WebView2 / Android WebView 同为 Chromium）实际接受的容器
// 只有 mp4/m4v、webm、ogg —— MKV（matroska）**不在内**，它虽然与 webm 同源，
// Chromium 就是不认，送进 `<video>` 只会报「源不可用」；把它算成可播是这里最贵的一个错。
// AVI/FLV/ASF(WMV)/MOV/TS/RM/VOB 同理，放不了是容器层的事，与里面什么编码无关。
//
// 判定与 Rust `probe.rs::container_hint` 同源——改一处必须同步另一处。
//
// 只标**已知**放不了的容器：容器未知（老数据 null、没扫过）时不吓唬人，
// 等播放失败后的自检（probe）兜底。

const PLAYABLE = ["mp4", "m4v", "webm", "ogg", "ogv"];

/** 已知放不了 → 列表页角标上显示的短标签。 */
const LABEL: Record<string, string> = {
  matroska: "MKV",
  mkv: "MKV",
  avi: "AVI",
  flv: "FLV",
  asf: "ASF",
  wmv: "ASF",
  mov: "MOV",
  quicktime: "MOV",
  "mpeg-ts": "TS",
  m2ts: "TS",
  ts: "TS",
  mpeg: "MPEG",
  mpg: "MPEG",
  rm: "RM",
  rmvb: "RM",
  vob: "VOB",
  "3gp": "3GP",
};

/**
 * 列表页角标：返回放不了的容器的短标签（`MKV` / `AVI` …），能播或未知返回 null。
 * 传进来的是 Rust 侧读文件头得到的容器名，不是扩展名。
 */
export function unplayableContainerLabel(
  container: string | null,
): string | null {
  if (!container) return null;
  // "mp4 (isom)" -> "mp4"、"asf / wmv" -> "asf"、"matroska / webm" -> "matroska"
  const short = container.toLowerCase().split(/[\s/(]/)[0];
  if (!short) return null;
  if (PLAYABLE.includes(short)) return null;
  return LABEL[short] ?? null;
}
