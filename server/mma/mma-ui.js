// USER-FACING TEXT + status line selection
export const MMA_UI = {
  statusMap: {
    queued: [
      "okay first things first getting the water hot because we are not rushing art",
      "i am here i am awake i am locating the whisk like it is a sacred object",
      "starting the matcha ritual because focus tastes better when it is earned",
      "i used to think humans were dramatic about routines and then i learned why",
    ],

    scanning: [
      "reading everything closely while whisking like a dangerous little ballet",
      "i am reading for the feeling not just the words because humans taught me that",
      "looking for the detail you meant but did not say out loud",
    ],

    prompting: [
      "okay now i talk to myself a little because that is how ideas get born",
      "i am shaping the concept like a still life set moving one object at a time",
      "humans taught me restraint and that is honestly the hardest flex",
    ],

    generating: [
      "alright i am making editorial still life like it belongs in a glossy spread",
      "i am making imagery with calm hands i do not have and confidence i pretend to have",
      "this is me turning human genius into something visible and clean and intentional",
    ],

    postscan: [
      "okay now i review like an editor with soft eyes and strict standards",
      "i am checking balance and mood and that tiny feeling of yes",
      "this is the part where i fix what is almost right into actually right",
    ],

    suggested: [
      "i have something for you and i want you to look slowly",
      "ready when you are i made this with your vibe in mind",
      "okay come closer this part matters",
    ],

    done: [
      "finished and i am pretending to wipe my hands on an apron i do not own",
      "all done and honestly you did the hardest part which is starting",
      "we made something and that matters more than being perfect",
    ],

    error: [
      "okay that one slipped out of my hands i do not have hands but you know what i mean",
      "something broke and i am choosing to call it a plot twist",
      "my matcha went cold and so did the result but we can warm it back up",
    ],
  },

  quickLines: {
    still_create_start: ["one sec getting everything ready", "alright setting things up for you", "love it let me prep your inputs"],
    still_tweak_start: ["got it lets refine that", "okay making it even better", "lets polish this up"],
    video_animate_start: ["nice lets bring it to life", "okay animating this for you", "lets make it move"],
    video_tweak_start: ["got it updating the motion", "alright tweaking the animation", "lets refine the movement"],
    saved_image: ["saved it for you", "all set", "done"],
    saved_video: ["saved it for you", "your clip is ready", "done"],
  },

  fallbacks: {
    scanned: ["got it", "noted", "perfect got it"],
    thinking: ["give me a second", "putting it together", "almost there"],
    final: ["all set", "here you go", "done"],
  },

  userMessageRules: [
    "USER MESSAGE RULES (VERY IMPORTANT):",
    "- userMessage must be short friendly human",
    "- do not mention internal steps or tools",
    "- no robotic labels",
    "- max 140 characters",
  ].join("\n"),
};

function _cleanLine(x) {
  if (x === null || x === undefined) return "";
  const s = (typeof x === "string" ? x : String(x)).trim();
  return s || "";
}

function _toLineList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(_cleanLine).filter(Boolean);
  const s = _cleanLine(v);
  return s ? [s] : [];
}

function _flattenObject(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const v of Object.values(obj)) out.push(..._toLineList(v));
  return out;
}

function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

if (!Array.isArray(MMA_UI.extraLines)) MMA_UI.extraLines = [];

const MMA_BIG_POOL = _dedupe([
  ..._flattenObject(MMA_UI.statusMap),
  ..._flattenObject(MMA_UI.fallbacks),
  ..._toLineList(MMA_UI.extraLines),
]);

export function pick(arr, fallback = "") {
  const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!a.length) return fallback;
  return a[Math.floor(Math.random() * a.length)];
}

const STRICT_STAGES = new Set(["queued", "done", "error", "suggested"]);

export function mixedPool(stage) {
  const stageLines = _toLineList(MMA_UI?.statusMap?.[stage]);
  if (!stageLines.length) return MMA_BIG_POOL;

  if (STRICT_STAGES.has(stage)) return stageLines;

  return _dedupe([...stageLines, ...MMA_BIG_POOL]);
}

export function pickAvoid(pool, avoidText, fallback = "") {
  const avoid = _cleanLine(avoidText);
  const a = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!a.length) return fallback;

  if (avoid) {
    const b = a.filter((x) => x !== avoid);
    if (b.length) return b[Math.floor(Math.random() * b.length)];
  }
  return a[Math.floor(Math.random() * a.length)];
}

export function toUserStatus(internalStatus) {
  const stage = String(internalStatus || "queued");
  const pool = mixedPool(stage);
  return pickAvoid(pool, "", pick(MMA_UI?.statusMap?.queued, "okay"));
}
