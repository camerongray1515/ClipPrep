/* global api */
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
};
const fmt = (t) => {
  if (!Number.isFinite(t)) return '0:00.00';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
const basename = (p) => p.split('/').pop();

const state = {
  clips: [], // { file, status, stage, progress, view, error }
  selected: null,
  settings: null,
  models: [],
  analysing: false,
};

const STAGES = { probe: 'Reading', decode: 'Decoding audio', transcribe: 'Transcribing', proxy: 'Building preview', done: 'Done' };
const MODE_LABELS = { auto: 'Auto', sentence: 'Sentence', tone: 'Tone only', off: 'Off' };

// --- Clip list -------------------------------------------------------------------------------

function addFiles(files) {
  for (const file of files) {
    if (state.clips.some((c) => c.file === file)) continue;
    const c = { file, status: 'pending', progress: 0, camStatus: null };
    state.clips.push(c);
    api.cameraStatus(file).then((s) => {
      c.camStatus = s;
      renderList();
      if (state.selected === file) renderDetail();
    });
  }
  renderList();
  if (!state.selected && state.clips.length) select(state.clips[0].file);
  analyseQueue();
}

// Status flag set on the camera (Sony M01.XML), e.g. KEEP or NG ("not good").
function camBadge(status) {
  if (!status) return null;
  const title = status === 'NG' ? 'Marked NG ("not good") on camera — the whole clip will be rejected on export' : `Marked ${status} on camera`;
  return el('span', { class: `cam-badge ${status.toLowerCase()}`, title }, status);
}

function clip(file) {
  return state.clips.find((c) => c.file === file);
}

function renderList() {
  const list = $('#clip-list');
  list.replaceChildren(
    ...state.clips.map((c) => {
      const meta = [];
      if (c.status === 'ready') {
        const retakes = c.view.cuts.filter((x) => x.kind === 'retake');
        const maybes = c.view.cuts.filter((x) => x.kind === 'uncertain');
        const removed = c.view.cuts.reduce((s, x) => s + x.end - x.start, 0);
        meta.push(el('span', {}, fmt(c.view.info.duration)));
        meta.push(el('span', {}, `${c.view.tones.length} tone${c.view.tones.length === 1 ? '' : 's'}`));
        if (retakes.length) meta.push(el('span', { class: 'cuts' }, `${retakes.length} cut`));
        if (maybes.length) meta.push(el('span', { class: 'maybe' }, `${maybes.length} maybe`));
        if (removed) meta.push(el('span', {}, `−${fmt(removed)}`));
      } else if (c.status === 'error') meta.push(el('span', { class: 'err', title: c.error }, 'Error — click for details'));
      else if (c.status === 'analysing') meta.push(el('span', {}, `${STAGES[c.stage] || 'Working'}…`));
      else if (c.status === 'stale') meta.push(el('span', {}, 'Settings changed — needs re-analysis'));
      else meta.push(el('span', {}, 'Queued'));

      return el(
        'li',
        { class: c.file === state.selected ? 'selected' : '', onclick: () => select(c.file), title: c.file },
        el('div', { class: 'clip-name' }, camBadge(c.camStatus), basename(c.file)),
        el('div', { class: 'clip-meta' }, meta),
        c.status === 'analysing' ? el('div', { class: 'progress' }, el('div', { style: `width:${Math.round(c.progress * 100)}%` })) : null,
        el('button', { class: 'clip-remove', title: 'Remove', onclick: (e) => (e.stopPropagation(), removeClip(c.file)) }, '✕'),
      );
    }),
  );
  $('#clip-count').textContent = state.clips.length ? state.clips.length : '';
  $('#drop-hint').classList.toggle('hidden', state.clips.length > 0);
  $('#btn-export').disabled = !state.clips.some((c) => c.status === 'ready');
}

async function removeClip(file) {
  state.clips = state.clips.filter((c) => c.file !== file);
  await api.removeClip(file);
  if (state.selected === file) select(state.clips[0]?.file || null);
  renderList();
}

async function analyseQueue() {
  if (state.analysing) return;
  state.analysing = true;
  try {
    let next;
    while ((next = state.clips.find((c) => c.status === 'pending' || c.status === 'stale'))) {
      next.status = 'analysing';
      next.progress = 0;
      renderList();
      try {
        next.view = await api.analyze(next.file);
        next.status = 'ready';
      } catch (e) {
        next.status = 'error';
        next.error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
      renderList();
      if (state.selected === next.file) renderDetail();
    }
  } finally {
    state.analysing = false;
  }
}

api.onProgress(({ file, stage, p }) => {
  const c = clip(file);
  if (!c) return;
  c.stage = stage;
  // Weight stages so the bar moves steadily: decode 0–40%, transcribe 40–100%.
  c.progress = stage === 'decode' ? p * 0.4 : stage === 'transcribe' ? 0.4 + p * 0.6 : stage === 'proxy' ? p : c.progress;
  if (stage === 'proxy') showOverlay(`Building preview… ${Math.round(p * 100)}%`);
  renderList();
});

// --- Detail view -----------------------------------------------------------------------------

const video = $('#video');
let skipCuts = false;

function select(file) {
  state.selected = file;
  renderList();
  renderDetail();
}

function renderDetail() {
  const c = clip(state.selected);
  $('#detail').classList.toggle('empty', !c);
  if (!c) {
    video.removeAttribute('src');
    delete video.dataset.file;
    return;
  }
  if (c.status === 'error') {
    $('#detail').classList.add('empty');
    $('.empty-state').textContent = c.error;
    return;
  }
  if (c.status !== 'ready') {
    $('#detail').classList.add('empty');
    $('.empty-state').textContent = 'Analysing… results will appear here.';
    return;
  }
  $('.empty-state').textContent = 'Select a clip to review its cuts.';
  const v = c.view;
  if (video.dataset.file !== c.file) loadVideo(c.file, v);
  const removed = v.cuts.reduce((s, x) => s + x.end - x.start, 0);
  $('#clip-summary').replaceChildren(
    c.camStatus === 'NG' ? el('span', { class: 'ng-note' }, camBadge('NG'), ' Whole clip will be rejected · ') : camBadge(c.camStatus),
    c.camStatus && c.camStatus !== 'NG' ? ' ' : '',
    `${v.info.width}×${v.info.height} · ${v.info.videoCodec} · ${v.cuts.length} cut range${v.cuts.length === 1 ? '' : 's'} · removes ${fmt(removed)}`,
  );
  renderTones(v);
  renderTranscript(v);
  drawTimeline();
}

function loadVideo(file, v) {
  hideOverlay();
  video.dataset.file = file;
  video.src = v.proxyUrl || v.url;
  video.load();
}

video.addEventListener('error', () => {
  const c = clip(state.selected);
  if (!c?.view || c.view.proxyUrl) return showOverlay('This clip could not be played.');
  showOverlay(
    el('div', {}, "This format can't be previewed directly (e.g. 10-bit 4:2:2 or PCM audio in MP4)."),
    el('button', { class: 'btn primary', onclick: () => buildProxy(c) }, 'Create preview proxy'),
    el('div', { class: 'muted' }, 'A small 540p copy is cached for previewing only; export always references the original.'),
  );
});

async function buildProxy(c) {
  showOverlay('Building preview… 0%');
  try {
    c.view.proxyUrl = await api.makeProxy(c.file);
    if (state.selected === c.file) loadVideo(c.file, c.view);
  } catch (e) {
    showOverlay(`Preview failed: ${e.message}`);
  }
}

function showOverlay(...content) {
  const o = $('#video-overlay');
  o.replaceChildren(...content.map((x) => (typeof x === 'string' ? el('div', {}, x) : x)));
  o.classList.remove('hidden');
}
function hideOverlay() {
  $('#video-overlay').classList.add('hidden');
}

function seek(t, play = false) {
  video.currentTime = Math.max(0, t);
  if (play) video.play();
}

function renderTones(v) {
  const box = $('#tones');
  if (!v.details.length) {
    box.replaceChildren(el('div', { class: 'muted' }, 'No cue tones found in this clip.'));
    return;
  }
  box.replaceChildren(
    ...v.details.map((d) => {
      const cut = v.cuts.find((c) => c.tones.includes(d.index));
      const kind = d.mode === 'off' ? 'off' : d.kind;
      const badge = {
        retake: `Repeated phrase · ${Math.round((d.score || 0) * 100)}%`,
        uncertain: 'No repeat found · Maybe',
        tone: 'Tone only',
        off: 'Ignored',
      }[kind];
      const select = el(
        'select',
        {
          title: 'How to cut around this tone',
          onchange: async (e) => {
            const c = clip(state.selected);
            c.view = await api.setOverride(c.file, d.index, e.target.value);
            renderList();
            renderDetail();
          },
        },
        Object.entries(MODE_LABELS).map(([k, label]) => el('option', { value: k, selected: d.mode === k ? '' : null }, label)),
      );
      return el(
        'div',
        { class: 'tone-card', 'data-tone': d.index },
        el(
          'div',
          { class: 'tone-head' },
          el('span', { class: 'tone-time' }, fmt(d.tone.start)),
          el('span', { class: `badge ${kind}` }, badge),
          select,
        ),
        el(
          'div',
          { class: 'tone-text' },
          d.failedText ? el('div', {}, el('span', { class: 'lbl' }, 'Cut'), el('span', { class: 'failed' }, d.failedText)) : null,
          el('div', {}, el('span', { class: 'lbl' }, 'Keep'), d.retakeText ? `${d.retakeText} …` : el('span', { class: 'muted' }, '(nothing transcribed)')),
        ),
        el(
          'div',
          { class: 'tone-actions' },
          cut ? el('span', { class: 'muted' }, `${fmt(cut.start)} → ${fmt(cut.end)}`) : null,
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn small', onclick: () => ((skipCuts = $('#chk-skip').checked = false), seek((cut?.start ?? d.tone.start) - 2, true)) }, 'Play original'),
          cut ? el('button', { class: 'btn small', onclick: () => ((skipCuts = $('#chk-skip').checked = true), seek(cut.start - 3, true)) }, 'Preview edit') : null,
        ),
      );
    }),
  );
}

function renderTranscript(v) {
  const box = $('#transcript');
  const cutKind = (t) => v.cuts.find((c) => t >= c.start && t < c.end)?.kind;
  const paras = [];
  let cur = [];
  let toneIdx = 0;
  const flush = () => cur.length && (paras.push(el('p', {}, cur)), (cur = []));
  for (const [i, w] of v.words.entries()) {
    while (toneIdx < v.tones.length && v.tones[toneIdx].start <= w.start) {
      const tone = v.tones[toneIdx];
      cur.push(el('span', { class: 'tone-pill', onclick: () => seek(tone.start - 1) }, `♪ tone ${fmt(tone.start)}`), ' ');
      flush();
      toneIdx++;
    }
    const kind = cutKind(w.start);
    cur.push(el('span', { class: `w${kind ? ` cut-${kind}` : ''}`, 'data-i': i, onclick: () => seek(w.start - 0.2) }, w.text), ' ');
    // Paragraph break at long pauses.
    if (v.words[i + 1] && v.words[i + 1].start - w.start > 3) flush();
  }
  for (; toneIdx < v.tones.length; toneIdx++) {
    const tone = v.tones[toneIdx];
    cur.push(el('span', { class: 'tone-pill', onclick: () => seek(tone.start - 1) }, `♪ tone ${fmt(tone.start)}`));
  }
  flush();
  box.replaceChildren(...(paras.length ? paras : [el('div', { class: 'muted' }, 'No speech transcribed.')]));
}

// --- Timeline --------------------------------------------------------------------------------

const canvas = $('#timeline');

function drawTimeline() {
  const c = clip(state.selected);
  if (!c?.view) return;
  const v = c.view;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 96;
  if (canvas.width !== w * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const dur = v.info.duration;
  const x = (t) => (t / dur) * w;
  const css = getComputedStyle(document.documentElement);

  // Cut ranges behind the waveform.
  for (const cut of v.cuts) {
    ctx.fillStyle = cut.kind === 'uncertain' ? 'rgba(245,165,36,0.28)' : 'rgba(229,72,77,0.30)';
    ctx.fillRect(x(cut.start), 0, Math.max(1, x(cut.end) - x(cut.start)), h - 10);
  }

  // Waveform from the loudness envelope (dB scaled, peak per pixel column).
  const { hop, rms } = v.envelope;
  const perPx = rms.length / w;
  const mid = (h - 10) / 2;
  ctx.fillStyle = '#7d8590';
  for (let px = 0; px < w; px++) {
    let peak = 0;
    for (let f = Math.floor(px * perPx); f < Math.min(rms.length, (px + 1) * perPx); f++) peak = Math.max(peak, rms[f]);
    const db = 20 * Math.log10(peak + 1e-9);
    const amp = Math.max(0, Math.min(1, (db + 60) / 60));
    ctx.fillRect(px, mid - amp * mid * 0.92, 1, Math.max(1, amp * mid * 1.84));
  }

  // Tones along the bottom.
  ctx.fillStyle = css.getPropertyValue('--tone');
  for (const t of v.tones) ctx.fillRect(x(t.start), h - 7, Math.max(2, x(t.end) - x(t.start)), 6);

  // Playhead.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(x(video.currentTime || 0)), 0, 1.5, h);
  void hop;
}

canvas.addEventListener('click', (e) => {
  const c = clip(state.selected);
  if (!c?.view) return;
  const r = canvas.getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * c.view.info.duration);
});
window.addEventListener('resize', drawTimeline);

// --- Playback loop: playhead, current word, skipping cuts ------------------------------------

let lastWord = null;
function tick() {
  const c = clip(state.selected);
  if (c?.view) {
    const t = video.currentTime;
    if (skipCuts && !video.paused) {
      const cut = c.view.cuts.find((x) => t >= x.start && t < x.end - 0.05);
      if (cut) video.currentTime = cut.end;
    }
    $('#timecode').textContent = fmt(t);
    drawTimeline();
    // Highlight the word being spoken.
    const words = c.view.words;
    let i = -1;
    for (let k = 0; k < words.length && words[k].start <= t; k++) i = k;
    if (i !== lastWord) {
      document.querySelector('.w.now')?.classList.remove('now');
      const span = document.querySelector(`.w[data-i="${i}"]`);
      if (span && !video.paused) {
        span.classList.add('now');
        span.scrollIntoView({ block: 'nearest' });
      }
      lastWord = i;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

video.addEventListener('play', () => ($('#btn-play').textContent = '❚❚'));
video.addEventListener('pause', () => ($('#btn-play').textContent = '▶︎'));
$('#btn-play').addEventListener('click', () => (video.paused ? video.play() : video.pause()));
$('#chk-skip').addEventListener('change', (e) => (skipCuts = e.target.checked));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    video.paused ? video.play() : video.pause();
  }
});

// --- Settings --------------------------------------------------------------------------------

const SETTINGS_SCHEMA = [
  { section: 'Cue tone detection' },
  { key: 'tone.frequency', label: 'Tone frequency (Hz)', type: 'number', min: 100, max: 7000, step: 10 },
  { key: 'tone.threshold', label: 'Tone purity', type: 'number', min: 0.1, max: 0.99, step: 0.05, help: 'Fraction of the sound that must be at the tone frequency. Lower if tones are missed; raise if speech is mistaken for a tone.' },
  { key: 'tone.minDuration', label: 'Minimum tone length (s)', type: 'number', min: 0.1, max: 5, step: 0.1 },
  { key: 'audioTrack', label: 'Audio track', type: 'select', options: [['mix', 'Mix all tracks'], ['0', 'Track 1'], ['1', 'Track 2'], ['2', 'Track 3'], ['3', 'Track 4']] },

  { section: 'Transcription' },
  { key: 'transcription.model', label: 'Whisper model', type: 'model' },
  { key: 'transcription.language', label: 'Language', type: 'text', help: 'Two-letter code. English-only (.en) models ignore this.' },
  { key: 'transcription.whisperPath', label: 'whisper-cli path', type: 'text', help: 'Leave blank to find it automatically (bundled copy, Homebrew or PATH).' },

  { section: 'Repeated-phrase matching' },
  { key: 'matching.compareWords', label: 'Words to compare', type: 'number', min: 2, max: 20, step: 1, help: 'How many words from the start of the retake are compared against the take before the tone.' },
  { key: 'matching.minMatchedWords', label: 'Minimum matching words', type: 'number', min: 1, max: 10, step: 1 },
  { key: 'matching.phraseSimilarity', label: 'Phrase similarity', type: 'number', min: 0.1, max: 1, step: 0.05, help: 'Fraction of compared words that must match (1 = identical wording).' },
  { key: 'matching.wordSimilarity', label: 'Word similarity', type: 'number', min: 0.3, max: 1, step: 0.05, help: 'How close two words must be to count as the same, allowing for transcription differences ("Echomuse" vs "EchoMuse", "brick" vs "bricks").' },
  { key: 'matching.anchorSlack', label: 'Extra leading words allowed', type: 'number', min: 0, max: 3, step: 1, help: 'The retake may start with this many extra words before the repeated phrase ("So, the quick…" vs "The quick…").' },
  { key: 'matching.lookbackSeconds', label: 'Look back (s)', type: 'number', min: 5, max: 600, step: 5, help: 'How far before a tone to search for the start of the failed take.' },
  { key: 'matching.ignoreWords', label: 'Ignore words', type: 'text', wide: true, help: 'Filler words skipped when comparing.' },

  { section: 'Cut placement' },
  { key: 'cuts.fallback', label: 'When no repeat is found', type: 'select', options: [['sentence', 'Cut back to the interrupted sentence (Maybe Cut)'], ['tone', 'Only cut the tone']] },
  { key: 'cuts.fallbackPause', label: 'Pause counts as sentence break (s)', type: 'number', min: 0.2, max: 5, step: 0.1 },
  { key: 'cuts.padBefore', label: 'Air kept before a cut (s)', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'cuts.padAfter', label: 'Air kept before retake (s)', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'cuts.silenceDb', label: 'Speech threshold (dB above noise)', type: 'number', min: 3, max: 40, step: 1, help: 'Used to snap cut points into the silence between words.' },

  { section: 'Export' },
  { key: 'export.markAs', label: 'Mark cuts as', type: 'select', options: [['keyword', 'Keyword ranges'], ['reject', 'Rejected ranges'], ['both', 'Keywords + rejected']] },
  { key: 'export.retakeKeyword', label: 'Keyword for confident cuts', type: 'text' },
  { key: 'export.uncertainKeyword', label: 'Keyword for maybe cuts', type: 'text' },
  { key: 'export.addToneMarkers', label: 'Add a marker at each tone', type: 'checkbox' },
  { key: 'export.timecode', label: 'Clip start timecode', type: 'select', options: [['auto', 'Match Final Cut (recommended)'], ['source', 'Always use embedded timecode'], ['zero', 'Always start at 0']], help: 'Must match how Final Cut reads each file, or the keyword ranges fall outside the clip and are dropped. When importing XML, Final Cut ignores the camera timecode of Sony XAVC MP4s (even with their M01.XML files) and starts them at 0.' },
  { key: 'export.eventName', label: 'Event name', type: 'text' },
];

const getPath = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, key, val) {
  const parts = key.split('.');
  const last = parts.pop();
  parts.reduce((o, k) => (o[k] ??= {}), obj)[last] = val;
}

let settingsTimer = null;
function onSettingChange(key, value) {
  setPath(state.settings, key, value);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(saveSettings, 300);
}

async function saveSettings() {
  const { settings, needsReanalysis } = await api.setSettings(state.settings);
  state.settings = settings;
  for (const c of state.clips) {
    if (c.status !== 'ready') continue;
    if (needsReanalysis) c.status = 'stale';
    else c.view = await api.view(c.file);
  }
  renderList();
  renderDetail();
  if (needsReanalysis) analyseQueue();
}

async function renderSettings() {
  const body = $('#settings-body');
  const status = await api.engineStatus();
  const nodes = [];
  for (const f of SETTINGS_SCHEMA) {
    if (f.section) {
      nodes.push(el('h3', {}, f.section));
      continue;
    }
    const val = getPath(state.settings, f.key);
    let input;
    if (f.type === 'select') {
      input = el('select', { onchange: (e) => onSettingChange(f.key, e.target.value) }, f.options.map(([v, l]) => el('option', { value: v, selected: String(val) === v ? '' : null }, l)));
    } else if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox', checked: val ? '' : null, onchange: (e) => onSettingChange(f.key, e.target.checked) });
    } else if (f.type === 'model') {
      input = el('select', { onchange: (e) => onSettingChange(f.key, e.target.value) }, status.models.map((m) => el('option', { value: m.file, selected: val === m.file ? '' : null }, `${m.label}${m.installed ? '' : ' (not downloaded)'}`)));
    } else {
      input = el('input', {
        type: f.type,
        value: val ?? '',
        min: f.min, max: f.max, step: f.step,
        onchange: (e) => onSettingChange(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value),
      });
    }
    nodes.push(el('div', { class: `field${f.wide || f.type === 'model' ? ' wide' : ''}` }, el('label', {}, f.label), input, f.help ? el('div', { class: 'help' }, f.help) : null));
    if (f.type === 'model') {
      nodes.push(
        el('div', { class: 'field wide' },
          el('div', { class: 'help' }, `whisper-cli: ${status.whisper || `not found — install with: ${status.installHint}`}`),
          ...status.models.map((m) =>
            el('div', { class: 'model-row' },
              el('span', { class: 'name' }, m.label),
              m.installed ? el('span', { class: 'ok' }, '✓ Installed') : el('button', { class: 'btn small', onclick: (e) => downloadModel(m.file, e.target) }, 'Download'),
            ),
          ),
        ),
      );
    }
  }
  body.replaceChildren(...nodes);
}

async function downloadModel(file, button) {
  button.disabled = true;
  const off = api.onModelProgress(({ file: f, p }) => f === file && (button.textContent = `${Math.round(p * 100)}%`));
  try {
    await api.downloadModel(file);
    toast(`Downloaded ${file}`);
  } catch (e) {
    toast(`Download failed: ${e.message}`, true);
  } finally {
    off();
    renderSettings();
    checkEngine();
  }
}

async function checkEngine() {
  const s = await api.engineStatus();
  const banner = $('#engine-banner');
  const model = s.models.find((m) => m.file === state.settings.transcription.model);
  const problems = [];
  if (!s.whisper) problems.push(el('span', {}, 'whisper.cpp is not installed. Run ', el('code', {}, s.installHint), ' then restart ClipPrep.'));
  if (!model?.installed)
    problems.push(el('span', {}, `The transcription model (${model?.label || state.settings.transcription.model}) isn't downloaded yet.`),
      el('button', { class: 'btn small', onclick: (e) => downloadModel(state.settings.transcription.model, e.target) }, 'Download now'));
  banner.replaceChildren(...problems);
  banner.classList.toggle('hidden', !problems.length);
}

$('#btn-settings').addEventListener('click', () => {
  $('#settings').classList.toggle('hidden');
  if (!$('#settings').classList.contains('hidden')) renderSettings();
});
$('#btn-close-settings').addEventListener('click', () => $('#settings').classList.add('hidden'));

// --- Toolbar, drag & drop, export ------------------------------------------------------------

function toast(content, error = false, ms = 5000) {
  const t = $('#toast');
  t.replaceChildren(...(Array.isArray(content) ? content : [content]));
  t.classList.toggle('error', error);
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

$('#btn-add').addEventListener('click', async () => addFiles(await api.pickFiles()));
$('#btn-analyze').addEventListener('click', () => {
  for (const c of state.clips) if (c.status === 'error') c.status = 'pending';
  analyseQueue();
});
$('#btn-export').addEventListener('click', async () => {
  const files = state.clips.filter((c) => c.status === 'ready').map((c) => c.file);
  const pending = state.clips.length - files.length;
  const r = await api.exportFcpxml(files, $('#chk-open-fcp').checked);
  if (r.ok)
    toast([
      el('span', {}, `Exported ${files.length} clip${files.length === 1 ? '' : 's'}${pending ? ` (${pending} not yet analysed were skipped)` : ''}.`),
      el('button', { class: 'btn small', onclick: () => api.reveal(r.path) }, 'Show in Finder'),
    ], false, 8000);
  else if (r.error) toast(r.error, true);
});

const VIDEO_EXT = /\.(mp4|mov|m4v|mxf)$/i;
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter((p) => VIDEO_EXT.test(p));
  if (files.length) addFiles(files);
});

(async () => {
  const { settings } = await api.getSettings();
  state.settings = settings;
  renderList();
  checkEngine();
})();
