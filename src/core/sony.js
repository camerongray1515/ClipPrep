// Sony XDCAM/XAVC "NonRealTimeMeta" sidecars (CLIPNAMEM01.XML) written by cameras such as the
// HXR-NX800. Final Cut takes the clip's timecode from here, and the camera stores clip flags
// (e.g. KEEP / NG) on the TargetMaterial element.
const fs = require('fs');
const path = require('path');

function sidecarPath(file) {
  const { dir, name } = path.parse(file);
  for (const ext of ['XML', 'xml']) {
    const p = path.join(dir, `${name}M01.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// LtcChange values are SMPTE timecode bytes, frames first: "61545602" → 02:56:54;21.
// Bit 0x40 of the frames byte is the drop-frame flag; the top bits of each byte are flags too.
function decodeLtc(value) {
  if (!/^[0-9a-fA-F]{8}$/.test(value || '')) return null;
  const b = value.match(/../g).map((h) => parseInt(h, 16));
  const bcd = (x) => (x >> 4) * 10 + (x & 0x0f);
  const dropFrame = (b[0] & 0x40) !== 0;
  const [ff, ss, mm, hh] = [bcd(b[0] & 0x3f), bcd(b[1] & 0x7f), bcd(b[2] & 0x7f), bcd(b[3] & 0x3f)];
  const p = (n) => String(n).padStart(2, '0');
  return { timecode: `${p(hh)}:${p(mm)}:${p(ss)}${dropFrame ? ';' : ':'}${p(ff)}`, dropFrame };
}

const attr = (xml, tag, name) => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
};

function readSidecar(file) {
  const p = sidecarPath(file);
  if (!p) return null;
  let xml;
  try {
    xml = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  if (!xml.includes('NonRealTimeMeta')) return null;
  const startLtc = /<LtcChange\b[^>]*\bframeCount="0"[^>]*\bvalue="([^"]*)"/.exec(xml)?.[1];
  const ltc = decodeLtc(startLtc);
  const status = attr(xml, 'TargetMaterial', 'status');
  return {
    path: p,
    status: status ? status.toUpperCase() : null, // e.g. 'KEEP', 'NG'
    timecode: ltc?.timecode || null,
    dropFrame: ltc?.dropFrame || false,
    model: attr(xml, 'Device', 'modelName'),
  };
}

module.exports = { readSidecar, decodeLtc, sidecarPath };
