// Media helpers: probing source files and decoding audio with the bundled ffmpeg.
const { spawn } = require('child_process');
const { readSidecar } = require('./sony');

// Binaries live inside node_modules; in a packaged app they must be read from app.asar.unpacked.
const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const FFMPEG = unpacked(require('ffmpeg-static'));
const FFPROBE = unpacked(require('ffprobe-static').path);

const ANALYSIS_RATE = 16000;

function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      err += d;
      if (onStderr) onStderr(d.toString());
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with code ${code}: ${err.slice(-2000)}`));
    });
  });
}

function parseRate(r) {
  if (!r || r === '0/0') return null;
  const [n, d] = r.split('/').map(Number);
  return d ? { num: n, den: d } : { num: n, den: 1 };
}

async function probe(file) {
  const json = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(json.toString());
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream found');

  const rate = parseRate(video.r_frame_rate) || parseRate(video.avg_frame_rate);
  const duration = Number(info.format.duration || video.duration);

  // Timecode can be on the format, the video stream or a data stream depending on the camera.
  // Record where it came from: when importing FCPXML, Final Cut reads a QuickTime 'tmcd' track but
  // not the timecode in Sony XAVC's 'rtmd' metadata track (see fcpReadsTimecode in fcpxml.js).
  let timecode = null;
  let timecodeSource = null;
  for (const s of streams) {
    if (!timecode && s.tags?.timecode) {
      timecode = s.tags.timecode;
      timecodeSource = s.codec_tag_string || s.codec_type;
    }
  }
  if (!timecode && info.format.tags?.timecode) {
    timecode = info.format.tags.timecode;
    timecodeSource = 'format';
  }
  // A Sony sidecar carries the drop-frame flag that the MP4's own timecode tag loses, so it takes
  // precedence. (Only used on export with the 'source' timecode setting.)
  const sidecar = readSidecar(file);
  if (sidecar?.timecode) {
    timecode = sidecar.timecode;
    timecodeSource = 'sidecar';
  }

  return {
    file,
    duration,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    frameRate: rate, // {num, den}, e.g. 30000/1001
    nbFrames: video.nb_frames ? Number(video.nb_frames) : null,
    timecode,
    timecodeSource, // 'sidecar', 'tmcd', 'rtmd', 'avc1' (video stream tag), 'format', …
    sidecar, // Sony M01.XML: { path, status, timecode, dropFrame, model } or null
    clipStatus: sidecar?.status || null, // camera clip flag, e.g. 'KEEP' or 'NG'
    audioTracks: audio.map((a, i) => ({
      index: i,
      codec: a.codec_name,
      channels: a.channels,
      sampleRate: Number(a.sample_rate),
    })),
    creationTime: info.format.tags?.creation_time || null,
  };
}

// Decode audio to mono 16 kHz float32. `track` is 'mix' or a 0-based audio track index.
async function decodeAudio(file, info, track = 'mix', onProgress) {
  const n = info.audioTracks.length;
  if (!n) throw new Error('No audio tracks found');
  const args = ['-v', 'error', '-stats', '-i', file];
  if (track === 'mix' && n > 1) {
    const inputs = info.audioTracks.map((t) => `[0:a:${t.index}]`).join('');
    args.push('-filter_complex', `${inputs}amix=inputs=${n}:normalize=0[a]`, '-map', '[a]');
  } else {
    const idx = track === 'mix' ? 0 : Math.min(Number(track), n - 1);
    args.push('-map', `0:a:${idx}`);
  }
  args.push('-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', '-');

  const buf = await run(FFMPEG, args, {
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m && onProgress) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(1, t / info.duration));
      }
    },
  });
  // Copy into an aligned buffer before viewing as float32.
  const samples = new Float32Array(buf.length >> 2);
  Buffer.from(samples.buffer).set(buf.subarray(0, samples.length * 4));
  return samples;
}

// Write mono 16-bit PCM WAV, peak-normalising so mixed or quiet tracks reach whisper at a sane level.
function encodeWav(samples, rate = ANALYSIS_RATE) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0 ? 0.9 / peak : 1;
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * gain));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// Small H.264 proxy for previewing sources Chromium can't decode (e.g. XAVC 4:2:2 10-bit).
async function makeProxy(file, out, duration, onProgress) {
  const base = ['-v', 'error', '-stats', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=-2:540,format=yuv420p'];
  const tail = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', out];
  const onStderr = (s) => {
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
    if (m && onProgress) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration));
  };
  try {
    await run(FFMPEG, [...base, '-c:v', 'h264_videotoolbox', '-b:v', '2500k', ...tail], { onStderr });
  } catch {
    await run(FFMPEG, [...base, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', ...tail], { onStderr });
  }
}

module.exports = { probe, decodeAudio, encodeWav, makeProxy, ANALYSIS_RATE, FFMPEG, FFPROBE };
