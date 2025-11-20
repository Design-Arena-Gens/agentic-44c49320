// Simple peekaboo cartoon renderer and WebAudio + MediaRecorder pipeline

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;
const subtitlesEl = document.getElementById("subtitles");
const startBtn = document.getElementById("startBtn");
const recordBtn = document.getElementById("recordBtn");
const downloadBtn = document.getElementById("downloadBtn");
const output = document.getElementById("output");
const preview = document.getElementById("preview");

// Timeline constants (ms)
const FPS = 30;
const MS_PER_FRAME = 1000 / FPS;
const SONG_BPM = 96;
const BEAT_MS = (60_000 / SONG_BPM);

// Lyric cues for "Johny Johny Yes Papa"
const cues = [
  { t: 0, text: "Peekaboo!" },
  { t: 2 * BEAT_MS, text: "" },
  { t: 4 * BEAT_MS, text: "Johny, Johny," },
  { t: 8 * BEAT_MS, text: "Yes, Papa?" },
  { t: 12 * BEAT_MS, text: "Eating sugar?" },
  { t: 16 * BEAT_MS, text: "No, Papa." },
  { t: 20 * BEAT_MS, text: "Telling lies?" },
  { t: 24 * BEAT_MS, text: "No, Papa." },
  { t: 28 * BEAT_MS, text: "Open your mouth!" },
  { t: 32 * BEAT_MS, text: "Ha Ha Ha!" },
];

// Melody notes (C major pentatonic-ish) for each 2-beat chunk
// Frequency helper for note names (A4=440)
const NOTE_FREQ = {
  C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.00, A4: 440.00,
  C5: 523.25, D5: 587.33, E5: 659.26, G5: 783.99
};
const melody = [
  // intro peekaboo flourish (2 beats)
  { len: 0.5, f: "C4" }, { len: 0.5, f: "E4" }, { len: 0.5, f: "G4" }, { len: 0.5, f: "C5" },
  // Johny, Johny (4 beats)
  { len: 1, f: "C4" }, { len: 1, f: "E4" },
  // Yes, Papa? (4 beats)
  { len: 1, f: "D4" }, { len: 1, f: "G4" },
  // Eating sugar? (4 beats)
  { len: 1, f: "E4" }, { len: 1, f: "G4" },
  // No, Papa. (4 beats)
  { len: 1, f: "D4" }, { len: 1, f: "C4" },
  // Telling lies? (4 beats)
  { len: 1, f: "E4" }, { len: 1, f: "G4" },
  // No, Papa. (4 beats)
  { len: 1, f: "D4" }, { len: 1, f: "C4" },
  // Open your mouth! (4 beats)
  { len: 1, f: "G4" }, { len: 1, f: "C5" },
  // Ha Ha Ha! (4 beats)
  { len: 0.66, f: "C5" }, { len: 0.66, f: "A4" }, { len: 0.66, f: "G4" },
];

// Animation state
let startTime = null;
let rafId = null;
let running = false;
let songEnded = false;

// Character state
const character = {
  x: W / 2,
  y: H * 0.58,
  scale: 1,
  armCover: 0, // 0 open, 1 fully covering eyes
  mouthOpen: 0, // 0 closed, 1 wide
  blink: 0, // 0 open, 1 closed
  vibe: 0, // small bob
};

// Audio context and nodes
let audioCtx;
let masterGain;
let musicGain;
let clickGain;
let mediaStreamDest; // for recording mix

function setupAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.8;

  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.35;

  clickGain = audioCtx.createGain();
  clickGain.gain.value = 0.0; // hidden click track

  mediaStreamDest = audioCtx.createMediaStreamDestination();

  musicGain.connect(masterGain);
  clickGain.connect(masterGain);
  masterGain.connect(mediaStreamDest);
  masterGain.connect(audioCtx.destination);
}

function playToneAt(time, freq, duration, type = "triangle") {
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(env);
  env.connect(musicGain);
  // quick attack/release
  const a = 0.01, r = 0.12;
  env.gain.setValueAtTime(0.0001, time);
  env.gain.exponentialRampToValueAtTime(1.0, time + a);
  env.gain.exponentialRampToValueAtTime(0.0001, time + duration - r);
  osc.start(time);
  osc.stop(time + duration);
}

function scheduleMelody() {
  const base = audioCtx.currentTime + 0.15;
  let t = base;
  const beat = BEAT_MS / 1000;
  melody.forEach(note => {
    const freq = NOTE_FREQ[note.f] || 440;
    const dur = Math.max(0.18, note.len * beat * 0.9);
    playToneAt(t, freq, dur);
    t += note.len * beat;
  });
  // return approximate end time
  return t + 0.2;
}

function updateSubtitles(elapsedMs) {
  // Find latest cue whose time <= elapsedMs
  let current = "";
  for (let i = 0; i < cues.length; i++) {
    if (elapsedMs >= cues[i].t) current = cues[i].text;
  }
  subtitlesEl.textContent = current;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function drawCharacter(t) {
  ctx.save();
  // ground
  ctx.fillStyle = "#a7f3d0";
  ctx.fillRect(0, H * 0.7, W, H * 0.3);
  // sun
  ctx.beginPath();
  ctx.fillStyle = "#fde68a";
  ctx.arc(W * 0.85, H * 0.18, 60, 0, Math.PI * 2);
  ctx.fill();

  // bobbing vibe
  const vibe = Math.sin(t / 500) * 6;
  character.vibe = vibe;

  const cx = character.x;
  const cy = character.y + vibe;

  // body
  ctx.fillStyle = "#60a5fa";
  ctx.beginPath();
  ctx.roundRect(cx - 150, cy - 120, 300, 260, 40);
  ctx.fill();

  // head
  ctx.fillStyle = "#fde68a";
  ctx.beginPath();
  ctx.arc(cx, cy - 220, 120, 0, Math.PI * 2);
  ctx.fill();

  // hair tuft
  ctx.strokeStyle = "#78350f";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx - 40, cy - 320);
  ctx.quadraticCurveTo(cx - 10, cy - 360, cx + 20, cy - 320);
  ctx.stroke();

  // eyes
  const blink = character.blink;
  ctx.fillStyle = "#111827";
  // left eye
  ctx.save();
  ctx.translate(cx - 45, cy - 230);
  if (blink > 0.5) {
    ctx.fillRect(-16, -2, 32, 4);
  } else {
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(-4, -4, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // right eye
  ctx.save();
  ctx.translate(cx + 45, cy - 230);
  ctx.fillStyle = "#111827";
  if (blink > 0.5) {
    ctx.fillRect(-16, -2, 32, 4);
  } else {
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(-4, -4, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // mouth
  const mouth = character.mouthOpen;
  ctx.fillStyle = "#b91c1c";
  ctx.beginPath();
  const mw = 90;
  const mh = 12 + mouth * 48;
  ctx.roundRect(cx - mw / 2, cy - 170, mw, mh, 8);
  ctx.fill();
  // tongue
  if (mouth > 0.3) {
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.roundRect(cx - mw / 2 + 12, cy - 170 + mh / 2, mw - 24, Math.max(8, mh / 2 - 6), 6);
    ctx.fill();
  }

  // hands/arms
  // arms anchor
  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 20;
  ctx.lineCap = "round";
  ctx.beginPath();
  // left arm
  ctx.moveTo(cx - 120, cy - 80);
  ctx.quadraticCurveTo(cx - 240, cy - 160, cx - 40, cy - 220 + character.armCover * -10);
  // right arm
  ctx.moveTo(cx + 120, cy - 80);
  ctx.quadraticCurveTo(cx + 240, cy - 160, cx + 40, cy - 220 + character.armCover * -10);
  ctx.stroke();

  // hands
  ctx.fillStyle = "#fde68a";
  const cover = character.armCover; // 0 to 1
  // left hand
  ctx.beginPath();
  ctx.roundRect(cx - 90, cy - 260 + cover * 40, 70, 60, 16);
  ctx.fill();
  // right hand
  ctx.beginPath();
  ctx.roundRect(cx + 20, cy - 260 + cover * 40, 70, 60, 16);
  ctx.fill();

  // cheeks
  ctx.fillStyle = "rgba(236, 72, 153, 0.25)";
  ctx.beginPath();
  ctx.ellipse(cx - 70, cy - 190, 22, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + 70, cy - 190, 22, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function updateCharacter(elapsedMs) {
  // blink every ~3s randomly
  const blinkPhase = (elapsedMs % 3100) / 3100;
  character.blink = blinkPhase > 0.93 ? 1 : 0;

  // timeline:
  // 0-2 beats: peekaboo cover
  // then rhythmic mouth animation while "singing"
  const beat = BEAT_MS;
  if (elapsedMs < 2 * beat) {
    const p = easeInOut(Math.min(1, elapsedMs / (2 * beat)));
    character.armCover = 1 - p; // start covered then reveal
    character.mouthOpen = 0.2 * (1 - p);
  } else {
    character.armCover = 0;
    // mouth follows eighth-note pulses
    const eighth = beat / 2;
    const phase = (elapsedMs % (2 * eighth)) / (2 * eighth); // 0..1
    character.mouthOpen = 0.25 + 0.55 * (phase < 0.5 ? easeInOut(phase * 2) : 1 - easeInOut((phase - 0.5) * 2));
  }
}

function renderLoop(ts) {
  if (!running) return;
  if (startTime == null) startTime = ts;
  const elapsedMs = ts - startTime;
  ctx.clearRect(0, 0, W, H);
  updateCharacter(elapsedMs);
  drawCharacter(elapsedMs);
  updateSubtitles(elapsedMs);
  if (!songEnded && elapsedMs > 36 * BEAT_MS) {
    songEnded = true;
    recordBtn.disabled = false;
  }
  rafId = requestAnimationFrame(renderLoop);
}

// Recording
let recorder;
let recordedChunks = [];

function combineCanvasAndAudio() {
  const canvasStream = canvas.captureStream(FPS);
  const audioStream = mediaStreamDest.stream;
  const out = new MediaStream();
  canvasStream.getVideoTracks().forEach(t => out.addTrack(t));
  audioStream.getAudioTracks().forEach(t => out.addTrack(t));
  return out;
}

async function startPerformance() {
  if (!audioCtx) setupAudio();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  // reset animation
  running = true;
  songEnded = false;
  startTime = null;
  recordBtn.disabled = true;
  downloadBtn.disabled = true;
  output.hidden = true;
  subtitlesEl.textContent = "";
  cancelAnimationFrame(rafId);
  scheduleMelody();
  rafId = requestAnimationFrame(renderLoop);
}

function startRecording() {
  const stream = combineCanvasAndAudio();
  recordedChunks = [];
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 128_000 });
  } catch {
    alert("MediaRecorder not supported in this browser.");
    return;
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: recorder.mimeType });
    const url = URL.createObjectURL(blob);
    preview.src = url;
    preview.onloadedmetadata = () => {
      output.hidden = false;
      downloadBtn.disabled = false;
    };
    downloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = "peekaboo-johny-johny.webm";
      a.click();
    };
  };
  // Record a full performance from scratch for clean audio/video
  startPerformance().then(() => {
    // small delay to ensure initial frames
    setTimeout(() => {
      recorder.start();
      // stop after ~40 beats safety
      const durationMs = 40 * BEAT_MS;
      setTimeout(() => {
        recorder.stop();
      }, durationMs + 250);
    }, 120);
  });
}

// Wire up UI
startBtn.addEventListener("click", startPerformance);
recordBtn.addEventListener("click", startRecording);

// Accessibility: keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "p") startPerformance();
  if (e.key.toLowerCase() === "r") {
    if (!recordBtn.disabled) startRecording();
  }
});

