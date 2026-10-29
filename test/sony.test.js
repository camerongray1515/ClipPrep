const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSidecar, decodeLtc } = require('../src/core/sony');

test('decodes Sony LTC values, including the drop-frame flag', () => {
  assert.deepEqual(decodeLtc('61545602'), { timecode: '02:56:54;21', dropFrame: true });
  assert.deepEqual(decodeLtc('10261206'), { timecode: '06:12:26:10', dropFrame: false });
  assert.equal(decodeLtc('bogus'), null);
});

test('reads clip status and timecode from an M01.XML sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sony-'));
  const xml = (status) => `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20">
	<TargetMaterial umidRef="060A2B34"${status ? ` status="${status}"` : ''}/>
	<LtcChangeTable tcFps="30" halfStep="false">
		<LtcChange frameCount="0" value="52201306" status="increment"/>
		<LtcChange frameCount="404" value="66331306" status="end"/>
	</LtcChangeTable>
	<Device manufacturer="Sony" modelName="HXR-NX800" serialNo="1"/>
</NonRealTimeMeta>`;
  fs.writeFileSync(path.join(dir, 'A0001M01.XML'), xml('NG'));
  fs.writeFileSync(path.join(dir, 'A0002M01.XML'), xml(null));
  const a = readSidecar(path.join(dir, 'A0001.MP4'));
  assert.equal(a.status, 'NG');
  assert.equal(a.timecode, '06:13:20;12');
  assert.equal(a.model, 'HXR-NX800');
  assert.equal(readSidecar(path.join(dir, 'A0002.MP4')).status, null);
  assert.equal(readSidecar(path.join(dir, 'A0003.MP4')), null);
});
