import type { AssetGrant, VideoProbe } from "@/bridge/contracts";

// 播放失败分诊（v1 反馈：真机「加载失败：文件可能不存在或编码不受支持」一句话糊住三种原因）。
// `<video>` 的 error.code 本身就能分出「源不可用 / 解码失败 / 读取失败」，
// 再拼上 asset 协议的放行结果，用户一眼能看出是该去查授权还是查编码。
// 纯函数、可单测，文案改动必须同步用例（与 emptyStates 同一条纪律）。

/** MediaError.code 的标准取值（HTML 规范）。 */
export const MEDIA_ERR = {
  /** 1: 用户/代码主动中止 */
  ABORTED: 1,
  /** 2: 网络/协议层拿不到数据 */
  NETWORK: 2,
  /** 3: 拿到数据但解不出来 */
  DECODE: 3,
  /** 4: 源不可用（找不到、格式不支持、协议未放行） */
  SRC_NOT_SUPPORTED: 4,
} as const;

const CAUSE: Record<number, string> = {
  [MEDIA_ERR.ABORTED]: "播放被中止",
  [MEDIA_ERR.NETWORK]:
    "读取文件失败：目录未被 asset 协议放行，或文件被占用 / 已移动",
  [MEDIA_ERR.DECODE]: "解码失败：文件损坏或编码不受支持",
  [MEDIA_ERR.SRC_NOT_SUPPORTED]:
    "源不可用：编码不受支持，或该目录未被 asset 协议放行",
};

// `already_allowed` = 目录本来就在 scope 里（无需重复放行），是成功态；
// 只看 `applied` 会把它误标成"未放行"，把人往授权方向带偏（v1 反馈实证）。
function isGranted(grant: AssetGrant): boolean {
  return grant.applied || grant.reason === "already_allowed";
}

/** 组合出给界面的一句话：`<原因>（授权 <reason><是否已放行>）`。code 为 0/未知时给兜底文案。 */
export function mediaErrorText(
  code: number,
  grant?: AssetGrant | null,
): string {
  const cause = CAUSE[code] ?? "播放失败";
  if (!grant) return `${cause}（授权：未执行）`;
  // Android / iOS 上 asset 放行是 no-op（`skipped_mobile`），它不是"没放行成功"。
  // 按未放行展示会把人往授权方向带偏——这两个平台本来就不走 asset scope。
  if (grant.reason === "skipped_mobile")
    return `${cause}（授权：本平台不适用）`;
  const verdict = isGranted(grant) ? "已放行" : "未放行";
  return `${cause}（授权：${grant.reason} · ${verdict}）`;
}

/** 自检结果的一句话摘要：把"文件在不在 / 多大 / 什么编码"摆到台面上。 */
export function probeSummary(p: VideoProbe | null): string {
  if (!p) return "自检中…";
  if (!p.exists) return `自检：${p.note ?? "文件不存在"}`;
  const mb = p.size != null ? `${Math.round(p.size / 1048576)}MB` : "大小未知";
  const codec =
    p.videoCodec ?? (p.audioCodec ? `仅音频 ${p.audioCodec}` : "编码未识别");
  // 先说容器（放不了的主因），再说编码（还能不能救）
  const hints = [p.containerHint, p.unsupportedHint]
    .filter(Boolean)
    .join(" · ");
  const hint = hints ? ` · ${hints}` : "";
  const note = p.note ? ` · ${p.note}` : "";
  return `自检：${mb} · ${p.container ?? "未知容器"} · ${codec}${hint}${note}`;
}

/**
 * 放不了时的「下一步」——**按平台分岔，不要同一套话术**：
 * 桌面有终端可跑 ffmpeg；Android 既没有终端也没有 ffmpeg，给命令等于骗人
 * （真机反馈：复制到 PowerShell 报「ffmpeg 不是可识别的命令」）。
 */
export function remuxHelp(isAndroid: boolean): string {
  return isAndroid
    ? "手机上没有终端也没有 ffmpeg，命令行转封装不适用。请用 MX Player / VLC 打开该文件（自带解码器，能播 AVI）；或回到电脑上转好再传进手机。"
    : "复制下面这行到终端执行（输出到 *_remux.mp4，不动原文件）。若提示「ffmpeg 不是可识别的命令」：先在 PowerShell 跑 winget install Gyan.FFmpeg（或到 gyan.dev 下载解压、把 bin 加进 PATH），装完重开终端。";
}

/**
 * 转封装失败原因码 → 人话。
 * 界面直接吐原始码（`ffmpeg_missing`）等于把排查工作丢给用户；
 * 而 Android 上报的是"平台不支持"，给命令行建议是骗人——这两句必须分岔。
 */
export function remuxReasonText(reason: string | null): string {
  if (!reason) return "未知原因";
  if (reason.startsWith("io_error")) return "读写缓存失败";
  const MAP: Record<string, string> = {
    unsupported_platform: "当前平台不支持（手机上没有 ffmpeg）",
    ffmpeg_missing: "没找到 ffmpeg",
    ffmpeg_failed: "ffmpeg 执行失败",
    source_missing: "源文件读不到",
    timeout: "转换超时",
    invoke_failed: "桥接调用失败",
  };
  return MAP[reason] ?? reason;
}
