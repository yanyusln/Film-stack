//! 播放源自检（只读）——真机「源不可用」的分诊工具。
//!
//! 播放失败只有一句 `MEDIA_ERR_SRC_NOT_SUPPORTED` 时，原因可能是：文件没在、
//! 目录没放行、容器/编码内核放不了。前两者前端已能从 asset 授权结果看出来，
//! 第三者必须知道文件里是什么——本模块**不依赖任何外部二进制**
//! （不像抽帧那样指望 PATH 里的 ffmpeg，用户机器上未必有），只读文件头解析：
//! - MP4/QuickTime：`moov/trak/mdia/minf/stbl/stsd` 里的编码 fourcc；
//! - AVI：`strl/strf` 里的 `biCompression` fourcc 与 `wFormatTag`。
//!
//! 边界：只读，不写不移动（C1）；MKV/ASF 之类不做内联解析（那需要完整的
//! EBML/ASF 解析器），如实回 `note` 说明未识别，不猜。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 头部窗口：找 `moov` / `strl` 用（未 faststart 的 mp4 把它写在末尾，另走尾窗口）。
const HEAD_WINDOW: usize = 2 * 1024 * 1024;
const TAIL_WINDOW: usize = 8 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbe {
    pub path: String,
    pub exists: bool,
    pub size: Option<u64>,
    /// 容器：mp4 (brand) / matroska / webm / avi / flv / asf / mpeg-ts
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    /// 视频编码是否受内置播放器支持（`None` = 没探出来）。
    /// remux 用它决定「无损转封装」还是「必须重编码」。
    pub video_supported: Option<bool>,
    /// 编码层面：不在解码白名单内时给人话提示 + 怎么救（转封装还是重编码）。
    pub unsupported_hint: Option<String>,
    /// 容器层面：不在 HTML5 `<video>` 接受的类型内时提示（mp4/webm 留空）。
    pub container_hint: Option<String>,
    /// 探测受限/失败的原因。
    pub note: Option<String>,
    /// 可复制的转换命令（只生成字符串，本应用不执行、不写盘）。放不了又救得回来时才给。
    pub suggest_command: Option<String>,
}

/// 视频编码 fourcc -> （人话名，是否不在白名单）。
/// 判定基准：Chromium/WebView2 的解码白名单（H.264/VP9/AV1/VP8 放行，
/// HEVC、MPEG-4 Part 2、VC-1/WMV、MJPEG、DV、无损、屏幕录制类默认不放行）。
pub(crate) fn describe(fourcc: &str) -> Option<(&'static str, bool)> {
    let m: &[(&str, &'static str, bool)] = &[
        ("avc1", "h264", false),
        ("avc3", "h264", false),
        ("H264", "h264", false),
        ("X264", "h264", false),
        ("hvc1", "hevc (h.265)", true),
        ("hev1", "hevc (h.265)", true),
        ("av01", "av1", false),
        ("vp09", "vp9", false),
        ("VP90", "vp9", false),
        ("vp08", "vp8", false),
        ("VP80", "vp8", false),
        // AVI 里最常见的几类：老课件/录屏基本都落在这一片，全都不在白名单
        ("mp4v", "mpeg-4 part 2", true),
        ("MP4V", "mpeg-4 part 2", true),
        ("XVID", "mpeg-4 part 2 (xvid)", true),
        ("DIVX", "mpeg-4 part 2 (divx)", true),
        ("DX50", "mpeg-4 part 2 (divx 5)", true),
        ("DIV3", "mpeg-4 part 3 (divx ;-)", true),
        ("MP43", "mpeg-4 part 3 (ms)", true),
        ("3IV2", "mpeg-4 part 2 (3ivx)", true),
        ("MJPG", "mjpeg", true),
        ("MJPA", "mjpeg", true),
        ("dvsd", "dv", true),
        ("dvhd", "dv", true),
        ("dv25", "dv", true),
        ("dvc ", "dv", true),
        ("HFYU", "huffyuv", true),
        ("FFVH", "ffvhuff", true),
        ("tscc", "techsmith screen capture", true),
        ("IV50", "indeo 5", true),
        ("IV41", "indeo 4", true),
        ("cvid", "cinepak", true),
        ("WMV1", "wmv 7", true),
        ("WMV2", "wmv 8", true),
        ("WMV3", "vc-1", true),
        ("mp4a", "aac", false),
        ("ac-3", "ac-3", true),
        ("ec-3", "e-ac-3", true),
        ("Opus", "opus", false),
        (".mp3", "mp3", false),
    ];
    m.iter()
        .find(|(cc, _, _)| *cc == fourcc)
        .map(|(_, name, unsupported)| (*name, *unsupported))
}

/// MP4 侧区分音视频轨：这几个 fourcc 是音频（`stsd` 里音视频条目混在一起）。
fn is_audio_fourcc(fourcc: &str) -> bool {
    matches!(fourcc, "mp4a" | "ac-3" | "ec-3" | "Opus" | ".mp3")
}

/// WAVEFORMATEX.wFormatTag -> （人话名，是否不在白名单）。
fn describe_audio_tag(tag: u16) -> Option<(&'static str, bool)> {
    let m: &[(u16, &'static str, bool)] = &[
        (0x0001, "pcm", false),
        (0x0006, "a-law", false),
        (0x0007, "mu-law", false),
        (0x0055, "mp3", false),
        (0x0002, "ms adpcm", true),
        (0x0011, "ima adpcm", true),
        (0x2000, "ac-3", true),
        (0x0161, "wma", true),
        (0x0162, "wma pro", true),
        (0x0163, "wma lossless", true),
    ];
    m.iter()
        .find(|(t, _, _)| *t == tag)
        .map(|(_, name, unsupported)| (*name, *unsupported))
}

/// 内置播放器（WebView2 / Android WebView 同为 Chromium）真正接受的容器。
/// 注意 **MKV（matroska）不在内**：它与 webm 同源但 Chromium 不认，送进 `<video>`
/// 只会报「源不可用」；以前把它算成可播，是这张表最贵的一个错（MKV 用户点开就是黑屏）。
const PLAYABLE_CONTAINERS: &[&str] = &["mp4", "m4v", "webm", "ogg", "ogv"];

/// 容器层面的结论：不在上表内就点名说清，并给出路（转封装为 MP4）。
fn container_hint(container: &str) -> Option<String> {
    let low = container.to_ascii_lowercase();
    // "mp4 (isom)" -> "mp4"、"asf / wmv" -> "asf"、"matroska / webm" -> "matroska"
    let short = low.split([' ', '(', '/']).next().unwrap_or("");
    if PLAYABLE_CONTAINERS.contains(&short) {
        return None;
    }
    Some(format!(
        "{container} 不在内置播放器接受的容器内（仅 mp4/m4v、webm、ogg）；MKV/AVI/MOV/WMV 需转封装为 MP4"
    ))
}

/// 扩展名与真实容器不符（下载工具改后缀 / 被改名）：这会让「明明是 .mp4 却放不了」变得毫无征兆。
fn extension_mismatch(path: &str, container: &str) -> Option<String> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    let expect = match ext.as_str() {
        "mp4" | "m4v" => "mp4",
        "avi" => "avi",
        "mkv" => "matroska",
        "webm" => "webm",
        _ => return None,
    };
    let actual = container.to_ascii_lowercase();
    let ok = (expect == "mp4" && actual.starts_with("mp4")) || actual.contains(expect);
    if ok {
        return None;
    }
    Some(format!(
        "扩展名 .{ext} 与实际容器 {container} 不符（文件被改名或下载时改了后缀）"
    ))
}

/// 输出文件名：绝不与原文件同名——转封装覆盖源文件是不可接受的。
fn remux_dst(src: &str) -> String {
    let p = Path::new(src);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("out");
    let name = format!("{stem}_remux.mp4");
    match p.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(name).to_string_lossy().to_string(),
        _ => name,
    }
}

/// 只给「救得回来」的命令：编码受支持 → 无损转封装；编码不受支持 → 重编码；编码未知 → 不给。
fn suggest_command(src: &str, video_unsup: Option<bool>) -> Option<String> {
    let dst = remux_dst(src);
    match video_unsup {
        Some(false) => Some(format!("ffmpeg -i \"{src}\" -c copy \"{dst}\"")),
        Some(true) => Some(format!(
            "ffmpeg -i \"{src}\" -c:v libx264 -crf 23 -preset veryfast -c:a aac -b:a 128k \"{dst}\""
        )),
        None => None,
    }
}

/// 收尾：扩展名提示 + 可复制的转换命令（仅在「确实放不了」时给）。
fn finish(out: &mut VideoProbe, video_unsup: Option<bool>) {
    out.video_supported = video_unsup.map(|u| !u);
    let container = out.container.clone().unwrap_or_default();
    if let Some(m) = extension_mismatch(&out.path, &container) {
        out.note = Some(match out.note.take() {
            Some(n) => format!("{n}；{m}"),
            None => m,
        });
    }
    let blocked = out.container_hint.is_some() || video_unsup == Some(true);
    out.suggest_command = if blocked {
        suggest_command(&out.path, video_unsup)
    } else {
        None
    };
}

fn be_u32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

// ---------------------------------------------------------------- MP4 / QuickTime

struct BoxEntry {
    kind: [u8; 4],
    start: usize,
    end: usize,
}

/// 遍历一层 box（`[from, to)` 区间内）。碰到越界/畸形就停在原地，不 panic。
fn iter_boxes(data: &[u8], from: usize, to: usize) -> Vec<BoxEntry> {
    let mut out = Vec::new();
    let mut pos = from;
    while pos + 8 <= to.min(data.len()) {
        let size_field = be_u32(data, pos);
        let (size, head) = match size_field {
            0 => (to - pos, 8usize),
            1 => {
                if pos + 16 > data.len() {
                    break;
                }
                let mut wide = [0u8; 8];
                wide.copy_from_slice(&data[pos + 8..pos + 16]);
                (u64::from_be_bytes(wide) as usize, 16usize)
            }
            s => (s as usize, 8usize),
        };
        if size < head || pos + size > to.min(data.len()) {
            break;
        }
        let mut kind = [0u8; 4];
        kind.copy_from_slice(&data[pos + 4..pos + 8]);
        out.push(BoxEntry {
            kind,
            start: pos + head,
            end: pos + size,
        });
        pos += size;
    }
    out
}

/// 沿 `moov/trak/mdia/minf/stbl/stsd` 逐层下钻，返回 `stsd` 的负载。
fn find_box<'a>(data: &'a [u8], path: &[&str]) -> Option<&'a [u8]> {
    let mut cur = data;
    for want in path {
        let mut next = None;
        for b in iter_boxes(cur, 0, cur.len()) {
            if std::str::from_utf8(&b.kind).ok() == Some(*want) {
                next = Some(&cur[b.start..b.end]);
                break;
            }
        }
        cur = next?;
    }
    Some(cur)
}

/// `stsd` 里每个条目的 fourcc（只看前 8 条，够了）。
fn codecs_of_stsd(stsd: &[u8]) -> Vec<String> {
    if stsd.len() < 8 {
        return Vec::new();
    }
    let count = be_u32(stsd, 4) as usize;
    let mut out = Vec::new();
    let mut pos = 8;
    for _ in 0..count.min(8) {
        if pos + 8 > stsd.len() {
            break;
        }
        let size = be_u32(stsd, pos) as usize;
        out.push(
            std::str::from_utf8(&stsd[pos + 4..pos + 8])
                .unwrap_or("????")
                .to_string(),
        );
        if size < 8 {
            break;
        }
        pos += size;
    }
    out
}

/// 取 `stsd` 的字节：先在头部窗口里按 box 树找，找不到再在尾部窗口里按标记搜。
fn locate_stsd(file: &mut File, size: u64, head: &[u8]) -> Option<Vec<u8>> {
    if let Some(stsd) = find_box(head, &["moov", "trak", "mdia", "minf", "stbl", "stsd"]) {
        return Some(stsd.to_vec());
    }
    let tail_len = TAIL_WINDOW.min(size as usize);
    let start = size.saturating_sub(tail_len as u64);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = vec![0u8; tail_len];
    let read = file.read(&mut tail).unwrap_or(0);
    tail.truncate(read);
    // 尾部窗口不是 box 边界，直接搜 `moov` 标记更稳
    let at = tail.windows(4).position(|w| w == b"moov")?;
    if at < 4 {
        return None;
    }
    let box_start = at - 4;
    // 搜到的是 box 标记本身，往回退 4 字节才是 size 字段；下面要的是 moov 的**负载**
    let wide = be_u32(&tail, box_start) == 1;
    let box_size = if wide {
        let mut b = [0u8; 8];
        b.copy_from_slice(tail.get(box_start + 8..box_start + 16)?);
        u64::from_be_bytes(b) as usize
    } else {
        be_u32(&tail, box_start) as usize
    };
    let payload_start = box_start + if wide { 16 } else { 8 };
    let end = (box_start + box_size).min(tail.len());
    if payload_start >= end {
        return None;
    }
    let moov = &tail[payload_start..end];
    find_box(moov, &["trak", "mdia", "minf", "stbl", "stsd"]).map(|s| s.to_vec())
}

// ---------------------------------------------------------------- AVI (RIFF)

pub(crate) struct RiffEntry {
    pub(crate) kind: [u8; 4],
    pub(crate) list_type: [u8; 4],
    pub(crate) start: usize,
    /// 钳制到缓冲区边界的 end：只可用于**缓冲区内切片**（越界会 panic）。
    pub(crate) end: usize,
    /// 未钳制的 `pos + 8 + size`：chunk 声明的真实终点。**缓冲区只装了文件头部时**
    /// （aviremux 的 1MB HEAD_SCAN），`LIST(movi)` 的 size 是几百 MB，`end` 会被
    /// 钳成缓冲区边界——真机实证：movi_end 变成 1MB，重封装只转出 72 帧却「成功」，
    /// 产物 981KB 无法播放。需要真实边界（如 movi 终点）的调用方必须用这个字段。
    pub(crate) raw_end: usize,
}

/// 遍历一层 RIFF chunk（`LIST`/`RIFF` 记下它的 form type）。AVI 的 chunk 按 2 字节对齐。
pub(crate) fn iter_riff(data: &[u8], from: usize, to: usize) -> Vec<RiffEntry> {
    let mut out = Vec::new();
    let mut pos = from;
    let limit = to.min(data.len());
    while pos + 8 <= limit {
        let mut kind = [0u8; 4];
        kind.copy_from_slice(&data[pos..pos + 4]);
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
            as usize;
        let is_list = &kind == b"RIFF" || &kind == b"LIST";
        let head = if is_list { 12 } else { 8 };
        let start = pos + head;
        let mut list_type = [0u8; 4];
        if is_list && pos + 12 <= limit {
            list_type.copy_from_slice(&data[pos + 8..pos + 12]);
        }
        let end = (pos + 8 + size).min(limit);
        if size == 0 || end < start {
            break;
        }
        out.push(RiffEntry {
            kind,
            list_type,
            start,
            end,
            raw_end: pos + 8 + size,
        });
        pos = pos + 8 + size;
        if pos % 2 == 1 {
            pos += 1; // 奇数长度后有一个 pad 字节
        }
    }
    out
}

pub(crate) fn find_riff(data: &[u8], from: usize, to: usize, want: &[u8]) -> Option<RiffEntry> {
    iter_riff(data, from, to)
        .into_iter()
        .find(|e| e.list_type == want || e.kind == want)
}

/// AVI：`hdrl/strl/strf` 里取视频的 `biCompression` fourcc 与音频的 `wFormatTag`。
fn avi_streams(head: &[u8]) -> (Option<String>, Option<u16>) {
    let mut video = None;
    let mut audio = None;
    let Some(avi) = find_riff(head, 0, head.len(), b"AVI ") else {
        return (None, None);
    };
    let Some(hdrl) = find_riff(head, avi.start, avi.end, b"hdrl") else {
        return (None, None);
    };
    for strl in iter_riff(head, hdrl.start, hdrl.end) {
        if &strl.list_type != b"strl" {
            continue;
        }
        let children = iter_riff(head, strl.start, strl.end);
        let Some(strh) = children.iter().find(|c| &c.kind == b"strh") else {
            continue;
        };
        let Some(strf) = children.iter().find(|c| &c.kind == b"strf") else {
            continue;
        };
        let fcc_type = head.get(strh.start..strh.start + 4);
        let payload = &head[strf.start..strf.end];
        match fcc_type {
            // BITMAPINFOHEADER：biCompression 固定在第 16 字节
            Some(b"vids") if payload.len() >= 20 => {
                if let Ok(cc) = std::str::from_utf8(&payload[16..20]) {
                    video = Some(cc.to_string());
                }
            }
            // WAVEFORMATEX：wFormatTag 是头 2 字节
            Some(b"auds") if payload.len() >= 2 => {
                audio = Some(u16::from_le_bytes([payload[0], payload[1]]));
            }
            _ => {}
        }
    }
    (video, audio)
}

// ---------------------------------------------------------------- 容器识别

/// 只读前 64 字节判容器：扫描时给每行补容器用，比指纹采样（192KB）便宜三个数量级。
/// 读到 64 而不是 12，是为了让 EBML 能定位 DocType（区分 matroska / webm，见下）。
pub fn container_of_path(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let mut head = [0u8; 64];
    let n = f.read(&mut head).unwrap_or(0);
    if n < 12 {
        return None;
    }
    container_of(&head[..n])
}

/// EBML（Matroska 与 WebM 共用同一套容器头）只有 DocType 能区分二者：
/// 两者开头都是 `1A45DFA3`，但可播性相反——Chromium 收 webm、不收 matroska，
/// 混着报会连累本来能播的 WebM（被送去转封装）或放过放不了的 MKV（黑屏）。
fn ebml_doctype(head: &[u8]) -> Option<&'static str> {
    let end = head.len().min(64);
    let mut i = 4; // 跳过 EBML magic
    while i + 3 < end {
        if head[i] == 0x42 && head[i + 1] == 0x82 {
            // 0x42 0x82 = DocType；紧接着是 VINT 长度（0x84→4 字节、0x88→8 字节）
            let size = (head[i + 2] & 0x7f) as usize;
            let s = i + 3;
            let e = (s + size).min(end);
            let name = std::str::from_utf8(&head[s..e])
                .ok()?
                .trim_end_matches('\0');
            return match name {
                "webm" => Some("webm"),
                "matroska" => Some("matroska"),
                _ => None,
            };
        }
        i += 1;
    }
    None
}

pub(crate) fn container_of(head: &[u8]) -> Option<String> {
    if head.len() < 12 {
        return None;
    }
    if &head[4..8] == b"ftyp" {
        let brand = std::str::from_utf8(&head[8..12]).unwrap_or("mp4").trim();
        return Some(format!("mp4 ({brand})"));
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        // 读得到 DocType 就精确区分；只有 12 字节（老数据/短读）时退回模糊结论
        return Some(
            ebml_doctype(head)
                .map(|s| s.to_string())
                .unwrap_or_else(|| "matroska / webm".to_string()),
        );
    }
    if &head[0..4] == b"RIFF" && head.len() > 11 && &head[8..12] == b"AVI " {
        return Some("avi".to_string());
    }
    if &head[0..3] == b"FLV" {
        return Some("flv".to_string());
    }
    if head.starts_with(&[0x30, 0x26, 0xb2, 0x75]) {
        return Some("asf / wmv".to_string());
    }
    if head[0] == 0x47 && head.len() > 188 && head[188] == 0x47 {
        return Some("mpeg-ts".to_string());
    }
    None
}

pub fn probe(raw: &str) -> VideoProbe {
    let p = Path::new(raw);
    let mut out = VideoProbe {
        path: raw.to_string(),
        exists: p.is_file(),
        size: p.metadata().ok().map(|m| m.len()),
        container: None,
        video_codec: None,
        audio_codec: None,
        video_supported: None,
        unsupported_hint: None,
        container_hint: None,
        note: None,
        suggest_command: None,
    };
    // 视频编码是否在解码白名单内（决定转换命令是转封装还是重编码）
    let mut video_unsup: Option<bool> = None;
    if !out.exists {
        out.note = Some("文件不存在（已移动/重命名，或还在下载中）".to_string());
        return out;
    }
    let mut file = match File::open(p) {
        Ok(f) => f,
        Err(e) => {
            out.note = Some(format!("打不开文件：{e}"));
            return out;
        }
    };
    let mut head = vec![0u8; HEAD_WINDOW.min(out.size.unwrap_or(0) as usize)];
    let read = file.read(&mut head).unwrap_or(0);
    head.truncate(read);
    out.container = container_of(&head);
    let container = out.container.clone().unwrap_or_default();
    out.container_hint = container_hint(&container);

    if container.starts_with("mp4") {
        let Some(stsd) = locate_stsd(&mut file, out.size.unwrap_or(0), &head) else {
            out.note = Some("未找到 stsd（文件可能不完整或 moov 在别处）".to_string());
            return out;
        };
        let codecs = codecs_of_stsd(&stsd);
        if codecs.is_empty() {
            out.note = Some("stsd 里没有编码条目".to_string());
            return out;
        }
        for cc in &codecs {
            let Some((name, unsupported)) = describe(cc) else {
                continue;
            };
            if is_audio_fourcc(cc) {
                out.audio_codec = Some(name.to_string());
            } else {
                out.video_codec = Some(name.to_string());
                video_unsup = Some(unsupported);
            }
            if unsupported && out.unsupported_hint.is_none() {
                out.unsupported_hint =
                    Some(format!("{name} 不在 WebView2/Chromium 默认解码白名单内"));
            }
        }
        if out.video_codec.is_none() {
            out.note = Some(format!("未找到视频轨编码：{}", codecs.join(", ")));
        }
        finish(&mut out, video_unsup);
        return out;
    }

    if container == "avi" {
        let (vfourcc, atag) = avi_streams(&head);
        if let Some(tag) = atag {
            if let Some((name, unsupported)) = describe_audio_tag(tag) {
                out.audio_codec = Some(name.to_string());
                if unsupported && out.unsupported_hint.is_none() {
                    out.unsupported_hint = Some(format!(
                        "音轨 {name} 不在 WebView2/Chromium 默认解码白名单内"
                    ));
                }
            } else {
                out.audio_codec = Some(format!("未知音频格式 0x{tag:04x}"));
            }
        }
        match vfourcc.as_deref() {
            None => {
                out.note = Some("未找到 strf（AVI 头不完整）".to_string());
            }
            Some(cc) => match describe(cc) {
                Some((name, unsupported)) => {
                    out.video_codec = Some(name.to_string());
                    video_unsup = Some(unsupported);
                    // 容器已经放不了，这里只回答"还能不能救"：能转封装还是必须重编码
                    out.unsupported_hint = Some(if unsupported {
                        format!("编码 {name} 不在解码白名单内：需重编码为 H.264/AAC 的 mp4")
                    } else {
                        format!("编码 {name} 受支持：可无损转封装为 mp4（不重编码）")
                    });
                }
                None => {
                    out.video_codec = Some(format!("未识别编码 {cc}"));
                    out.note =
                        Some("fourcc 不在映射表内：需先确认编码再决定转封装还是重编码".to_string());
                }
            },
        }
        finish(&mut out, video_unsup);
        return out;
    }

    out.note = Some("非 MP4/AVI 容器未做内联解析（不引入外部解码器依赖）".to_string());
    finish(&mut out, None);
    out
}

#[tauri::command]
pub async fn probe_video(path: String) -> Result<VideoProbe, String> {
    Ok(probe(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 组装一个 box：`size(4) + type(4) + payload`
    fn bx(kind: &str, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
        v.extend_from_slice(kind.as_bytes());
        v.extend_from_slice(payload);
        v
    }

    /// 最小可解析 mp4：`ftyp` + `moov/trak/mdia/minf/stbl/stsd`
    fn sample_mp4(fourcc: &str) -> Vec<u8> {
        let mut stsd = Vec::new();
        stsd.extend_from_slice(&0u32.to_be_bytes()); // version/flags
        stsd.extend_from_slice(&1u32.to_be_bytes()); // entry count
        let mut entry = Vec::new();
        entry.extend_from_slice(fourcc.as_bytes());
        entry.extend_from_slice(&[0u8; 78]); // sample entry 余下字段（我们不解析）
        stsd.extend_from_slice(&bx(fourcc, &entry));
        let stsd_box = bx("stsd", &stsd);
        let stbl = bx("stbl", &stsd_box);
        let minf = bx("minf", &stbl);
        let mdia = bx("mdia", &minf);
        let trak = bx("trak", &mdia);
        let moov = bx("moov", &trak);
        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(b"isom");
        ftyp.extend_from_slice(&0u32.to_be_bytes());
        ftyp.extend_from_slice(b"isommp42");
        let mut v = bx("ftyp", &ftyp);
        v.extend_from_slice(&moov);
        v
    }

    /// 组装 RIFF chunk：`kind + size(含 form type/payload) + [type] + payload`
    fn riff(kind: &str, ty: &str, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(kind.as_bytes());
        let body = if ty.is_empty() { 0 } else { 4 } + payload.len();
        v.extend_from_slice(&(body as u32).to_le_bytes());
        if !ty.is_empty() {
            v.extend_from_slice(ty.as_bytes());
        }
        v.extend_from_slice(payload);
        v
    }

    fn strh(kind: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(kind);
        v.extend_from_slice(b"    "); // fccHandler
        v.resize(56, 0); // strh 定长部分（我们不解析）
        v
    }

    /// 最小可解析 avi：`RIFF AVI / LIST hdrl / LIST strl ×2`
    fn sample_avi(vfourcc: &str, audio_tag: u16) -> Vec<u8> {
        let mut vstrf = vec![0u8; 40]; // BITMAPINFOHEADER
        vstrf[0..4].copy_from_slice(&40u32.to_le_bytes());
        vstrf[16..20].copy_from_slice(vfourcc.as_bytes()); // biCompression
        let vstrl = riff(
            "LIST",
            "strl",
            &[riff("strh", "", &strh(b"vids")), riff("strf", "", &vstrf)].concat(),
        );
        let mut astrf = vec![0u8; 16]; // WAVEFORMATEX
        astrf[0..2].copy_from_slice(&audio_tag.to_le_bytes());
        let astrl = riff(
            "LIST",
            "strl",
            &[riff("strh", "", &strh(b"auds")), riff("strf", "", &astrf)].concat(),
        );
        let hdrl = riff("LIST", "hdrl", &[vstrl, astrl].concat());
        riff("RIFF", "AVI ", &hdrl)
    }

    fn write_tmp(name: &str, ext: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("probe_{name}.{ext}"));
        let mut f = File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    #[test]
    fn recognizes_h264_and_reports_supported() {
        let p = write_tmp("h264", "mp4", &sample_mp4("avc1"));
        let r = probe(&p.to_string_lossy());
        assert!(r.exists);
        assert_eq!(r.video_codec.as_deref(), Some("h264"));
        assert_eq!(r.unsupported_hint, None);
        assert_eq!(r.container_hint, None, "mp4 容器本身受支持，不该提示");
    }

    #[test]
    fn flags_hevc_as_unsupported() {
        let p = write_tmp("hevc", "mp4", &sample_mp4("hvc1"));
        let r = probe(&p.to_string_lossy());
        assert_eq!(r.video_codec.as_deref(), Some("hevc (h.265)"));
        assert!(r.unsupported_hint.is_some(), "HEVC 必须给出不受支持提示");
    }

    #[test]
    fn mp4_audio_only_sample_is_not_misread_as_video() {
        // stsd 里只有音轨时也要如实说未识别视频编码，而不是报成功
        let p = write_tmp("audio", "mp4", &sample_mp4("mp4a"));
        let r = probe(&p.to_string_lossy());
        assert_eq!(r.video_codec, None);
        assert!(r.note.is_some());
    }

    #[test]
    fn avi_container_is_flagged_and_xvid_needs_recode() {
        let p = write_tmp("xvid", "avi", &sample_avi("XVID", 0x0055));
        let r = probe(&p.to_string_lossy());
        assert_eq!(r.container.as_deref(), Some("avi"));
        assert_eq!(r.video_codec.as_deref(), Some("mpeg-4 part 2 (xvid)"));
        assert_eq!(r.audio_codec.as_deref(), Some("mp3"));
        assert!(
            r.container_hint
                .as_deref()
                .unwrap_or("")
                .contains("不在内置播放器接受的容器内"),
            "容器层面必须点名 AVI 放不了"
        );
        assert!(
            r.unsupported_hint
                .as_deref()
                .unwrap_or("")
                .contains("需重编码"),
            "编码不在白名单时要说清得重编码"
        );
    }

    #[test]
    fn avi_h264_only_needs_remux() {
        // 编码受支持时别吓唬人：转封装即可，不用重编码
        let p = write_tmp("avch264", "avi", &sample_avi("H264", 0x0001));
        let r = probe(&p.to_string_lossy());
        assert_eq!(r.video_codec.as_deref(), Some("h264"));
        assert_eq!(r.audio_codec.as_deref(), Some("pcm"));
        assert!(
            r.unsupported_hint
                .as_deref()
                .unwrap_or("")
                .contains("转封装"),
            "h264 应给出转封装而不是重编码"
        );
        assert!(!r
            .unsupported_hint
            .as_deref()
            .unwrap_or("")
            .contains("需重编码"));
    }

    #[test]
    fn blocked_but_savable_suggests_remux_that_never_overwrites() {
        // 真机形态：扩展名 .mp4、实际内容是 AVI，里面却是受支持的 h264
        let p = write_tmp("remux", "mp4", &sample_avi("H264", 0x0055));
        let src = p.to_string_lossy().to_string();
        let r = probe(&src);
        let cmd = r.suggest_command.clone().expect("放不了又救得回就该给命令");
        assert!(cmd.contains("-c copy"), "编码受支持只该转封装：{cmd}");
        assert!(cmd.contains("_remux.mp4"));
        assert_ne!(remux_dst(&src), src, "输出绝不能与源文件同名");
        assert!(
            r.note.as_deref().unwrap_or("").contains("不符"),
            "扩展名骗人必须点名：{:?}",
            r.note
        );
    }

    #[test]
    fn unsupported_codec_suggests_recode() {
        let p = write_tmp("recode", "avi", &sample_avi("XVID", 0x0055));
        let r = probe(&p.to_string_lossy());
        let cmd = r.suggest_command.clone().expect("编码放不了也该给命令");
        assert!(cmd.contains("libx264"));
        assert!(cmd.contains("aac"));
    }

    #[test]
    fn playable_mp4_gets_no_command() {
        let p = write_tmp("ok", "mp4", &sample_mp4("avc1"));
        let r = probe(&p.to_string_lossy());
        assert_eq!(r.suggest_command, None, "本来放得了就别给命令");
        assert_eq!(r.note, None);
    }

    #[test]
    fn unknown_avi_fourcc_is_reported_verbatim() {
        let p = write_tmp("tscc", "avi", &sample_avi("tscc", 0x0001));
        let r = probe(&p.to_string_lossy());
        assert_eq!(r.video_codec.as_deref(), Some("techsmith screen capture"));
        assert!(r.note.is_none());
    }

    #[test]
    fn non_mp4_container_is_reported_without_guessing() {
        let p = write_tmp(
            "mkv",
            "mkv",
            &[0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0],
        );
        let r = probe(&p.to_string_lossy());
        // 只有 12 字节、读不到 DocType 时保留模糊结论，不编造
        assert_eq!(r.container.as_deref(), Some("matroska / webm"));
        assert!(r.video_codec.is_none(), "不猜编码");
        assert!(r.note.is_some());
    }

    #[test]
    fn mkv_and_webm_are_told_apart_by_doctype() {
        // EBML 头两者完全一致，只有 DocType 不同；可播性也相反（Chromium 收 webm、不收 mkv）
        let mkv = write_tmp("m", "mkv", &sample_ebml("matroska"));
        let m = probe(&mkv.to_string_lossy());
        assert_eq!(m.container.as_deref(), Some("matroska"));
        assert!(
            m.container_hint.is_some(),
            "MKV 必须被点名放不了（否则用户点开就是黑屏）"
        );

        let webm = write_tmp("w", "webm", &sample_ebml("webm"));
        let w = probe(&webm.to_string_lossy());
        assert_eq!(w.container.as_deref(), Some("webm"));
        assert_eq!(
            w.container_hint, None,
            "WebM 受支持，不能因为头与 MKV 同形就被送去转封装"
        );
    }

    /// 造一个带 DocType 的最小 EBML 头（Matroska / WebM 共用这一套）
    fn sample_ebml(doctype: &str) -> Vec<u8> {
        let mut v = vec![0x1a, 0x45, 0xdf, 0xa3, 0xa3];
        v.extend_from_slice(&[0x42, 0x86, 0x81, 0x01]); // EBMLVersion
        v.extend_from_slice(&[0x42, 0x82]); // DocType
        v.push(0x80 | doctype.len() as u8); // VINT 长度
        v.extend_from_slice(doctype.as_bytes());
        v.extend_from_slice(&[0x42, 0x87, 0x81, 0x04]); // DocTypeVersion
        v
    }

    #[test]
    fn missing_file_is_reported_not_panicking() {
        let r = probe("D:\\no\\such\\file.mp4");
        assert!(!r.exists);
        assert!(r.note.is_some());
    }

    #[test]
    fn moov_at_tail_is_still_found() {
        // 未 faststart：moov 被挪到尾部，头部只是 ftyp + 一段垃圾占位
        let bytes = sample_mp4("avc1");
        let (head, moov) = bytes.split_at(bx("ftyp", &[0u8; 12]).len());
        let mut v = head.to_vec();
        v.extend_from_slice(&[0u8; 4096]); // 占位（会被当成畸形 box 停下）
        v.extend_from_slice(moov);
        let p = write_tmp("tail", "mp4", &v);
        let r = probe(&p.to_string_lossy());
        assert_eq!(
            r.video_codec.as_deref(),
            Some("h264"),
            "尾部 moov 也要能解析：{:?}",
            r.note
        );
    }
}
