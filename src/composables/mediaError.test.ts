import { describe, expect, it } from "vitest";
import type { AssetGrant } from "@/bridge/contracts";
import {
  mediaErrorText,
  probeSummary,
  remuxHelp,
  remuxReasonText,
} from "./mediaError";

function grant(patch: Partial<AssetGrant> = {}): AssetGrant {
  return {
    path: "D:\\v",
    kind: null,
    mode: null,
    applied: true,
    reason: "granted",
    ...patch,
  };
}

describe("播放失败分诊文案", () => {
  it("源不可用就说清是编码还是放行问题", () => {
    expect(mediaErrorText(4, grant())).toBe(
      "源不可用：编码不受支持，或该目录未被 asset 协议放行（授权：granted · 已放行）",
    );
  });

  it("没放行成功时标出来，方便一眼看出不是编码问题", () => {
    expect(
      mediaErrorText(2, grant({ applied: false, reason: "kind_not_allowed" })),
    ).toContain("未放行");
    expect(
      mediaErrorText(2, grant({ applied: false, reason: "path_missing" })),
    ).toContain("path_missing · 未放行");
  });

  it("already_allowed 是成功态，不能标成未放行", () => {
    // 真机实证：目录本来就在 scope 里时 applied=false，若只看 applied 会把人往授权方向带偏
    const t = mediaErrorText(
      4,
      grant({ applied: false, reason: "already_allowed" }),
    );
    expect(t).toContain("已放行");
    expect(t).not.toContain("未放行");
  });

  it("拿不到授权结果、code 未知都有兜底", () => {
    expect(mediaErrorText(4, null)).toBe(
      "源不可用：编码不受支持，或该目录未被 asset 协议放行（授权：未执行）",
    );
    expect(mediaErrorText(0, grant())).toBe(
      "播放失败（授权：granted · 已放行）",
    );
    expect(mediaErrorText(3, grant())).toContain("解码失败");
  });
});

describe("自检摘要", () => {
  const base = {
    path: "E:\\a.mp4",
    exists: true,
    size: 3_300_000_000,
    container: "mp4 (isom)",
    videoCodec: "hevc (h.265)",
    audioCodec: "aac",
    videoSupported: false,
    unsupportedHint: "hevc (h.265) 不在 WebView2/Chromium 默认解码白名单内",
    containerHint: null,
    suggestCommand: null,
    note: null,
  };

  it("把大小/容器/编码/不受支持提示摆出来", () => {
    const line = probeSummary(base);
    expect(line).toContain("3147MB");
    expect(line).toContain("mp4 (isom)");
    expect(line).toContain("hevc");
    expect(line).toContain("不在 WebView2/Chromium 默认解码白名单内");
  });

  it("文件不存在 / 探测中 / 编码未识别各有说法", () => {
    expect(
      probeSummary({ ...base, exists: false, note: "文件不存在" }),
    ).toContain("文件不存在");
    expect(probeSummary(null)).toBe("自检中…");
    const unknown = probeSummary({
      ...base,
      videoCodec: null,
      audioCodec: null,
      unsupportedHint: null,
      containerHint: null,
      note: "非 MP4 容器未做内联解析",
    });
    expect(unknown).toContain("编码未识别");
    expect(unknown).toContain("非 MP4 容器未做内联解析");
  });

  it("note 有话要说时照常显示（哪怕编码已识别）", () => {
    // 扩展名骗人（.mp4 实为 avi）这类信息不能因为编码识别成功就被吞掉
    const line = probeSummary({
      ...base,
      note: "扩展名 .mp4 与实际容器 avi 不符",
    });
    expect(line).toContain("不符");
    expect(line).toContain("hevc");
  });

  it("容器放不了时先说容器再说编码怎么救", () => {
    const line = probeSummary({
      ...base,
      container: "avi",
      videoCodec: "mpeg-4 part 2 (xvid)",
      containerHint:
        "avi 不在 Chromium/Edge 的 HTML5 <video> 接受类型内（仅 mp4/m4v、webm、ogg）",
      unsupportedHint:
        "编码 mpeg-4 part 2 (xvid) 不在解码白名单内：需重编码为 H.264/AAC 的 mp4",
    });
    expect(line).toContain("avi");
    expect(line).toContain("需重编码");
    // 因果顺序：容器在前、编码在后
    expect(line.indexOf("不在 Chromium/Edge")).toBeLessThan(
      line.indexOf("重编码"),
    );
  });
});

describe("转封装指引按平台分岔", () => {
  it("Android 不给命令行：手机上没有终端也没有 ffmpeg", () => {
    const line = remuxHelp(true);
    expect(line).not.toContain("ffmpeg -i");
    expect(line).not.toContain("winget");
    expect(line).toContain("MX Player");
  });

  it("桌面给命令 + ffmpeg 缺失时的安装路径", () => {
    const line = remuxHelp(false);
    expect(line).toContain("winget install Gyan.FFmpeg");
    expect(line).toContain("重开终端");
  });
});

describe("移动端 asset 放行不是「未放行」", () => {
  it("skipped_mobile 说清本平台不适用，不把人往授权方向带", () => {
    const text = mediaErrorText(
      4,
      grant({ applied: false, reason: "skipped_mobile" }),
    );
    expect(text).toContain("本平台不适用");
    expect(text).not.toContain("未放行");
  });

  it("桌面行为不变：真的没放行仍标未放行", () => {
    expect(
      mediaErrorText(4, grant({ applied: false, reason: "path_missing" })),
    ).toContain("未放行");
  });
});

describe("转封装失败原因码说人话", () => {
  it("平台不支持与没装 ffmpeg 必须分开", () => {
    expect(remuxReasonText("unsupported_platform")).toContain("当前平台不支持");
    expect(remuxReasonText("ffmpeg_missing")).toContain("没找到 ffmpeg");
  });

  it("io_error 前缀统一说读写缓存失败，未知码原样透出", () => {
    expect(remuxReasonText("io_error:Permission denied")).toBe("读写缓存失败");
    expect(remuxReasonText(null)).toBe("未知原因");
    expect(remuxReasonText("brand_new_code")).toBe("brand_new_code");
  });
});
