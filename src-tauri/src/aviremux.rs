//! 手机端的轻量重封装：**AVI（H.264 + MP3 / AAC）→ MP4**，纯 Rust，不起外部进程。
//!
//! 为什么手机上不能用 ffmpeg：APK <12MB 的体积基线装不下（每 ABI 15~20MB），用户也
//! 没有自行安装的入口；Android 的 `MediaExtractor` 容器列表里**没有 AVI**，系统解码器
//! 指望不上。而录屏课程这类 AVI 里装的多半是 H.264 + MP3/AAC——**换容器就能播**：
//! 换容器不需要解码器，只要把 NALU 与音频帧重新装箱，这正是本模块做的事
//! （不联网、不起进程、源文件一个字节不动）。
//!
//! 明确不做的：Xvid / MPEG-4 ASP / MJPEG 之类**必须重编码**的源文件（手机上既没有
//! 编码器也不该跑），一律回 `codec_unsupported`，让界面去引导外部播放器。
//!
//! 已知限制（写在这里，免得以后被当成 bug 查）：
//! - 只认 AVI 一种源容器（MKV/MOV 需要完整的 EBML/QT 解析器，不在这条路径上）；
//! - 不写 `ctts`：AVI 没有重排信息，录屏类 H.264 一般无 B 帧，给了也是编的；
//! - 音轨只保留 MP3 / AAC(ADTS)：别的格式宁可不给，也不给一个错时长导致音画漂移。
//!
//! 产物同样走 `remux.rs` 的缓存目录与 LRU（缓存与缩略图缓存同性质，C1 只保护用户文件）。

use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::probe::{find_riff, iter_riff};
use crate::remux::{
    cache_dir, cache_key, cache_tmp_path, done, pct_of, touch, RemuxProgress, RemuxResult,
    CACHE_GRACE_SECS, MAX_CACHE_BYTES,
};
use crate::thumbnail::lru_cleanup;

/// AVI 的 `hdrl` 与 `movi` 都在文件头部（`movi` 紧跟 `hdrl`），1MB 足够覆盖多流的场景。
const HEAD_SCAN: usize = 1024 * 1024;
/// 单个 chunk 的上限：损坏文件可能给出天文数字的 size，不能让它把内存吃掉。
const MAX_CHUNK: usize = 64 * 1024 * 1024;
/// 进度回推间隔（与 ffmpeg 那条路径同一节奏）。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(300);
/// 视频时间刻度：90kHz，容器界的通用刻度。
const VIDEO_TIMESCALE: u32 = 90000;
/// 单位矩阵（`tkhd` / `mvhd` 都要带，缺了画面可能被拉伸）。
const UNITY_MATRIX: [u8; 36] = [
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
];

// ---------------------------------------------------------------- 入口

/// 转封装**全局串行**：tmp 名按 key 固定（`{key}.part.mp4`），上一次还没转完用户又点
/// 一次播放时，两路的 `File::create(tmp)`（截断）与另一路的 `rename(tmp → out)` 会互相
/// 交错——真机实证出现过 0 字节产物被 rename 成正式名且报成功，随后被 `cached` 永久
/// 复用黑屏。转封装本就是重 IO 任务，串行没有吞吐损失。
static REMUX_GUARD: OnceLock<Mutex<()>> = OnceLock::new();

/// 手机端（无 ffmpeg）的转封装入口：只有「AVI + H.264 + MP3/AAC」能走通。
pub fn remux_avi(
    app: &AppHandle,
    raw: &str,
    on_progress: Option<&Channel<RemuxProgress>>,
) -> RemuxResult {
    let _guard = REMUX_GUARD.get_or_init(|| Mutex::new(())).lock();
    let src = Path::new(raw);
    if !src.is_file() {
        return done("error", None, Some("source_missing".to_string()));
    }
    // 判定沿用 `probe`（与桌面端 ffmpeg 的取舍同一套规则，避免两处规则分叉）
    let info = crate::probe::probe(raw);
    if info.container.as_deref() != Some("avi") {
        return done("error", None, Some("container_unsupported".to_string()));
    }
    if info.video_supported != Some(true) {
        // 必须重编码（Xvid / MPEG-4 ASP…）：手机上不做，也不假装能做
        return done("error", None, Some("codec_unsupported".to_string()));
    }
    let size = info.size.unwrap_or(0);
    let dir = match cache_dir(app) {
        Ok(d) => d,
        Err(e) => return done("error", None, Some(format!("io_error:{e}"))),
    };
    let key = cache_key(src, size);
    let out = dir.join(format!("{key}.mp4"));
    if out.exists() {
        // 命中缓存前必须验身，否则坏产物会被当有效缓存无限复用（每次都 `cached`
        // 直接回给播放器黑屏）。转封装不重编码，产物体积必然接近源文件——
        // 真机实证 492MB 只转出 1.6MB 的残缺文件曾一直命中缓存：低于一半即损坏。
        let usable = fs::metadata(&out)
            .map(|m| m.len() > 0 && m.len() * 2 >= size)
            .unwrap_or(false);
        if usable {
            touch(&out);
            return done("cached", Some(out.to_string_lossy().to_string()), None);
        }
        let _ = fs::remove_file(&out);
    }

    let mut file = match File::open(src) {
        Ok(f) => f,
        Err(e) => return done("error", None, Some(format!("io_error:{e}"))),
    };
    let avi = match parse_header(&mut file, size) {
        Ok(a) => a,
        Err(r) => return done("error", None, Some(r)),
    };
    let tmp = cache_tmp_path(&dir, &key);
    let mut tick = Tick::new(on_progress, size.max(1));
    let mut scan = Scan::default();
    // 第一遍：算出每个样本在产物里的大小 / 时长 / 是否关键帧——`moov` 必须先于 `mdat`
    // 落盘，而它的大小取决于样本表，跳过这一遍就无从下手。
    if let Err(r) = scan_samples(&mut file, &avi, &mut scan, &mut tick) {
        let _ = fs::remove_file(&tmp);
        return done("error", None, Some(r));
    }
    if scan.video.samples.is_empty() || scan.avcc.is_none() {
        let _ = fs::remove_file(&tmp);
        return done(
            "error",
            None,
            Some(if scan.avcc.is_none() {
                "no_sps_pps".to_string()
            } else {
                "avi_malformed".to_string()
            }),
        );
    }
    if let Err(r) = write_mp4(&tmp, &avi, &scan, &mut file, &mut tick) {
        let _ = fs::remove_file(&tmp);
        return done("error", None, Some(r));
    }
    // rename 前最后一道闸：空产物绝不能以「成功」身份进入缓存（真机实证会让播放页
    // 静默黑屏且无限复用）。`written != mdat_len` 校验在上游，这里兜住一切旁路。
    if fs::metadata(&tmp).map(|m| m.len() == 0).unwrap_or(true) {
        let _ = fs::remove_file(&tmp);
        return done("error", None, Some("io_error:empty_output".to_string()));
    }
    match fs::rename(&tmp, &out) {
        Ok(()) => {
            let _ = lru_cleanup(&dir, MAX_CACHE_BYTES, CACHE_GRACE_SECS);
            done("remuxed", Some(out.to_string_lossy().to_string()), None)
        }
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            done("error", None, Some("io_error:rename".to_string()))
        }
    }
}

// ---------------------------------------------------------------- AVI 头

struct Stream {
    no: u8,
    is_video: bool,
    /// `strh.dwScale / dwRate`：每帧时长 = scale / rate 秒
    scale: u32,
    rate: u32,
    width: u16,
    height: u16,
    /// `WAVEFORMATEX.wFormatTag`：只作嗅探提示，最终以数据为准
    tag: u16,
    channels: u16,
    sample_rate: u32,
}

struct Avi {
    streams: Vec<Stream>,
    movi_start: u64,
    movi_end: u64,
    /// `avih.dwMicroSecPerFrame`：`strh` 不可用时用它算帧时长
    frame_us: u32,
}

fn parse_header(file: &mut File, size: u64) -> Result<Avi, String> {
    let n = HEAD_SCAN.min(size as usize);
    let mut head = vec![0u8; n];
    let read = file.read(&mut head).map_err(|e| format!("io_error:{e}"))?;
    head.truncate(read);
    // 头部就是从偏移 0 读的，缓冲区下标即文件绝对偏移，无需换算
    let avi = find_riff(&head, 0, head.len(), b"AVI ").ok_or("avi_malformed")?;
    let hdrl = find_riff(&head, avi.start, avi.end, b"hdrl").ok_or("avi_malformed")?;
    let hdrl_kids = iter_riff(&head, hdrl.start, hdrl.end);
    let frame_us = hdrl_kids
        .iter()
        .find(|c| &c.kind == b"avih")
        .map(|c| le_u32(&head, c.start))
        .unwrap_or(0);

    let mut streams = Vec::new();
    for (no, strl) in hdrl_kids
        .iter()
        .filter(|e| &e.list_type == b"strl")
        .enumerate()
    {
        let kids = iter_riff(&head, strl.start, strl.end);
        let (Some(strh), Some(strf)) = (
            kids.iter().find(|c| &c.kind == b"strh"),
            kids.iter().find(|c| &c.kind == b"strf"),
        ) else {
            continue;
        };
        let is_video = head.get(strh.start..strh.start + 4) == Some(b"vids");
        let payload = &head[strf.start..strf.end];
        let mut s = Stream {
            no: no as u8,
            is_video,
            scale: le_u32(&head, strh.start + 20),
            rate: le_u32(&head, strh.start + 24),
            width: 0,
            height: 0,
            tag: 0,
            channels: 2,
            sample_rate: 44100,
        };
        if is_video {
            // BITMAPINFOHEADER：biWidth(4)、biHeight(8)
            if payload.len() >= 12 {
                s.width = le_u32(payload, 4).clamp(1, u16::MAX as u32) as u16;
                s.height = le_u32(payload, 8).clamp(1, u16::MAX as u32) as u16;
            }
        } else if payload.len() >= 16 {
            // WAVEFORMATEX：wFormatTag(0)、nChannels(2)、nSamplesPerSec(4)
            s.tag = le_u16(payload, 0);
            s.channels = le_u16(payload, 2).max(1);
            s.sample_rate = le_u32(payload, 4);
        }
        streams.push(s);
    }
    let movi = find_riff(&head, avi.start, avi.end, b"movi").ok_or("avi_malformed")?;
    // movi 的终点必须用 `raw_end`（chunk 声明的真实边界）：`end` 被 1MB 头部缓冲钳制，
    // 真机实证 492MB 的文件只转出 981KB（72 帧）却返回成功。`.min(size)` 兜住损坏的 size。
    Ok(Avi {
        streams,
        movi_start: movi.start as u64,
        movi_end: (movi.raw_end as u64).min(size),
        frame_us,
    })
}

/// chunk id 的前两位是流号（`00dc`、`01wb`）；`ix##` / `LIST` 之类返回 `None` 跳过。
fn stream_no(id: &[u8; 4]) -> Option<u8> {
    if id[0].is_ascii_digit() && id[1].is_ascii_digit() {
        Some((id[0] - b'0') * 10 + (id[1] - b'0'))
    } else {
        None
    }
}

struct ChunkIter<'a> {
    file: &'a mut File,
    start: u64,
    pos: u64,
    end: u64,
}

struct Chunk {
    stream: u8,
    size: usize,
    off: u64,
}

impl<'a> ChunkIter<'a> {
    fn new(file: &'a mut File, avi: &Avi) -> Self {
        Self {
            file,
            start: avi.movi_start,
            pos: avi.movi_start,
            end: avi.movi_end,
        }
    }
    /// 下一个数据 chunk（`LIST` / `idx1` / `ix##` 之类不是数据，内部跳过）。
    fn next_chunk(&mut self) -> Result<Option<Chunk>, String> {
        let mut bad_streak = 0u32;
        while self.pos + 8 <= self.end {
            self.file
                .seek(SeekFrom::Start(self.pos))
                .map_err(|e| format!("io_error:{e}"))?;
            let mut h = [0u8; 8];
            if self.file.read_exact(&mut h).is_err() {
                break;
            }
            let size = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
            // 尺寸异常的块（录制器常塞 `size=0` 的占位头 / 超大索引块）：这不是数据边界。
            // 直接 `break` 会丢掉文件后半部分（真机实证：492MB 只转出 72 帧却「成功」）。
            // 改为越过它重新对齐继续扫——连续 ~16MB 全是坏头才是真 EOF。
            if size == 0 {
                self.pos += 8; // 占位坏头：短跳过，下一轮从其后 8 字节重新找合法块
            } else if size > MAX_CHUNK {
                self.pos += 8 + size as u64 + (size % 2) as u64; // 超大块整体跳过（真帧不会 >64MB）
            } else {
                let off = self.pos + 8;
                self.pos = off + size as u64 + (size % 2) as u64; // chunk 按 2 字节对齐
                if let Some(stream) = stream_no(&[h[0], h[1], h[2], h[3]]) {
                    return Ok(Some(Chunk { stream, size, off }));
                }
                bad_streak = 0;
                continue;
            }
            bad_streak += 1;
            if bad_streak > 2_000_000 {
                break;
            }
        }
        Ok(None)
    }
    fn read(&mut self, c: &Chunk) -> Result<Vec<u8>, String> {
        self.file
            .seek(SeekFrom::Start(c.off))
            .map_err(|e| format!("io_error:{e}"))?;
        let mut b = vec![0u8; c.size];
        self.file
            .read_exact(&mut b)
            .map_err(|e| format!("io_error:{e}"))?;
        Ok(b)
    }
    fn scanned(&self) -> u64 {
        self.pos.saturating_sub(self.start)
    }
}

// ---------------------------------------------------------------- 第一遍：扫描

#[derive(Clone, Copy)]
struct Sample {
    /// 在 `mdat` **数据区**内的相对偏移（加 `base` 才是文件绝对偏移）
    offset: u64,
    size: u32,
    dur: u32,
    sync: bool,
}

#[derive(Default)]
struct Track {
    timescale: u32,
    samples: Vec<Sample>,
}

#[derive(Default)]
struct Scan {
    video: Track,
    audio: Track,
    /// `avcC` 负载：没有 SPS/PPS 就写不出可解码的 `avc1`
    avcc: Option<Vec<u8>>,
    audio_kind: Option<AudioKind>,
    audio_timescale: u32,
    audio_channels: u16,
    /// AAC 的 AudioSpecificConfig（MP3 不需要，留空）
    audio_asc: Option<Vec<u8>>,
    /// 连续流解析从哪个文件偏移开始（嗅探成功的那个音频块）。
    /// 第二遍重放必须跳过它之前的音频块，两遍解析才逐字节一致。
    audio_start_off: u64,
    /// `mdat` 数据区总长：样本表与落盘必须一致，否则产物必然花屏
    mdat_len: u64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum AudioKind {
    Mp3,
    Aac,
}

fn scan_samples(
    file: &mut File,
    avi: &Avi,
    scan: &mut Scan,
    tick: &mut Tick,
) -> Result<(), String> {
    let vs = avi.streams.iter().find(|s| s.is_video);
    let as_ = avi.streams.iter().find(|s| !s.is_video);
    let (v_ts, v_dur) = video_timing(vs, avi.frame_us);
    scan.video.timescale = v_ts;
    scan.audio_timescale = as_.map(|s| s.sample_rate.max(8000)).unwrap_or(44100);
    scan.audio_channels = as_.map(|s| s.channels).unwrap_or(2);

    let mut it = ChunkIter::new(file, avi);
    let total = it.end.saturating_sub(it.start).max(1);
    // mdat 布局：**视频区在前、音频区在后**（MP4 不要求交错，本地按 Range 取即可）。
    // 音频帧跨块存放，只有把音频整体连续放置，每帧才是 mdat 里连续的字节。
    let mut v_pos: u64 = 0;
    let mut sniff_left = 3u8;
    let mut parser: Option<AudioStreamParser> = None;
    let mut audio_pending: Vec<Sample> = Vec::new();
    while let Some(c) = it.next_chunk()? {
        if vs.is_some_and(|s| s.no == c.stream) {
            let data = it.read(&c)?;
            // 单帧解不动就跳过这一块：视频才是主轨，后面的帧照样救
            if let Ok(plan) = plan_frame(&data) {
                if scan.avcc.is_none() {
                    if let (Some(sps), Some(pps)) = (&plan.sps, &plan.pps) {
                        scan.avcc = Some(build_avcc(sps, pps));
                    }
                }
                scan.video.samples.push(Sample {
                    offset: v_pos,
                    size: plan.size as u32,
                    dur: v_dur,
                    sync: plan.sync,
                });
                v_pos += plan.size as u64;
            }
        } else if as_.is_some_and(|s| s.no == c.stream) {
            // 音轨「尽力而为」：救不了就纯视频转封装（有画面没声音远好过打不开）
            if let Some(p) = parser.as_mut() {
                let data = it.read(&c)?;
                p.feed(&data, &mut audio_pending, &mut std::io::sink())?;
            } else if sniff_left > 0 {
                sniff_left -= 1;
                let data = it.read(&c)?;
                let tag = as_.map(|s| s.tag).unwrap_or(0);
                if let Some(kind) = sniff_audio(tag, &data) {
                    // 码流自己带的采样率 / 声道比 `strf` 里的更可信
                    let (sr, ch, asc) = audio_config(kind, &data);
                    scan.audio_timescale = sr;
                    scan.audio_channels = ch;
                    scan.audio_asc = Some(asc);
                    scan.audio_kind = Some(kind);
                    scan.audio_start_off = c.off;
                    let mut p = AudioStreamParser::new(kind);
                    p.feed(&data, &mut audio_pending, &mut std::io::sink())?;
                    parser = Some(p);
                }
            } // 嗅了几块都不认：放弃音轨，只保留视频
        }
        // 第一遍约占一半工作量（第二遍是转换 + 落盘），进度才不会先冲到 100 再卡住
        tick.tick(it.scanned() / 2);
    }
    // 音频区排在视频区之后：区内偏移统一平移到 mdat 里的真实位置
    let a_payload = parser.as_ref().map(|p| p.payload_pos).unwrap_or(0);
    for s in &mut audio_pending {
        s.offset += v_pos;
    }
    scan.audio.samples = audio_pending;
    scan.mdat_len = v_pos + a_payload;
    let _ = total;
    Ok(())
}

/// 每帧时长：优先 `strh.dwScale / dwRate`，拿不到才退回 `avih.dwMicroSecPerFrame`。
fn video_timing(s: Option<&Stream>, frame_us: u32) -> (u32, u32) {
    if let Some(s) = s {
        if s.rate > 0 && s.scale > 0 {
            let d = (VIDEO_TIMESCALE as u64 * s.scale as u64 / s.rate as u64) as u32;
            if d > 0 {
                return (VIDEO_TIMESCALE, d);
            }
        }
    }
    let us = if frame_us > 0 { frame_us } else { 40000 }; // 兜底 25fps
    (
        VIDEO_TIMESCALE,
        ((VIDEO_TIMESCALE as u64 * us as u64) / 1_000_000).max(1) as u32,
    )
}

struct FramePlan {
    /// 转成 AVCC（4 字节长度前缀）后的字节数
    size: usize,
    sync: bool,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

fn plan_frame(frame: &[u8]) -> Result<FramePlan, String> {
    let nalus = split_nalus(frame).ok_or("avi_malformed")?;
    let mut size = 0usize;
    let mut sync = false;
    let mut sps = None;
    let mut pps = None;
    for n in nalus {
        size += 4 + n.len();
        match n.first().map(|b| b & 0x1f) {
            Some(5) => sync = true, // IDR
            Some(7) if sps.is_none() => sps = Some(n.to_vec()),
            Some(8) if pps.is_none() => pps = Some(n.to_vec()),
            _ => {}
        }
    }
    Ok(FramePlan {
        size,
        sync,
        sps,
        pps,
    })
}

/// AVI 里的 H.264 两种存法都要认：Annex-B（`00 00 01` 起始码）与 AVCC（长度前缀）。
/// 统一切成「不带任何前缀的 NALU 切片」，后面装箱只需要一种写法。
fn split_nalus(frame: &[u8]) -> Option<Vec<&[u8]>> {
    if frame.starts_with(&[0, 0, 0, 1]) || frame.starts_with(&[0, 0, 1]) {
        return Some(split_annexb(frame));
    }
    split_avcc(frame)
}

/// 起始码：`00 00 01` 或 `00 00 00 01`（**不能**把 `00 00 00` 也算进去，
/// 那会把码流里的连续零误当成分隔，切出半个 NALU）。
fn is_start_code(d: &[u8], j: usize) -> bool {
    if j + 2 >= d.len() {
        return false;
    }
    if d[j] == 0 && d[j + 1] == 0 && d[j + 2] == 1 {
        return true;
    }
    j + 3 < d.len() && d[j] == 0 && d[j + 1] == 0 && d[j + 2] == 0 && d[j + 3] == 1
}

fn split_annexb(frame: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < frame.len() {
        while i < frame.len() && frame[i] == 0 {
            i += 1;
        }
        if i >= frame.len() {
            break;
        }
        if frame[i] == 1 {
            i += 1; // 起始码末位的 0x01
        }
        let start = i;
        // 找不到下一个起始码，剩下的就都属于这一个 NALU（末尾多带几个 0 无害）
        let mut end = frame.len();
        let mut j = i + 1;
        while j < frame.len() {
            if is_start_code(frame, j) {
                end = j;
                break;
            }
            j += 1;
        }
        out.push(&frame[start..end]);
        i = end;
    }
    out
}

fn split_avcc(frame: &[u8]) -> Option<Vec<&[u8]>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= frame.len() {
        let len = u32::from_be_bytes([frame[i], frame[i + 1], frame[i + 2], frame[i + 3]]) as usize;
        if len == 0 {
            return None;
        }
        let (s, e) = (i + 4, i + 4 + len);
        if e > frame.len() {
            return None; // 长度前缀对不上：不是 AVCC，别硬猜
        }
        out.push(&frame[s..e]);
        i = e;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// `avcC`：Chromium 靠它拿到 SPS/PPS 才肯解码（只放在码流里不够）。
fn build_avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut v = vec![
        1,                                   // configurationVersion
        sps.get(1).copied().unwrap_or(0x42), // AVCProfileIndication
        sps.get(2).copied().unwrap_or(0),    // profile_compatibility
        sps.get(3).copied().unwrap_or(0x1e), // AVCLevelIndication
        0xff,                                // lengthSizeMinusOne = 3 + 保留位
        0xe1,                                // numOfSequenceParameterSets = 1
    ];
    v.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    v.extend_from_slice(sps);
    v.push(1); // numOfPictureParameterSets
    v.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    v.extend_from_slice(pps);
    v
}

// ---------------------------------------------------------------- 音频切帧

/// 音频**连续字节流**解析器。
/// 真机实证（492MB 网课 AVI）：源文件的 `01wb` 块是把连续 MP3 流按任意边界切块——
/// 帧头声明 522B 的帧，块只有 387B，帧**跨块**存放。按「块内独立切帧 + 重同步」
/// 只能撞出 4% 的假帧（12.4 万个音频块只出 5157 个垃圾样本）。
/// 因此必须带 carry 跨块拼接解析：帧尾不完整就留在 carry，与下一块拼上再切。
struct AudioStreamParser {
    kind: AudioKind,
    carry: Vec<u8>,
    /// 已写出的负载字节数 = 下一个样本在音频区内的偏移
    payload_pos: u64,
}

impl AudioStreamParser {
    fn new(kind: AudioKind) -> Self {
        Self { kind, carry: Vec::new(), payload_pos: 0 }
    }

    /// 喂入一块数据；完整帧写成 Sample（`offset` 为音频区内偏移）并把负载写入 `w`。
    /// `scan` 阶段传 `io::sink()` 只记账；`write` 阶段用同一输入重放同一解析，逐字节落盘。
    fn feed<W: std::io::Write>(
        &mut self,
        data: &[u8],
        out: &mut Vec<Sample>,
        w: &mut W,
    ) -> Result<(), String> {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(data);
        let mut i = 0usize;
        while i + 4 <= buf.len() {
            let (total, payload, dur) = match self.kind {
                AudioKind::Mp3 => match mp3_frame(&buf[i..]) {
                    Ok((len, dur)) => (len, len, dur),
                    Err(_) => {
                        i += 1; // 不是合法帧头：挪一字节再找同步字
                        continue;
                    }
                },
                AudioKind::Aac => match adts_frame(&buf[i..]) {
                    Ok(r) => r,
                    Err(_) => {
                        i += 1;
                        continue;
                    }
                },
            };
            if i + total > buf.len() {
                break; // 帧跨块：尾部留到 carry，下一块拼上
            }
            w.write_all(&buf[i + (total - payload)..i + total])
                .map_err(|e| format!("io_error:{e}"))?;
            out.push(Sample {
                offset: self.payload_pos,
                size: payload as u32,
                dur,
                sync: true,
            });
            self.payload_pos += payload as u64;
            i += total;
        }
        self.carry = buf.split_off(i.min(buf.len()));
        Ok(())
    }
}

/// MP3 与 ADTS 的同步字前 11 位相同，靠 layer 位区分（ADTS 的 layer 恒为 0）。
fn sniff_audio(tag: u16, data: &[u8]) -> Option<AudioKind> {
    let head = data.first().copied().unwrap_or(0);
    let b1 = data.get(1).copied().unwrap_or(0);
    if head == 0xff && (b1 & 0xf0) == 0xf0 && (b1 & 0x06) == 0x00 {
        return Some(AudioKind::Aac);
    }
    if tag == 0x0055 || (head == 0xff && (b1 & 0xe0) == 0xe0 && (b1 & 0x06) == 0x02) {
        return Some(AudioKind::Mp3);
    }
    None
}

const MP3_SR: [[u32; 4]; 4] = [
    [11025, 12000, 8000, 0],  // MPEG 2.5
    [0, 0, 0, 0],             // reserved
    [22050, 24000, 16000, 0], // MPEG 2
    [44100, 48000, 32000, 0], // MPEG 1
];
const MP3_BR_MPEG1: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MP3_BR_MPEG2: [u32; 16] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

/// 返回（帧长字节数，每帧采样数）。采样数决定时长，错了就会音画不同步。
fn mp3_frame(d: &[u8]) -> Result<(usize, u32), String> {
    if d.len() < 4 || d[0] != 0xff || (d[1] & 0xe0) != 0xe0 {
        return Err("audio_malformed".to_string());
    }
    let ver = ((d[1] >> 3) & 3) as usize;
    let layer = (d[1] >> 1) & 3;
    if layer != 1 {
        return Err("audio_malformed".to_string()); // 只认 Layer III
    }
    let br_idx = ((d[2] >> 4) & 0xf) as usize;
    let sr_idx = ((d[2] >> 2) & 3) as usize;
    let padding = ((d[2] >> 1) & 1) as usize;
    let sr = MP3_SR[ver][sr_idx];
    let br = if ver == 3 {
        MP3_BR_MPEG1[br_idx]
    } else {
        MP3_BR_MPEG2[br_idx]
    };
    if sr == 0 || br == 0 {
        return Err("audio_malformed".to_string());
    }
    let samples = if ver == 3 { 1152 } else { 576 }; // Layer III
    let len = if ver == 3 {
        144 * br as usize * 1000 / sr as usize + padding
    } else {
        72 * br as usize * 1000 / sr as usize + padding
    };
    Ok((len, samples))
}

const AAC_SR: [u32; 16] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0,
    0,
];

/// ADTS 帧：返回（**含头**的整帧长度、去掉头之后装入 MP4 的负载长度，每帧采样数 1024）。
/// `frame_len > d.len()` 不报错而由调用方判断——跨块解析要把不完整帧留到 carry。
fn adts_frame(d: &[u8]) -> Result<(usize, usize, u32), String> {
    if d.len() < 7 || d[0] != 0xff || (d[1] & 0xf0) != 0xf0 {
        return Err("audio_malformed".to_string());
    }
    let header = if d[1] & 1 == 1 { 7 } else { 9 }; // protection_absent
    let frame_len =
        (((d[3] & 0x03) as usize) << 11) | ((d[4] as usize) << 3) | ((d[5] as usize) >> 5);
    if frame_len <= header {
        return Err("audio_malformed".to_string());
    }
    Ok((frame_len, frame_len - header, 1024))
}

/// 音频时间刻度与 `AudioSpecificConfig`：ADTS 里带的采样率比 `strf` 里的更可信。
fn audio_config(kind: AudioKind, first: &[u8]) -> (u32, u16, Vec<u8>) {
    if kind == AudioKind::Aac {
        let sr_idx = ((first.get(2).copied().unwrap_or(0) >> 2) & 0xf) as usize;
        let sr = AAC_SR.get(sr_idx).copied().unwrap_or(44100).max(8000);
        let channels = (((first.get(2).copied().unwrap_or(0) & 1) as u16) << 2)
            | ((first.get(3).copied().unwrap_or(0) as u16) >> 6);
        // AudioSpecificConfig：5 位 AOT（AAC LC = 2）+ 4 位采样率索引 + 4 位声道
        let asc = vec![
            (2u8 << 3) | ((sr_idx as u8) >> 1),
            (((sr_idx as u8) & 1) << 7) | ((channels.max(1) as u8) << 3),
        ];
        return (sr, channels.max(1), asc);
    }
    let ver = ((first.get(1).copied().unwrap_or(0) >> 3) & 3) as usize;
    let sr_idx = ((first.get(2).copied().unwrap_or(0) >> 2) & 3) as usize;
    (MP3_SR[ver][sr_idx].max(8000), 2, Vec::new()) // MP3 不需要 DecoderSpecificInfo
}

// ---------------------------------------------------------------- moov 自检

/// 写完 moov 后校验盒子链：size 层层自洽、type 合法、总长吻合。
/// 真机真实录制文件出现过「moov 内部错位 12 字节、Chromium 读不出头」的坏文件，
/// 这里在 rename 前拦下，避免把毒文件当缓存复用导致永久黑屏。
fn verify_moov(m: &[u8]) -> Result<(), String> {
    const KNOWN: &[&[u8; 4]] = &[
        b"moov", b"trak", b"mdia", b"minf", b"stbl", b"mvhd", b"tkhd", b"mdhd",
        b"hdlr", b"vmhd", b"smhd", b"dinf", b"stsd", b"stts", b"stss", b"stsc", b"stsz",
        b"stco", b"co64", b"avc1", b"avcC", b"mp4a", b"esds", b"ftyp", b"mdat",
    ];
    const CONTAINERS: &[&[u8; 4]] = &[b"moov", b"trak", b"mdia", b"minf", b"stbl"];
    fn walk(b: &[u8], off: usize, end: usize) -> Result<(), String> {
        let mut o = off;
        while o + 8 <= end {
            let sz = u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
            let ty = <&[u8; 4]>::try_from(&b[o + 4..o + 8])
                .map_err(|_| format!("box 类型越界 at {o:#x}"))?;
            if sz < 8 {
                return Err(format!("box {:?} sz={sz} < 8 at {o:#x}", String::from_utf8_lossy(ty)));
            }
            if o + sz > end {
                return Err(format!("box {:?} sz={sz} 越界 end={end} at {o:#x}", String::from_utf8_lossy(ty)));
            }
            if !KNOWN.contains(&ty) {
                return Err(format!("unknown box {:?} at {o:#x} sz={sz}", String::from_utf8_lossy(ty)));
            }
            check_semantics(ty, &b[o + 8..o + sz])?;
            if CONTAINERS.contains(&ty) {
                walk(b, o + 8, o + sz)?;
            }
            o += sz;
        }
        if o != end {
            return Err(format!("box 累加 {o} != 总长 {end}"));
        }
        Ok(())
    }
    // 语义抽查：结构自洽 ≠ 语义正确。曾因 dref 漏写 version/flags+entry_count
    // （8 字节），所有产物 "error reading header"（黑屏）而结构校验照样通过——
    // 对这类「缺头部字段」的写错，只有按盒子的定义核对必填字段才拦得住。
    fn check_semantics(ty: &[u8; 4], p: &[u8]) -> Result<(), String> {
        // full box：version(1)+flags(3) 之后才轮到有效载荷，下标一律 +4 起
        let u32_at = |i: usize| {
            u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]])
        };
        match ty {
            b"dref" => {
                if p.len() < 8 {
                    return Err("dref 缺 version/flags+entry_count".to_string());
                }
                if u32_at(4) == 0 {
                    return Err("dref entry_count=0".to_string());
                }
                // 子条目盒必须从 offset 8 起（version/flags+entry_count 各占 4）。
                // 旧坏形态漏写这 8 字节，url 盒顶到 offset 4，此处读到的"子盒 size"=1 即露馅。
                if p.len() < 16 {
                    return Err("dref 缺子条目盒子".to_string());
                }
                let child = u32_at(8) as usize;
                if child < 8 || 8 + child > p.len() {
                    return Err("dref 条目不是合法子盒（漏写 version/flags+entry_count?）".to_string());
                }
            }
            b"stco" => {
                if p.len() < 8 {
                    return Err("stco 缺 version/flags+entry_count".to_string());
                }
                if u32_at(4) == 0 {
                    return Err("stco entry_count=0".to_string());
                }
            }
            b"stsz" => {
                if p.len() < 12 {
                    return Err("stsz 缺 version/flags+字段头".to_string());
                }
                let (fixed, n) = (u32_at(4), u32_at(8));
                if fixed == 0 && n == 0 {
                    return Err("stsz 无样本".to_string());
                }
            }
            b"stsd" | b"stts" | b"stss" | b"stsc" => {
                if p.len() < 8 {
                    return Err(format!("{:?} 缺 version/flags+字段头", String::from_utf8_lossy(ty)));
                }
            }
            // ver/flags(4)+creation(4)+mod(4) 后是 track_id / timescale，必须非 0
            b"tkhd" | b"mvhd" | b"mdhd" if p.len() >= 16 && u32_at(12) == 0 => {
                return Err(format!("{:?} track_id/timescale=0", String::from_utf8_lossy(ty)));
            }
            _ => {}
        }
        Ok(())
    }
    walk(m, 0, m.len())
}

fn eprintln_moov(m: &[u8]) {
    const CONTAINERS: &[&[u8; 4]] = &[b"moov", b"trak", b"mdia", b"minf", b"stbl"];
    fn walk(b: &[u8], off: usize, end: usize, d: usize) {
        let mut o = off;
        while o + 8 <= end {
            let sz = u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
            let ty = String::from_utf8_lossy(&b[o + 4..o + 8]);
            let ty4 = <&[u8; 4]>::try_from(&b[o + 4..o + 8]).ok();
            eprintln!("[moov] {} {o:#x} {ty} sz={sz}", "  ".repeat(d));
            if sz >= 8 && o + sz <= end && ty4.is_some_and(|t| CONTAINERS.contains(&t)) {
                walk(b, o + 8, o + sz, d + 1);
            }
            if sz < 8 {
                break;
            }
            o += sz;
        }
    }
    walk(m, 0, m.len(), 0);
}

// ---------------------------------------------------------------- 第二遍：落盘

fn write_mp4(
    tmp: &Path,
    avi: &Avi,
    scan: &Scan,
    file: &mut File,
    tick: &mut Tick,
) -> Result<(), String> {
    let audio = (!scan.audio.samples.is_empty()).then_some(&scan.audio);
    let ftyp = build_ftyp();
    // `stco` 里的偏移是定长的，与偏移**值**无关——所以先用占位算长度，
    // 得到 `mdat` 起点后再按真实偏移算一遍，两次长度必然相同
    // （不同就说明算错了，宁可不写也不能出一个花屏文件）
    let placeholder = build_moov(avi, scan, audio, 0);
    let mdat_head = mdat_header_len(scan.mdat_len);
    let base = ftyp.len() as u64 + placeholder.len() as u64 + mdat_head;
    let moov = build_moov(avi, scan, audio, base);
    if moov.len() != placeholder.len() {
        return Err("moov 长度与占位不一致（偏移会全错）".to_string());
    }
    if let Err(e) = verify_moov(&moov) {
        eprintln!("[aviremux] moov 自检失败: {e}");
        eprintln_moov(&moov);
        return Err(format!("moov_corrupt:{e}"));
    }

    let f = File::create(tmp).map_err(|e| format!("io_error:{e}"))?;
    let mut out = BufWriter::with_capacity(1024 * 1024, f);
    out.write_all(&ftyp).map_err(|e| format!("io_error:{e}"))?;
    out.write_all(&moov).map_err(|e| format!("io_error:{e}"))?;
    if scan.mdat_len + mdat_head > u32::MAX as u64 {
        // >4GB 的 mdat 必须用 64 位长度（1 + 'mdat' + 8 字节）
        out.write_all(&1u32.to_be_bytes())
            .and_then(|_| out.write_all(b"mdat"))
            .and_then(|_| out.write_all(&(scan.mdat_len + 16).to_be_bytes()))
            .map_err(|e| format!("io_error:{e}"))?;
    } else {
        out.write_all(&((scan.mdat_len + 8) as u32).to_be_bytes())
            .and_then(|_| out.write_all(b"mdat"))
            .map_err(|e| format!("io_error:{e}"))?;
    }

    let vs = avi.streams.iter().find(|s| s.is_video);
    let as_ = avi.streams.iter().find(|s| !s.is_video);
    // 音轨被放弃时（嗅探不出 / 整条切不出帧），第二遍也要跳过音频块，
    // 否则写进 mdat 的字节就会比样本表多——`written != mdat_len` 直接判死
    let keep_audio = !scan.audio.samples.is_empty();
    let mut it = ChunkIter::new(file, avi);
    let half = it.end.saturating_sub(it.start).max(1) / 2;
    let mut written: u64 = 0;
    // 第一遍：只写视频区（音频块不读数据，位置推进靠块头）
    while let Some(c) = it.next_chunk()? {
        if vs.is_some_and(|s| s.no == c.stream) {
            let data = it.read(&c)?;
            // 与第一遍同一个判定：解不动的块两边都跳过，`written` 才能对上 `mdat_len`
            if let Some(nalus) = split_nalus(&data) {
                for n in nalus {
                    out.write_all(&(n.len() as u32).to_be_bytes())
                        .and_then(|_| out.write_all(n))
                        .map_err(|e| format!("io_error:{e}"))?;
                    written += 4 + n.len() as u64;
                }
            }
        }
        tick.tick(it.scanned() / 2);
    }
    // 第二遍：音频区。用**同一份输入重放同一解析**（AudioStreamParser 是确定性的），
    // 帧跨块也天然正确——连续流在 mdat 里就是连续字节。
    if keep_audio {
        let kind = scan.audio_kind.expect("有音频样本必有 audio_kind");
        let mut it2 = ChunkIter::new(file, avi);
        let mut parser = AudioStreamParser::new(kind);
        let mut replay: Vec<Sample> = Vec::new();
        while let Some(c) = it2.next_chunk()? {
            if as_.is_some_and(|s| s.no == c.stream) && c.off >= scan.audio_start_off {
                let data = it2.read(&c)?;
                parser.feed(&data, &mut replay, &mut out)?;
            }
            tick.tick(half + it2.scanned() / 2);
        }
        // 两遍解析必须逐帧一致：条数/偏移/大小任一对不上就是坏文件，宁死不出
        if replay.len() != scan.audio.samples.len() {
            return Err(format!(
                "audio_replay_mismatch:count {}!={}",
                replay.len(),
                scan.audio.samples.len()
            ));
        }
        // 重放得到的是「音频区内偏移」，加视频区长度才是 mdat 内的真实偏移
        let v_total: u64 = scan.video.samples.iter().map(|s| s.size as u64).sum();
        for (w, r) in replay.iter().zip(scan.audio.samples.iter()) {
            if w.offset + v_total != r.offset || w.size != r.size {
                return Err(format!(
                    "audio_replay_mismatch:frame {}!={}",
                    w.offset + v_total,
                    r.offset
                ));
            }
        }
        written += parser.payload_pos;
    }
    out.flush().map_err(|e| format!("io_error:{e}"))?;
    // 第一遍算出的大小就是样本表的依据：对不上说明两遍解析不一致，产物必然花屏
    if written != scan.mdat_len {
        return Err(format!("size_mismatch:{written}!={}", scan.mdat_len));
    }
    Ok(())
}

fn mdat_header_len(data_len: u64) -> u64 {
    if data_len + 8 > u32::MAX as u64 {
        16
    } else {
        8
    }
}

// ---------------------------------------------------------------- MP4 盒子

fn atom(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(payload.len() + 8);
    v.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
    v.extend_from_slice(kind);
    v.extend_from_slice(payload);
    v
}

fn full(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(payload.len() + 4);
    p.push(version);
    p.extend_from_slice(&[(flags >> 16) as u8, (flags >> 8) as u8, flags as u8]);
    p.extend_from_slice(payload);
    atom(kind, &p)
}

fn build_ftyp() -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(b"isom");
    p.extend_from_slice(&0x200u32.to_be_bytes());
    p.extend_from_slice(b"isomiso2avc1mp41");
    atom(b"ftyp", &p)
}

fn build_moov(avi: &Avi, scan: &Scan, audio: Option<&Track>, base: u64) -> Vec<u8> {
    let v = &scan.video;
    let v_dur: u64 = v.samples.iter().map(|s| s.dur as u64).sum();
    let a_dur: u64 = audio
        .map(|t| t.samples.iter().map(|s| s.dur as u64).sum())
        .unwrap_or(0);
    let v_ms = v_dur * 1000 / v.timescale.max(1) as u64;
    let a_ms = a_dur * 1000 / scan.audio_timescale.max(1) as u64;
    let movie_dur = v_ms.max(a_ms).max(1);

    let mut mvhd = Vec::new();
    mvhd.extend_from_slice(&0u32.to_be_bytes()); // creation
    mvhd.extend_from_slice(&0u32.to_be_bytes()); // modification
    mvhd.extend_from_slice(&1000u32.to_be_bytes()); // timescale
    mvhd.extend_from_slice(&(movie_dur as u32).to_be_bytes());
    mvhd.extend_from_slice(&0x00010000u32.to_be_bytes()); // rate
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes()); // volume
    mvhd.extend_from_slice(&0u16.to_be_bytes());
    mvhd.extend_from_slice(&[0u8; 8]); // reserved
    mvhd.extend_from_slice(&UNITY_MATRIX);
    mvhd.extend_from_slice(&[0u8; 24]); // pre_defined
    // next_track_id 必须大于已用最大轨号：视频=1、音频=2，故无音轨时 2、有音轨时 3
    let next_track_id: u32 = if audio.is_some() { 3 } else { 2 };

    let mut traks = build_video_trak(avi, v, scan, base, movie_dur);
    if let Some(a) = audio {
        traks.extend(build_audio_trak(a, scan, base, movie_dur));
    }
    mvhd.extend_from_slice(&next_track_id.to_be_bytes());
    atom(b"moov", &[full(b"mvhd", 0, 0, &mvhd), traks].concat())
}

fn tkhd(track_id: u32, dur: u64, width: u16, height: u16, volume: u16) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&0u32.to_be_bytes()); // creation
    p.extend_from_slice(&0u32.to_be_bytes()); // modification
    p.extend_from_slice(&track_id.to_be_bytes());
    p.extend_from_slice(&0u32.to_be_bytes()); // reserved
    p.extend_from_slice(&(dur as u32).to_be_bytes()); // 以 movie timescale 计
    p.extend_from_slice(&[0u8; 8]); // reserved
    p.extend_from_slice(&0u16.to_be_bytes()); // layer
    p.extend_from_slice(&0u16.to_be_bytes()); // alternate_group
    p.extend_from_slice(&volume.to_be_bytes());
    p.extend_from_slice(&0u16.to_be_bytes()); // reserved
    p.extend_from_slice(&UNITY_MATRIX);
    p.extend_from_slice(&((width as u32) << 16).to_be_bytes());
    p.extend_from_slice(&((height as u32) << 16).to_be_bytes());
    full(b"tkhd", 0, 0x000007, &p)
}

fn mdhd(timescale: u32, dur: u64) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&0u32.to_be_bytes());
    p.extend_from_slice(&0u32.to_be_bytes());
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&(dur as u32).to_be_bytes());
    p.extend_from_slice(&0x55c4u16.to_be_bytes()); // 'und'
    p.extend_from_slice(&0u16.to_be_bytes());
    full(b"mdhd", 0, 0, &p)
}

fn hdlr(handler: &[u8; 4], name: &str) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    p.extend_from_slice(handler);
    p.extend_from_slice(&[0u8; 12]); // reserved
    p.extend_from_slice(name.as_bytes());
    p.push(0);
    full(b"hdlr", 0, 0, &p)
}

fn dinf() -> Vec<u8> {
    // dref 是 full box：version/flags + entry_count(=1) 之后才是 url 子盒。
    // 旧实现用裸 atom() 漏写了这 8 字节，播放器把 url 的 size 字段当成 entry_count，
    // 解析 dref 即失败——所有转封装产物因此 "error reading header"（黑屏）。
    // dref[url ] flags=1：数据在**本文件**里，别让播放器去找外部文件
    atom(
        b"dinf",
        &atom(
            b"dref",
            &[
                0u32.to_be_bytes().as_slice(), // version + flags
                1u32.to_be_bytes().as_slice(), // entry_count
                full(b"url ", 0, 1, &[]).as_slice(),
            ]
            .concat(),
        ),
    )
}

fn build_video_trak(avi: &Avi, v: &Track, scan: &Scan, base: u64, movie_dur: u64) -> Vec<u8> {
    let (width, height) = avi
        .streams
        .iter()
        .find(|s| s.is_video)
        .map(|s| (s.width.max(1), s.height.max(1)))
        .unwrap_or((1, 1));
    let mut entry = 1u32.to_be_bytes().to_vec(); // entry_count
    entry.extend_from_slice(&avc1_entry(
        width,
        height,
        scan.avcc.as_deref().unwrap_or(&[]),
    ));
    let stbl = atom(
        b"stbl",
        &[
            full(b"stsd", 0, 0, &entry),
            stts(&v.samples),
            stss(&v.samples),
            stsc(v.samples.len()),
            stsz(&v.samples),
            stco(&v.samples, base),
        ]
        .concat(),
    );
    let minf = atom(
        b"minf",
        &[full(b"vmhd", 0, 1, &[0u8; 8]), dinf(), stbl].concat(),
    );
    let mdia = atom(
        b"mdia",
        &[
            mdhd(v.timescale, v_dur_of(v)),
            hdlr(b"vide", "VideoHandler"),
            minf,
        ]
        .concat(),
    );
    atom(
        b"trak",
        &[tkhd(1, movie_dur, width, height, 0), mdia].concat(),
    )
}

fn v_dur_of(v: &Track) -> u64 {
    v.samples.iter().map(|s| s.dur as u64).sum()
}

fn build_audio_trak(a: &Track, scan: &Scan, base: u64, movie_dur: u64) -> Vec<u8> {
    let kind = scan.audio_kind.unwrap_or(AudioKind::Mp3);
    let sr = scan.audio_timescale.max(8000);
    let channels = scan.audio_channels.max(1);
    let asc = scan.audio_asc.clone().unwrap_or_default();
    let oti = if kind == AudioKind::Aac { 0x40 } else { 0x6b };
    let mut entry = 1u32.to_be_bytes().to_vec();
    entry.extend_from_slice(&mp4a_entry(oti, &asc, channels, sr));
    let stbl = atom(
        b"stbl",
        &[
            full(b"stsd", 0, 0, &entry),
            stts(&a.samples),
            stsc(a.samples.len()),
            stsz(&a.samples),
            stco(&a.samples, base),
        ]
        .concat(),
    );
    let minf = atom(
        b"minf",
        &[full(b"smhd", 0, 0, &[0u8; 4]), dinf(), stbl].concat(),
    );
    let mdia = atom(
        b"mdia",
        &[
            mdhd(sr, a.samples.iter().map(|s| s.dur as u64).sum()),
            hdlr(b"soun", "SoundHandler"),
            minf,
        ]
        .concat(),
    );
    atom(b"trak", &[tkhd(2, movie_dur, 0, 0, 0x0100), mdia].concat())
}

fn avc1_entry(width: u16, height: u16, avcc: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&[0u8; 6]); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&[0u8; 16]); // pre_defined / reserved
    p.extend_from_slice(&width.to_be_bytes());
    p.extend_from_slice(&height.to_be_bytes());
    p.extend_from_slice(&0x00480000u32.to_be_bytes()); // 72 dpi
    p.extend_from_slice(&0x00480000u32.to_be_bytes());
    p.extend_from_slice(&0u32.to_be_bytes()); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // frame_count
    let mut name = [0u8; 32];
    name[0] = 4;
    name[1..5].copy_from_slice(b"avc1");
    p.extend_from_slice(&name);
    p.extend_from_slice(&0x0018u16.to_be_bytes()); // depth
    p.extend_from_slice(&0xffffu16.to_be_bytes()); // pre_defined
    p.extend_from_slice(&atom(b"avcC", avcc));
    atom(b"avc1", &p)
}

fn mp4a_entry(oti: u8, asc: &[u8], channels: u16, sr: u32) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&[0u8; 6]); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&0u16.to_be_bytes()); // version
    p.extend_from_slice(&0u16.to_be_bytes()); // revision
    p.extend_from_slice(&0u32.to_be_bytes()); // vendor
    p.extend_from_slice(&channels.to_be_bytes());
    p.extend_from_slice(&16u16.to_be_bytes()); // sample size
    p.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    p.extend_from_slice(&0u16.to_be_bytes()); // reserved
    p.extend_from_slice(&(sr << 16).to_be_bytes()); // 16.16
    p.extend_from_slice(&esds(oti, asc, sr));
    atom(b"mp4a", &p)
}

/// `esds`：MP3 走 objectTypeIndication 0x6B、AAC 走 0x40 + AudioSpecificConfig。
fn esds(oti: u8, dsi: &[u8], sr: u32) -> Vec<u8> {
    let mut dsi_box = Vec::new();
    if !dsi.is_empty() {
        dsi_box.push(0x05); // DecoderSpecificInfo
        dsi_box.push(dsi.len() as u8);
        dsi_box.extend_from_slice(dsi);
    }
    let mut dcd = vec![
        0x04, // DecoderConfigDescriptor
        (13 + dsi_box.len()) as u8,
        oti,
        0x15, // streamType=5(Audio) + upStream=0 + reserved=1
    ];
    dcd.extend_from_slice(&[0u8; 3]); // bufferSizeDB
    let br = sr * 2; // 粗估：够播放器分配缓冲即可
    dcd.extend_from_slice(&br.to_be_bytes());
    dcd.extend_from_slice(&br.to_be_bytes());
    dcd.extend_from_slice(&dsi_box);
    let sl = [0x06, 0x01, 0x02]; // SLConfigDescriptor
    let mut es = Vec::new();
    es.push(0x03); // ES_Descriptor
    es.push((3 + dcd.len() + sl.len()) as u8);
    es.extend_from_slice(&1u16.to_be_bytes()); // ES_ID
    es.push(0x00); // flags
    es.extend_from_slice(&dcd);
    es.extend_from_slice(&sl);
    full(b"esds", 0, 0, &es)
}

/// 时间→样本：相邻同 delta 的合并，常规 GOP 结构只会剩很少几条。
fn stts(s: &[Sample]) -> Vec<u8> {
    let mut entries: Vec<(u32, u32)> = Vec::new();
    for x in s {
        match entries.last_mut() {
            Some((c, d)) if *d == x.dur => *c += 1,
            _ => entries.push((1, x.dur)),
        }
    }
    let mut p = (entries.len() as u32).to_be_bytes().to_vec();
    for (c, d) in entries {
        p.extend_from_slice(&c.to_be_bytes());
        p.extend_from_slice(&d.to_be_bytes());
    }
    full(b"stts", 0, 0, &p)
}

/// 关键帧样本号（1-based）：没有它 seek 会落到非 IDR 上（画面先碎一会儿）。
fn stss(s: &[Sample]) -> Vec<u8> {
    let keys: Vec<u32> = s
        .iter()
        .enumerate()
        .filter(|(_, x)| x.sync)
        .map(|(i, _)| i as u32 + 1)
        .collect();
    if keys.is_empty() {
        return full(b"stss", 0, 0, &0u32.to_be_bytes());
    }
    let mut p = (keys.len() as u32).to_be_bytes().to_vec();
    for k in keys {
        p.extend_from_slice(&k.to_be_bytes());
    }
    full(b"stss", 0, 0, &p)
}

/// 一个样本一个 chunk：`stsc` 只需一条，代价是 `stco` 与样本数等长（几十万帧也才几 MB）。
fn stsc(n: usize) -> Vec<u8> {
    if n == 0 {
        return full(b"stsc", 0, 0, &0u32.to_be_bytes());
    }
    let mut p = 1u32.to_be_bytes().to_vec(); // entry_count
    p.extend_from_slice(&1u32.to_be_bytes()); // first_chunk
    p.extend_from_slice(&1u32.to_be_bytes()); // samples_per_chunk
    p.extend_from_slice(&1u32.to_be_bytes()); // sample_description_index
    full(b"stsc", 0, 0, &p)
}

fn stsz(s: &[Sample]) -> Vec<u8> {
    let mut p = 0u32.to_be_bytes().to_vec(); // sample_size=0 → 逐样本给大小
    p.extend_from_slice(&(s.len() as u32).to_be_bytes());
    for x in s {
        p.extend_from_slice(&x.size.to_be_bytes());
    }
    full(b"stsz", 0, 0, &p)
}

/// 偏移表：`stco` 只有 32 位，超过 4GB 必须换 `co64`，否则偏移会被截断。
fn stco(s: &[Sample], base: u64) -> Vec<u8> {
    let offsets: Vec<u64> = s.iter().map(|x| base + x.offset).collect();
    let wide = offsets.iter().any(|o| *o > u32::MAX as u64);
    let mut p = (offsets.len() as u32).to_be_bytes().to_vec();
    for o in offsets {
        if wide {
            p.extend_from_slice(&o.to_be_bytes());
        } else {
            p.extend_from_slice(&(o as u32).to_be_bytes());
        }
    }
    full(if wide { b"co64" } else { b"stco" }, 0, 0, &p)
}

// ---------------------------------------------------------------- 进度

struct Tick<'a> {
    ch: Option<&'a Channel<RemuxProgress>>,
    total: u64,
    last: Instant,
}

impl<'a> Tick<'a> {
    fn new(ch: Option<&'a Channel<RemuxProgress>>, total: u64) -> Self {
        Self {
            ch,
            total,
            last: Instant::now() - PROGRESS_INTERVAL,
        }
    }
    fn tick(&mut self, done: u64) {
        if self.last.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.last = Instant::now();
        if let Some(ch) = self.ch {
            let _ = ch.send(RemuxProgress {
                done,
                total: self.total,
                pct: pct_of(done, self.total),
            });
        }
    }
}

fn le_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([
        b.get(at).copied().unwrap_or(0),
        b.get(at + 1).copied().unwrap_or(0),
    ])
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([
        b.get(at).copied().unwrap_or(0),
        b.get(at + 1).copied().unwrap_or(0),
        b.get(at + 2).copied().unwrap_or(0),
        b.get(at + 3).copied().unwrap_or(0),
    ])
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    /// 造 hdrl（视频 H264 + 音频 MP3）并拼上给定的 movi 载荷，得到完整 AVI。
    /// 抽出它是为了让测试能往 movi 里塞任意异常块（如 size==0 占位头）。
    fn avi_from_movi(movi_payload: &[u8]) -> Vec<u8> {
        let mut vstrf = vec![0u8; 40];
        vstrf[0..4].copy_from_slice(&40u32.to_le_bytes());
        vstrf[4..8].copy_from_slice(&320u32.to_le_bytes()); // biWidth
        vstrf[8..12].copy_from_slice(&240u32.to_le_bytes()); // biHeight
        vstrf[16..20].copy_from_slice(b"H264");
        let mut vstrh = vec![0u8; 56];
        vstrh[0..4].copy_from_slice(b"vids");
        vstrh[20..24].copy_from_slice(&1u32.to_le_bytes()); // dwScale
        vstrh[24..28].copy_from_slice(&25u32.to_le_bytes()); // dwRate
        let vstrl = list(
            b"strl",
            &[chunk(b"strh", &vstrh), chunk(b"strf", &vstrf)].concat(),
        );

        let mut astrf = vec![0u8; 16];
        astrf[0..2].copy_from_slice(&0x0055u16.to_le_bytes()); // MP3
        astrf[2..4].copy_from_slice(&2u16.to_le_bytes()); // channels
        astrf[4..8].copy_from_slice(&44100u32.to_le_bytes());
        let mut astrh = vec![0u8; 56];
        astrh[0..4].copy_from_slice(b"auds");
        let astrl = list(
            b"strl",
            &[chunk(b"strh", &astrh), chunk(b"strf", &astrf)].concat(),
        );
        let hdrl = list(b"hdrl", &[vstrl, astrl].concat());

        let movi = list(b"movi", movi_payload);
        let body = [hdrl, movi].concat();
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(b"AVI ");
        out.extend_from_slice(&body);
        out
    }

    /// 造一个最小可解析的 AVI：hdrl（视频 H264 + 音频 MP3）+ movi（两帧视频 + 一帧音频）
    fn sample_avi(video_frames: &[Vec<u8>], audio: &[u8]) -> Vec<u8> {
        let mut movi = Vec::new();
        for f in video_frames {
            movi.extend_from_slice(&chunk(b"00dc", f));
        }
        if !audio.is_empty() {
            movi.extend_from_slice(&chunk(b"01wb", audio));
        }
        avi_from_movi(&movi)
    }

    fn chunk(id: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(id);
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            v.push(0);
        }
        v
    }

    fn list(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"LIST");
        v.extend_from_slice(&((payload.len() + 4) as u32).to_le_bytes());
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }

    /// 一帧 Annex-B 的 H.264：SPS + PPS + IDR（够让 `avcC` 成形）
    fn idr_frame() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&[0, 0, 0, 1]);
        v.extend_from_slice(&[0x67, 0x42, 0x00, 0x1e, 0xab]); // SPS
        v.extend_from_slice(&[0, 0, 0, 1]);
        v.extend_from_slice(&[0x68, 0xce, 0x3c, 0x80]); // PPS
        v.extend_from_slice(&[0, 0, 0, 1]);
        v.extend_from_slice(&[0x65, 0x88, 0x84, 0x00]); // IDR slice
        v
    }

    fn non_idr_frame() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&[0, 0, 0, 1]);
        v.extend_from_slice(&[0x41, 0x9a, 0x24, 0x6c]); // 非 IDR slice
        v
    }

    /// 一段合法 MP3 帧头（MPEG1 Layer III, 128kbps, 44.1kHz）：帧长 417 + padding
    fn mp3_frame_bytes() -> Vec<u8> {
        let mut v = vec![0xff, 0xfb, 0x90, 0x00]; // 0x90: bitrate idx 9 (128k), sr idx 0
        v.resize(417, 0x11);
        v
    }

    #[test]
    fn annexb_is_split_into_bare_nalus() {
        let f = idr_frame();
        let nalus = split_nalus(&f).expect("Annex-B 必须认出来");
        assert_eq!(nalus.len(), 3, "SPS/PPS/IDR 三个 NALU");
        assert_eq!(nalus[0][0] & 0x1f, 7, "第一个是 SPS");
        assert_eq!(nalus[2][0] & 0x1f, 5, "第三个是 IDR");
        // 转成 AVCC 后每个 NALU 多 4 字节长度、少 3~4 字节起始码
        let plan = plan_frame(&f).unwrap();
        assert_eq!(plan.size, 4 * 3 + 5 + 4 + 4, "AVCC 大小要按长度前缀算");
        assert!(plan.sync, "含 IDR 即关键帧");
        assert!(plan.sps.is_some() && plan.pps.is_some());
    }

    #[test]
    fn avcc_input_is_accepted_too() {
        // 4 字节长度前缀的格式也要认（AVI 里两种都有人写）
        let mut f = Vec::new();
        f.extend_from_slice(&5u32.to_be_bytes());
        f.extend_from_slice(&[0x67, 0x42, 0x00, 0x1e, 0xab]);
        f.extend_from_slice(&4u32.to_be_bytes());
        f.extend_from_slice(&[0x68, 0xce, 0x3c, 0x80]);
        let plan = plan_frame(&f).unwrap();
        assert_eq!(plan.size, 4 + 5 + 4 + 4);
        assert!(plan.sps.is_some(), "avcC 需要 SPS");
    }

    #[test]
    fn non_idr_is_not_marked_as_keyframe() {
        assert!(!plan_frame(&non_idr_frame()).unwrap().sync);
    }

    #[test]
    fn mp3_frame_length_and_samples_match_the_header() {
        let d = mp3_frame_bytes();
        let (len, samples) = mp3_frame(&d).unwrap();
        // MPEG1 Layer III @128kbps/44.1kHz：144*128000/44100 = 417
        assert_eq!(len, 417);
        assert_eq!(samples, 1152, "MPEG1 Layer III 每帧 1152 采样");
    }

    #[test]
    fn adts_and_mp3_are_told_apart_by_layer_bits() {
        let mp3 = mp3_frame_bytes();
        // frame_length(13 bits) 分散在 byte3 低 2 位 / byte4 / byte5 高 3 位 = 64
        let mut adts = vec![0xff, 0xf1, 0x50, 0x80, 0x08, 0x00, 0x00];
        adts.resize(64, 0x22);
        assert_eq!(sniff_audio(0x0055, &mp3), Some(AudioKind::Mp3));
        assert_eq!(sniff_audio(0x0055, &adts), Some(AudioKind::Aac));
        assert_eq!(sniff_audio(0x0001, &[0x01, 0x02, 0x03]), None, "PCM 不认");
    }

    #[test]
    fn adts_frame_strips_its_header() {
        let mut adts = vec![0xff, 0xf1, 0x50, 0x80, 0x08, 0x00, 0x00]; // frame_length = 64
        adts.resize(64, 0x22);
        let (total, len, dur) = adts_frame(&adts).unwrap();
        assert_eq!(total, 64, "整帧长度含 7 字节头");
        assert_eq!(len, 64 - 7, "装进 MP4 的是去头后的裸 AAC");
        assert_eq!(dur, 1024);
    }

    #[test]
    fn moov_length_does_not_depend_on_chunk_offsets() {
        // `stco` 的偏移值长度固定：占位算出来的长度必须等于真实长度，
        // 否则 `mdat` 起点就错了（样本表整体偏移，产物必然花屏）
        let mut scan = Scan::default();
        scan.video.timescale = VIDEO_TIMESCALE;
        scan.video.samples = vec![
            Sample {
                offset: 0,
                size: 10,
                dur: 3600,
                sync: true,
            },
            Sample {
                offset: 10,
                size: 20,
                dur: 3600,
                sync: false,
            },
        ];
        scan.avcc = Some(build_avcc(&[0x67, 0x42, 0, 0x1e], &[0x68, 0xce]));
        let mut avi = Avi {
            streams: vec![],
            movi_start: 0,
            movi_end: 0,
            frame_us: 40000,
        };
        avi.streams.push(Stream {
            no: 0,
            is_video: true,
            scale: 1,
            rate: 25,
            width: 320,
            height: 240,
            tag: 0,
            channels: 2,
            sample_rate: 44100,
        });
        assert_eq!(
            build_moov(&avi, &scan, None, 0).len(),
            build_moov(&avi, &scan, None, 1 << 20).len()
        );
    }

    #[test]
    fn avi_with_h264_and_mp3_is_planned_into_samples() {
        let avi_bytes = sample_avi(&[idr_frame(), non_idr_frame()], &mp3_frame_bytes());
        let p = std::env::temp_dir().join("aviremux-plan.avi");
        fs::write(&p, &avi_bytes).unwrap();
        let mut f = File::open(&p).unwrap();
        let size = avi_bytes.len() as u64;
        let avi = parse_header(&mut f, size).expect("头必须解析得出来");
        assert_eq!(avi.streams.len(), 2, "视频 + 音频两轨");
        assert_eq!(avi.streams[0].width, 320);
        assert_eq!(avi.streams[0].height, 240);

        let mut scan = Scan::default();
        let mut tick = Tick::new(None, size);
        scan_samples(&mut f, &avi, &mut scan, &mut tick).unwrap();
        assert_eq!(scan.video.samples.len(), 2, "两帧视频");
        assert_eq!(scan.audio.samples.len(), 1, "一段 MP3 一个样本");
        assert!(scan.avcc.is_some(), "avcC 必须成形，否则解码器无从下手");
        assert_eq!(scan.video.samples[0].dur, 3600, "25fps @90kHz");
        assert!(scan.video.samples[0].sync && !scan.video.samples[1].sync);
        // 第一帧在 mdat 开头，第二帧紧随其后（偏移必须连续，否则就是交错了）
        assert_eq!(
            scan.video.samples[1].offset,
            scan.video.samples[0].size as u64
        );
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn produced_mp4_is_recognized_as_playable_and_holds_exactly_the_samples() {
        // 端到端：AVI → MP4 之后，`probe` 必须认为它**不用再转**，
        // 且 `mdat` 里装的字节数正好等于样本表描述的那些（多一个少一个都是花屏）
        let bytes = sample_avi(&[idr_frame(), non_idr_frame()], &mp3_frame_bytes());
        let p = std::env::temp_dir().join("aviremux-e2e.avi");
        fs::write(&p, &bytes).unwrap();
        let out = std::env::temp_dir().join("aviremux-e2e.mp4");
        let _ = fs::remove_file(&out);

        let mut f = File::open(&p).unwrap();
        let size = bytes.len() as u64;
        let avi = parse_header(&mut f, size).unwrap();
        let mut scan = Scan::default();
        let mut tick = Tick::new(None, size);
        scan_samples(&mut f, &avi, &mut scan, &mut tick).unwrap();
        write_mp4(&out, &avi, &scan, &mut f, &mut tick).unwrap();

        let produced = fs::read(&out).unwrap();
        assert_eq!(&produced[4..8], b"ftyp", "产物必须以 ftyp 开头");
        for want in [
            b"moov".as_slice(),
            b"mdat".as_slice(),
            b"avc1".as_slice(),
            b"mp4a".as_slice(),
        ] {
            assert!(
                produced.windows(4).any(|w| w == want),
                "缺少 {}",
                String::from_utf8_lossy(want)
            );
        }
        let mdat = produced.windows(4).position(|w| w == b"mdat").unwrap() + 4;
        assert_eq!(
            produced.len() - mdat,
            scan.mdat_len as usize,
            "mdat 的字节数必须与样本表一致"
        );
        // 转完就该是个普通可播的 mp4：再 probe 一次不该给出任何转换建议
        let info = crate::probe::probe(&out.to_string_lossy());
        assert_eq!(info.container.as_deref(), Some("mp4 (isom)"));
        assert_eq!(info.container_hint, None, "产物不该再被判为容器不可播");
        assert_eq!(info.suggest_command, None, "产物不该再需要转封装");

        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(&out);
    }

    #[test]
    fn dirty_bytes_before_frames_are_resynced_not_fatal() {
        // 录制器塞的垃圾前缀 / 帧头错位：跳字节重同步后照样切出完整帧，
        // 这是 `audio_malformed` 把整个转换判死的事故的直接回归测试
        let mp3 = mp3_frame_bytes();
        let mut dirty = vec![0x13, 0x37, 0x00, 0xff, 0x00]; // 伪同步字也要跳得过去
        dirty.extend_from_slice(&mp3);
        dirty.extend_from_slice(&mp3_frame_bytes());
        let mut p = AudioStreamParser::new(AudioKind::Mp3);
        let mut frames = Vec::new();
        p.feed(&dirty, &mut frames, &mut std::io::sink()).unwrap();
        assert_eq!(frames.len(), 2, "两帧都要切出来");
        assert_eq!(frames[0].offset, 0, "第一帧从垃圾之后开始（负载从 0 记）");
        assert_eq!(frames[0].size, 417);
    }

    #[test]
    fn garbage_audio_chunk_yields_no_samples_but_no_error() {
        // 整块都解不出帧：只损失这一块，绝不把整个转换判死
        let garbage: Vec<u8> = (0..1024u32).map(|i| (i * 7 + 3) as u8).collect();
        let mut p = AudioStreamParser::new(AudioKind::Mp3);
        let mut out = Vec::new();
        p.feed(&garbage, &mut out, &mut std::io::sink()).unwrap();
        assert!(out.is_empty());
        let mut p = AudioStreamParser::new(AudioKind::Aac);
        let mut out = Vec::new();
        p.feed(&garbage, &mut out, &mut std::io::sink()).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn audio_frame_split_across_chunks_is_stitched() {
        // 真机实证（492MB 网课 AVI）：01wb 块是连续 MP3 流的任意切分，帧会跨块
        // （块只有 387B，帧头声明 522B）。按块内独立切帧只能撞出 4% 假帧；
        // 跨块 carry 拼接必须把帧完整拼回来，样本大小与帧长一致。
        let frame = mp3_frame_bytes();
        let (a, b) = frame.split_at(100); // 一帧硬切进相邻两块
        let mut movi = Vec::new();
        movi.extend_from_slice(&chunk(b"00dc", &idr_frame()));
        movi.extend_from_slice(&chunk(b"01wb", a));
        movi.extend_from_slice(&chunk(b"00dc", &non_idr_frame()));
        movi.extend_from_slice(&chunk(b"01wb", b));
        let bytes = avi_from_movi(&movi);
        let p = std::env::temp_dir().join("aviremux-split.avi");
        fs::write(&p, &bytes).unwrap();
        let mut f = File::open(&p).unwrap();
        let size = bytes.len() as u64;
        let avi = parse_header(&mut f, size).unwrap();
        let mut scan = Scan::default();
        let mut tick = Tick::new(None, size);
        scan_samples(&mut f, &avi, &mut scan, &mut tick).unwrap();
        assert_eq!(scan.audio.samples.len(), 1, "跨块两半必须拼回一帧");
        let s = &scan.audio.samples[0];
        assert_eq!(s.size as usize, frame.len(), "样本大小 = 完整帧长");
        let v_total: usize = scan
            .video
            .samples
            .iter()
            .map(|s| s.size as usize)
            .sum();
        assert_eq!(
            s.offset as usize,
            v_total,
            "音频区紧跟视频区，区内偏移平移正确"
        );
        assert_eq!(
            scan.mdat_len as usize,
            v_total + frame.len(),
            "mdat = 视频区 + 音频帧"
        );
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn undecodable_audio_degrades_to_video_only_remux() {
        // 音轨彻底救不了 → 纯视频转封装（有画面没声音远好过打不开）：
        // 视频样本一个不少、音频样本为空、mdat 长度只含视频
        let bytes = sample_avi(
            &[idr_frame(), non_idr_frame()],
            &[0x13, 0x37, 0x99, 0x42, 0x00],
        );
        let p = std::env::temp_dir().join("aviremux-degrade.avi");
        fs::write(&p, &bytes).unwrap();
        let mut f = File::open(&p).unwrap();
        let size = bytes.len() as u64;
        let avi = parse_header(&mut f, size).unwrap();
        let mut scan = Scan::default();
        let mut tick = Tick::new(None, size);
        scan_samples(&mut f, &avi, &mut scan, &mut tick).unwrap();
        assert_eq!(scan.video.samples.len(), 2, "视频样本一个不能少");
        assert!(
            scan.audio.samples.is_empty(),
            "救不了的音轨放弃，而不是报错"
        );
        assert_eq!(
            scan.mdat_len as usize,
            plan_frame(&idr_frame()).unwrap().size + plan_frame(&non_idr_frame()).unwrap().size,
            "mdat 只含视频字节"
        );
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn pcm_audio_is_rejected_instead_of_being_guessed() {
        // PCM 进了 MP4 是错的时长：宁可不认，也不能给一个会漂移的音轨
        assert!(sniff_audio(0x0001, &[0x01, 0x00, 0x02, 0x00]).is_none());
    }

    #[test]
    fn video_timing_falls_back_to_avih_when_strh_is_useless() {
        let s = Stream {
            no: 0,
            is_video: true,
            scale: 0,
            rate: 0,
            width: 0,
            height: 0,
            tag: 0,
            channels: 0,
            sample_rate: 0,
        };
        let (ts, dur) = video_timing(Some(&s), 40000); // 25fps
        assert_eq!(ts, VIDEO_TIMESCALE);
        assert_eq!(dur, 3600);
    }

    #[test]
    fn zero_sized_placeholder_chunk_does_not_truncate_scan() {
        // 真机录制文件常在帧间塞 size==0 的占位头；旧逻辑 next_chunk 直接 break，
        // 492MB 的 AVI 只转出 72 帧却「成功」。新逻辑越过坏头继续扫，后面的帧也要切出来。
        let mut movi = Vec::new();
        movi.extend_from_slice(&chunk(b"00dc", &idr_frame()));
        movi.extend_from_slice(&chunk(b"00dc", &[])); // 占位坏头：size=0
        movi.extend_from_slice(&chunk(b"00dc", &non_idr_frame()));
        movi.extend_from_slice(&chunk(b"01wb", &mp3_frame_bytes()));
        let bytes = avi_from_movi(&movi);

        let p = std::env::temp_dir().join("aviremux-ph.avi");
        fs::write(&p, &bytes).unwrap();
        let mut f = File::open(&p).unwrap();
        let size = bytes.len() as u64;
        let avi = parse_header(&mut f, size).unwrap();
        let mut scan = Scan::default();
        let mut tick = Tick::new(None, size);
        scan_samples(&mut f, &avi, &mut scan, &mut tick).unwrap();
        assert_eq!(scan.video.samples.len(), 2, "占位块后面的帧也必须扫到");

        // 端到端再跑一遍：write_mp4 必须认同同样的样本数，mdat 长度自洽，
        // 否则占位块会让 moov 与 mdat 对不上（产物花屏）。
        let out = std::env::temp_dir().join("aviremux-ph.mp4");
        let _ = fs::remove_file(&out);
        write_mp4(&out, &avi, &scan, &mut f, &mut tick).unwrap();
        let produced = fs::read(&out).unwrap();
        let mdat = produced.windows(4).position(|w| w == b"mdat").unwrap() + 4;
        assert_eq!(produced.len() - mdat, scan.mdat_len as usize);
        // 产物必须过 verify_moov 自检，且能被 probe 认作可播 mp4
        assert_eq!(crate::probe::probe(&out.to_string_lossy()).container_hint, None);
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(&out);
    }
}
