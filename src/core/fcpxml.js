// FCPXML 1.11 export: one event of browser clips, with cuts as keyword ranges and/or rejected ranges.
const { pathToFileURL } = require('url');
const path = require('path');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Frame timing helpers. FCP expresses integer rates as 100/(N*100)s and NTSC rates as 1001/(N*1000)s.
function timebase({ num, den }) {
  if (den === 1) return { n: 100, d: num * 100, fps: num, nominal: num };
  return { n: den, d: num, fps: num / den, nominal: Math.round(num / den) };
}
const timeStr = (tb, frames) => (frames === 0 ? '0s' : `${frames * tb.n}/${tb.d}s`);
const toFrames = (tb, seconds, mode = 'round') => Math[mode]((seconds * tb.d) / tb.n - 1e-9 * (mode === 'ceil'));

// Source timecode → frame count. ';' or '.' before the frames field means drop-frame.
function timecodeFrames(tc, tb) {
  const m = /^(\d+):(\d+):(\d+)([:;.,])(\d+)$/.exec(tc || '');
  if (!m) return { frames: 0, dropFrame: false };
  const [h, mi, s, f] = [m[1], m[2], m[3], m[5]].map(Number);
  const dropFrame = m[4] !== ':' && (tb.nominal === 30 || tb.nominal === 60);
  let frames = ((h * 60 + mi) * 60 + s) * tb.nominal + f;
  if (dropFrame) {
    const drop = tb.nominal / 15; // 2 frames per minute at 29.97, 4 at 59.94
    const minutes = h * 60 + mi;
    frames -= drop * (minutes - Math.floor(minutes / 10));
  }
  return { frames, dropFrame };
}

function formatName(info, tb) {
  const rate = { 23.976: '2398', 24: '24', 25: '25', 29.97: '2997', 30: '30', 50: '50', 59.94: '5994', 60: '60' }[
    Math.round(tb.fps * 1000) / 1000
  ];
  const sizes = { '1280x720': '720p', '1920x1080': '1080p', '3840x2160': '3840x2160p', '4096x2160': '4096x2160p' };
  const size = sizes[`${info.width}x${info.height}`];
  return rate && size ? `FFVideoFormat${size}${rate}` : null;
}

// The clip's start time in the XML must match what Final Cut itself reads from the media, or every
// keyword range lands outside the clip and is silently dropped on import.
//   'auto'   — use the timecode only where Final Cut reads it when importing FCPXML: a QuickTime
//              timecode track. Sony XAVC MP4s start at 0, even with their M01.XML sidecar beside
//              them (confirmed on NX800 card clips: ranges at the sidecar timecode were dropped).
//   'source' — always use any embedded/sidecar timecode.  'zero' — always start at 0.
function fcpReadsTimecode(info, mode = 'auto') {
  if (!info.timecode || mode === 'zero') return false;
  if (mode === 'source') return true;
  return info.timecodeSource === 'tmcd';
}

/**
 * clips: [{ file, analysis: { info, ... }, cuts: [{ start, end, kind, tones }] , details }]
 * opts: export settings (see settings.js)
 */
function buildFcpxml(clips, opts) {
  const resources = [];
  const items = [];
  const formats = new Map();
  let nextId = 1;
  const rid = () => `r${nextId++}`;

  for (const clip of clips) {
    const { info } = clip.analysis;
    const tb = timebase(info.frameRate);
    const fmtKey = `${info.width}x${info.height}@${tb.n}/${tb.d}`;
    if (!formats.has(fmtKey)) {
      const id = rid();
      formats.set(fmtKey, id);
      const name = formatName(info, tb);
      resources.push(
        `<format id="${id}"${name ? ` name="${name}"` : ''} frameDuration="${timeStr(tb, 1)}" width="${info.width}" height="${info.height}"/>`,
      );
    }
    const formatId = formats.get(fmtKey);
    const assetId = rid();
    const name = path.parse(clip.file).name;
    const totalFrames = info.nbFrames || toFrames(tb, info.duration, 'floor');
    const tc = fcpReadsTimecode(info, opts.timecode) ? timecodeFrames(info.timecode, tb) : { frames: 0, dropFrame: false };
    const start = tc.frames;
    const audio = info.audioTracks;
    const maxCh = Math.max(1, ...audio.map((a) => a.channels || 1));

    resources.push(
      `<asset id="${assetId}" name="${esc(name)}" start="${timeStr(tb, start)}" duration="${timeStr(tb, totalFrames)}" ` +
        `hasVideo="1" format="${formatId}" videoSources="1"` +
        (audio.length ? ` hasAudio="1" audioSources="${audio.length}" audioChannels="${maxCh}" audioRate="${audio[0].sampleRate || 48000}"` : '') +
        `>\n      <media-rep kind="original-media" src="${esc(pathToFileURL(clip.file).href)}"/>\n    </asset>`,
    );

    // Children must follow the DTD order: markers, ratings and keywords are all %marker_item;.
    const children = [];
    const clamp = (f) => Math.max(0, Math.min(totalFrames, f));
    for (const cut of clip.cuts) {
      if (cut.enabled === false) continue;
      // Round inwards so a cut never eats a frame of the material either side of it.
      const a = clamp(toFrames(tb, cut.start, 'ceil'));
      const b = clamp(toFrames(tb, cut.end, 'floor'));
      if (b <= a) continue;
      const range = `start="${timeStr(tb, start + a)}" duration="${timeStr(tb, b - a)}"`;
      const note = esc(cut.note || '');
      const keyword = cut.kind === 'uncertain' ? opts.uncertainKeyword : opts.retakeKeyword;
      if (opts.markAs === 'keyword' || opts.markAs === 'both')
        children.push(`<keyword ${range} value="${esc(keyword)}"${note ? ` note="${note}"` : ''}/>`);
      if (opts.markAs === 'reject' || opts.markAs === 'both') children.push(`<rating ${range} value="reject"${note ? ` note="${note}"` : ''}/>`);
    }
    // Clips flagged NG ("not good") on the camera are rejected in their entirety.
    if (info.clipStatus === 'NG') {
      children.push(`<rating start="${timeStr(tb, start)}" duration="${timeStr(tb, totalFrames)}" value="reject" note="Marked NG on camera"/>`);
    }
    if (opts.addToneMarkers) {
      for (const tone of clip.analysis.tones) {
        const f = clamp(toFrames(tb, tone.start, 'round'));
        children.push(`<marker start="${timeStr(tb, start + f)}" duration="${timeStr(tb, 1)}" value="Cue tone"/>`);
      }
    }
    children.sort((x, y) => markerSortKey(x) - markerSortKey(y));

    items.push(
      `<asset-clip ref="${assetId}" name="${esc(name)}" start="${timeStr(tb, start)}" duration="${timeStr(tb, totalFrames)}" ` +
        `format="${formatId}" tcFormat="${tc.dropFrame ? 'DF' : 'NDF'}">` +
        (children.length ? `\n        ${children.join('\n        ')}\n      ` : '') +
        `</asset-clip>`,
    );
  }

  const keywords = new Set();
  for (const clip of clips)
    for (const cut of clip.cuts)
      if (cut.enabled !== false && opts.markAs !== 'reject') keywords.add(cut.kind === 'uncertain' ? opts.uncertainKeyword : opts.retakeKeyword);
  for (const k of keywords) items.push(`<keyword-collection name="${esc(k)}"/>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    ${resources.join('\n    ')}
  </resources>
  <event name="${esc(opts.eventName || 'ClipPrep')}">
      ${items.join('\n      ')}
  </event>
</fcpxml>
`;
}

// Order marker-items by their start time (purely cosmetic; the DTD allows any order among them).
function markerSortKey(xml) {
  const m = /start="(\d+)\/(\d+)s"/.exec(xml);
  return m ? Number(m[1]) / Number(m[2]) : 0;
}

module.exports = { buildFcpxml, timecodeFrames, timebase, fcpReadsTimecode };
