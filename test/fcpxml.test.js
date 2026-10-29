const test = require('node:test');
const assert = require('node:assert');
const { buildFcpxml, fcpReadsTimecode } = require('../src/core/fcpxml');
const { withDefaults } = require('../src/core/settings');

const sony = {
  width: 3840, height: 2160, frameRate: { num: 30000, den: 1001 }, duration: 22.5225, nbFrames: 675,
  timecode: '11:03:08:24', timecodeSource: 'rtmd', sidecar: null,
  audioTracks: [{ index: 0, channels: 1, sampleRate: 48000 }],
};

test('Sony XAVC clips start at 0, with or without their M01.XML sidecar', () => {
  assert.equal(fcpReadsTimecode(sony), false);
  assert.equal(fcpReadsTimecode({ ...sony, timecode: '06:12:26;10', timecodeSource: 'sidecar' }), false);
  assert.equal(fcpReadsTimecode({ ...sony, timecodeSource: 'tmcd' }), true);
  assert.equal(fcpReadsTimecode(sony, 'source'), true);
  assert.equal(fcpReadsTimecode({ ...sony, timecodeSource: 'tmcd' }, 'zero'), false);
});

test('keyword ranges sit inside the clip range Final Cut will see', () => {
  const xml = buildFcpxml(
    [{ file: '/media/CLIP.mp4', analysis: { info: sony, tones: [{ start: 5, end: 6 }] }, cuts: [{ start: 2, end: 7, kind: 'retake' }] }],
    withDefaults().export,
  );
  assert.match(xml, /<asset-clip [^>]*start="0s" duration="675675\/30000s"/);
  assert.match(xml, /<keyword start="60060\/30000s" duration="149149\/30000s" value="Retake Cut"\/>/);
  assert.match(xml, /<keyword-collection name="Retake Cut"\/>/);
  assert.match(xml, /name="FFVideoFormat3840x2160p2997"/);
});

test("'source' timecode mode uses the sidecar's drop-frame timecode", () => {
  // GARAGE7452 from an NX800 card; matches the start Final Cut wrote for it after a card import.
  const info = { ...sony, timecode: '06:12:26;10', timecodeSource: 'sidecar' };
  const opts = { ...withDefaults().export, timecode: 'source' };
  const xml = buildFcpxml([{ file: '/m/GARAGE7452.MP4', analysis: { info, tones: [] }, cuts: [] }], opts);
  assert.match(xml, /<asset-clip [^>]*start="670389720\/30000s"[^>]*tcFormat="DF"/);
  const auto = buildFcpxml([{ file: '/m/GARAGE7452.MP4', analysis: { info, tones: [] }, cuts: [] }], withDefaults().export);
  assert.match(auto, /<asset-clip [^>]*start="0s"/);
});

test('clips flagged NG on camera are rejected in their entirety', () => {
  const info = { ...sony, clipStatus: 'NG' };
  const xml = buildFcpxml([{ file: '/m/CLIP.MP4', analysis: { info, tones: [] }, cuts: [] }], withDefaults().export);
  assert.match(xml, /<rating start="0s" duration="675675\/30000s" value="reject" note="Marked NG on camera"\/>/);
  const keep = buildFcpxml([{ file: '/m/CLIP.MP4', analysis: { info: { ...sony, clipStatus: 'KEEP' }, tones: [] }, cuts: [] }], withDefaults().export);
  assert.doesNotMatch(keep, /<rating/);
});

test('only settings changed from their defaults are saved', () => {
  const { withDefaults, changedFromDefaults } = require('../src/core/settings');
  const s = withDefaults({ matching: { phraseSimilarity: 0.8 }, audioTrack: '1' });
  assert.deepEqual(changedFromDefaults(s), { audioTrack: '1', matching: { phraseSimilarity: 0.8 } });
  assert.equal(withDefaults(changedFromDefaults(s)).matching.compareWords, 8);
});
