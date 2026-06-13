import { useState, useEffect, useMemo, useRef } from "react";
import {
  Inbox, Zap, FolderKanban, Hourglass, Moon, BookOpen, Repeat,
  CheckCircle2, Plus, Trash2, Calendar, ChevronRight, ChevronDown,
  Check, X, Download, Upload, RotateCcw, Flame, Sparkles, ArrowRight,
  AlertTriangle, Sun, ListChecks, Send, Clipboard, Filter, Pencil, Settings2,
  Archive, Lock, Link2, Compass, Mountain, Target, Radar, ShoppingBag, Skull, Crosshair, Shield, Menu
} from "lucide-react";
import { syncEnabled } from "./supabaseClient.js";
import { getSession, signInWithGoogle, signOut, onAuthChange, cloudLoad, cloudSave, subscribeRealtime } from "./cloudSync.js";

/* ============================================================================
   STORAGE SEAM
   Everything persistent goes through `store`. To export this app to a standalone
   build later, replace the two functions below (e.g. localStorage, IndexedDB,
   or a REST/Supabase backend). Nothing else in the app touches storage directly.
============================================================================ */
const KEYS = {
  items: "gtd:items",
  projects: "gtd:projects",
  habits: "gtd:habits",
  log: "gtd:habitlog",
  settings: "gtd:settings",
  areas: "gtd:areas",
  horizons: "gtd:horizons",
  game: "gtd:game",
  meta: "gtd:meta",
};
const hasSandbox = typeof window !== "undefined" && window.storage;
const hasLocal = (() => {
  try { return typeof window !== "undefined" && !!window.localStorage; } catch (e) { return false; }
})();
const mem = {};
// Storage seam. Standalone (GitHub Pages / PWA) uses localStorage, which the browser
// writes to disk and keeps across tab-close, app-quit, and device restart. The sandbox
// branch keeps this same file working inside Claude; mem is the last-resort fallback.
const store = {
  async load(key, fallback) {
    try {
      if (hasLocal) {
        const r = window.localStorage.getItem(key);
        return r != null ? JSON.parse(r) : fallback;
      }
      if (hasSandbox) {
        const r = await window.storage.get(key);
        return r ? JSON.parse(r.value) : fallback;
      }
      return key in mem ? mem[key] : fallback;
    } catch (e) {
      return fallback;
    }
  },
  async save(key, value) {
    try {
      if (hasLocal) window.localStorage.setItem(key, JSON.stringify(value));
      else if (hasSandbox) await window.storage.set(key, JSON.stringify(value));
      else mem[key] = value;
    } catch (e) {
      console.error("save failed", key, e);
    }
  },
};

/* ============================================================================
   VERSIONING & MIGRATIONS
   APP_VERSION is the single monotonic spine. On load we compare it to the version
   recorded in the user's saved meta:
     - no meta            → brand-new user → Welcome onboarding
     - meta.version < APP → returning user → run pending migrations, then "What's New"
     - meta.version == APP→ up to date     → straight into the app
   Each entry in MIGRATIONS optionally carries a `migrate(all)` that reshapes stored
   data, and a `notes` array shown in the changelog. To ship a change: bump APP_VERSION,
   add a MIGRATIONS entry. Adding fields needs no migration (read with a fallback);
   only renames/shape-changes do.
============================================================================ */
const APP_VERSION = 12;

// Keyed by the version they were INTRODUCED in. `all` is { items, projects, habits, log,
// settings, areas, horizons, game } — return the same shape (mutated copies are fine).
const MIGRATIONS = {
  4: {
    notes: [
      "Personalized welcome — Clearmind now greets you by name.",
      "Seed your Goals, Vision & Purpose during onboarding.",
      "Added a versioned upgrade system so future updates never disturb your saved progress.",
    ],
    migrate: (all) => {
      const game = all.game || {};
      if (!Array.isArray(game.ownedGear)) game.ownedGear = ["skin-default", "avatar-drifter"];
      if (!game.equipped) game.equipped = { avatar: "avatar-drifter", skin: "skin-default", strip: null };
      const horizons = all.horizons || {};
      horizons.goals = Array.isArray(horizons.goals) ? horizons.goals : [];
      horizons.vision = Array.isArray(horizons.vision) ? horizons.vision : [];
      horizons.purpose = Array.isArray(horizons.purpose) ? horizons.purpose : [];
      return { ...all, game, horizons };
    },
  },
  5: {
    notes: [
      "Restoring a completed action now reclaims the XP and ₲ it earned — no more farming by re-completing.",
      "Un-marking a habit reverses its reward too; the books always balance.",
      "New daily upkeep: every open action costs a little threat each day, so a bloated backlog raises the pressure. Finish or cull to keep the settlement calm.",
      "Fixed the phantom 'fortify overdue' on day one — your review clock now starts when your journey does.",
      "The weekly fortification can be claimed once per weekend.",
    ],
    migrate: (all) => {
      // Backfill audit fields on already-completed actions so restores reclaim cleanly.
      // Old completed items have no recorded award; default to zero (no retroactive claw-back).
      const items = (all.items || []).map((i) =>
        i.done && i.awarded === undefined ? { ...i, awarded: { xp: 0, gtd: 0 }, claimAwarded: null } : i);
      return { ...all, items };
    },
  },
  6: {
    notes: [
      "New Settings menu — your name, data export/import, and a home for cloud sign-in soon.",
      "Projects now have a settings button; completing or deleting takes a deliberate tap (no more accidents).",
      "More context presets — Medical School, Healthcare, Engineering, Student, Creative, and Research.",
      "Link a habit to a Purpose, so a daily routine carries the reason behind it.",
    ],
    // purely additive (name in meta, purposeId on habits, project menu) — no data reshape needed
  },
  7: {
    notes: [
      "New 8-bit survivor avatars — pick a look in the Watchtower shop, female and male presets to start.",
      "Themes! Spend ₲ to recolor the whole app — Dusk Patrol, Ember Watch, Ash & Bone, and more.",
      "The old placeholder cosmetics were retired; your balance and rank are untouched.",
    ],
    migrate: (all) => {
      // Convert the old { ownedGear, equipped:{avatar,skin,strip} } shape to the new
      // { ownedCosmetics, equipped:{avatar,theme} }. Everyone keeps the free starters;
      // old purchased placeholders are dropped (they no longer exist), balance is kept.
      const g = all.game || {};
      const owned = new Set(["av-f-survivor", "av-m-survivor", "theme-settlement"]);
      // best-effort map of old skin purchases → new themes, so spenders aren't fully reset
      const skinMap = { "skin-dusk": "theme-dusk", "skin-ember": "theme-ember" };
      (g.ownedGear || []).forEach((id) => { if (skinMap[id]) owned.add(skinMap[id]); });
      const game = {
        ...g,
        ownedCosmetics: Array.from(owned),
        equipped: { avatar: "av-f-survivor", theme: "theme-settlement" },
      };
      delete game.ownedGear;
      return { ...all, game };
    },
  },
  8: {
    notes: [
      "Cloud sync arrived — sign in with Google in Settings to keep your settlement in step across devices.",
      "Sign-in is now required to use the app.",
      "Higher XP always wins automatically when two copies exist — no prompts, no chooser.",
    ],
  },
  9: {
    notes: [
      "Fixed an edit-nullification bug where Realtime events were overwriting your own changes.",
      "The sync status indicator no longer flickers — equal XP means already in sync, nothing happens.",
      "Pulls from the cloud no longer trigger a push back, breaking the feedback loop for good.",
      "Changelog entries now show reliably on every app update.",
    ],
  },
  10: {
    notes: [
      "Version numbers now ship pre-bumped in every deploy — no more manual CACHE or APP_VERSION edits needed.",
    ],
  },
  11: {
    notes: [
      "Your pixel-art survivor avatars are here — Survivor F and M now show in the Watchtower card.",
      "Sync now catches inbox items, projects, and areas that don\'t generate XP — the count tiebreaker fills the gap.",
      "More avatar artwork coming as it\'s drawn in Piskel.",
    ],
  },
  12: {
    notes: [
      "Fixed stale-snapshot sync bug — edits made on one device now appear immediately on all others without needing a refresh.",
      "Inbox items, projects added without completing actions, and areas now sync reliably across devices.",
      "Fixed a race condition where a project could disappear seconds after being created.",
    ],
  },
};

// Runs every migration with introducedVersion in (fromVersion, APP_VERSION].
function runMigrations(all, fromVersion) {
  let data = all;
  const pending = [];
  for (let v = fromVersion + 1; v <= APP_VERSION; v++) {
    const m = MIGRATIONS[v];
    if (m) {
      if (typeof m.migrate === "function") {
        try { data = m.migrate(data) || data; } catch (e) { console.error("migration", v, "failed", e); }
      }
      if (Array.isArray(m.notes)) pending.push({ version: v, notes: m.notes });
    }
  }
  return { data, pending };
}

/* ============================================================================
   HELPERS
============================================================================ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => isoDate(new Date());
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_CONTEXTS = ["@computer", "@phone", "@errands", "@home", "@office", "@anywhere", "@agenda"];
// Named context presets by domain — pick the one that fits your life and add it in one tap.
const CONTEXT_PRESETS = {
  Research: ["@lab", "@sim", "@writing", "@reading", "@code", "@analysis", "@advisor"],
  "Medical School": ["@lectures", "@anki", "@wards", "@rounds", "@study-group", "@clinic", "@exam-prep"],
  Healthcare: ["@charting", "@patients", "@rounds", "@on-call", "@pharmacy", "@admin", "@handoff"],
  Engineering: ["@cad", "@bench", "@code", "@review", "@field", "@vendor", "@docs"],
  Student: ["@class", "@library", "@group", "@email", "@reading", "@lab", "@office-hours"],
  Creative: ["@studio", "@drafting", "@editing", "@research", "@outreach", "@admin"],
};
const RESEARCH_CONTEXTS = CONTEXT_PRESETS.Research; // kept for backward-compat references
const ENERGY = ["low", "medium", "high"];
const TIMES = ["5m", "15m", "30m", "1h", "2h+"];
const RECUR = [
  { v: "", label: "once" },
  { v: "daily", label: "daily" },
  { v: "weekdays", label: "weekdays" },
  { v: "weekly", label: "weekly" },
];

// next due date for a recurring action; advances from an anchor date
function nextRecurDate(anchor, recur) {
  const d = anchor ? new Date(anchor + "T00:00") : new Date();
  if (recur === "weekly") d.setDate(d.getDate() + 7);
  else { d.setDate(d.getDate() + 1); if (recur === "weekdays") { while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); } }
  return isoDate(d);
}

// set of all ids that startId transitively depends on (its precursors)
function precursorClosure(startId, items) {
  const map = Object.fromEntries(items.map((i) => [i.id, i]));
  const seen = new Set();
  const stack = [...((map[startId] && map[startId].blockedBy) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const it = map[id];
    if (it && it.blockedBy) stack.push(...it.blockedBy);
  }
  return seen;
}

function daysBetween(a, b) {
  const d = (new Date(b) - new Date(a)) / 86400000;
  return Math.round(d);
}
function relDate(iso) {
  if (!iso) return "";
  const diff = daysBetween(todayStr(), iso);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff < 0) return `${-diff}d overdue`;
  return `in ${diff}d`;
}

function isScheduled(habit, ds) {
  const dow = new Date(ds + "T00:00").getDay();
  if (habit.cadence === "daily") return true;
  if (habit.cadence === "weekdays") return dow >= 1 && dow <= 5;
  if (Array.isArray(habit.days)) return habit.days.includes(dow);
  return true;
}
function habitStreak(habit, log) {
  let s = 0;
  const d = new Date();
  for (let i = 0; i < 400; i++) {
    const ds = isoDate(d);
    if (isScheduled(habit, ds)) {
      if (log[habit.id + "|" + ds]) s++;
      else if (ds === todayStr()) {/* today still open: don't break */}
      else break;
    }
    d.setDate(d.getDate() - 1);
  }
  return s;
}
function habitRate(habit, log, window = 30) {
  let total = 0, done = 0;
  const d = new Date();
  for (let i = 0; i < window; i++) {
    const ds = isoDate(d);
    if (isScheduled(habit, ds)) {
      total++;
      if (log[habit.id + "|" + ds]) done++;
    }
    d.setDate(d.getDate() - 1);
  }
  return total ? Math.round((done / total) * 100) : 0;
}

/* ============================================================================
   SURVIVAL LAYER — game engine (pure functions, no storage, no UI)
============================================================================ */
const ENERGY_F = { low: 1.0, medium: 1.5, high: 2.2 };
const TIME_F = { "5m": 1.0, "15m": 1.3, "30m": 1.7, "1h": 2.2, "2h+": 3.0 };

// how many not-yet-done tasks list `id` as a precursor
function unblockCount(id, items) {
  return items.filter((i) => !i.done && (i.blockedBy || []).includes(id)).length;
}
function actionWeight(item, items) {
  const e = ENERGY_F[item.energy] || 1.0;
  const t = TIME_F[item.time] || 1.0;
  const dep = 1 + 0.5 * unblockCount(item.id, items);
  return e * t * dep;
}
const actionXP = (w) => Math.round(5 * w);
const actionGTD = (w) => Math.round(2 * w);

// difficulty tier from weight → drives encounter tone
function toneTier(w) {
  if (w < 1.5) return "trivial";
  if (w < 4) return "standard";
  if (w < 7) return "serious";
  return "severe";
}
const TONE_META = {
  trivial:  { label: "straggler", color: "var(--t-secure)", sigil: "·" },
  standard: { label: "walker",    color: "var(--t-unsettled)", sigil: "›" },
  serious:  { label: "fed",       color: "var(--t-threatened)", sigil: "»" },
  severe:   { label: "brute",     color: "var(--t-overrun)", sigil: "✦" },
};
const TONE_LINES = {
  trivial: [
    "Something shuffles at the fence. Trips over its own feet.",
    "A lone one out past the wire. Barely worth the bullet.",
    "Easy. It hasn't even noticed you yet.",
  ],
  standard: [
    "A few in the field. Nothing you haven't handled.",
    "Steady now — they're moving, but slow.",
    "Routine clear. Keep your spacing.",
  ],
  serious: [
    "This one's been fed. Move carefully.",
    "It's bigger than the others. Watch its hands.",
    "Don't rush this. It'll take everything you've got.",
  ],
  severe: [
    "The wall's been quiet too long. Something big moved in the dark.",
    "You hear it before you see it. That's never good.",
    "This is the one you've been putting off. It knows.",
  ],
};
function encounterLine(tier, seed = 0) {
  const arr = TONE_LINES[tier] || TONE_LINES.standard;
  return arr[Math.abs(seed) % arr.length];
}

// ----- Level / Rank (derive from cumulative XP; only ever climbs) -----
// Triangular base × a mild late-game accelerator → noticeably grindier than a flat curve.
const xpForLevel = (L) => Math.round(200 * L * (L + 1) / 2 * (1 + 0.12 * (L - 1))); // cumulative XP to reach level L+1
function levelFromXP(xp) {
  let L = 1;
  while (xp >= xpForLevel(L)) L++;
  return L;
}
function levelProgress(xp) {
  const L = levelFromXP(xp);
  const floor = L === 1 ? 0 : xpForLevel(L - 1);
  const ceil = xpForLevel(L);
  return { level: L, floor, ceil, inLevel: xp - floor, span: ceil - floor, pct: Math.min(100, Math.round(((xp - floor) / (ceil - floor)) * 100)) };
}
const RANKS = [
  { min: 1, name: "Drifter" }, { min: 3, name: "Scavenger" }, { min: 5, name: "Survivor" },
  { min: 7, name: "Outrider" }, { min: 10, name: "Warden" }, { min: 13, name: "Quartermaster" },
  { min: 16, name: "Vanguard" }, { min: 20, name: "Settlement Architect" },
];
function rankFor(level) {
  let r = RANKS[0];
  for (const x of RANKS) if (level >= x.min) r = x;
  return r.name;
}
// Summarize a state blob into the human-facing stats used by the sync chooser.
function statsOf(b) {
  const xp = (b && b.game && b.game.xp) || 0;
  const gtd = (b && b.game && b.game.gtd) || 0;
  const level = levelFromXP(xp);
  return {
    xp, gtd, level, rank: rankFor(level),
    items: (b && b.items || []).filter((i) => !i.done).length,
    projects: (b && b.projects || []).filter((p) => p.status === "active").length,
    habits: (b && b.habits || []).length,
  };
}
const rankTier = (level) => RANKS.filter((r) => level >= r.min).length; // 1..8, gates gear tiers

// ----- Threat (0–100), computed live from system state -----
const FORTIFY_FLOOR_DAYS = 3;
function threatBreakdown({ items, projects, habits, log, lastReview, lastTended, siegeBrokenAt, journeyStarted }) {
  const parts = [];
  const today = todayStr();
  const now = Date.now();

  // inbox stragglers: +2 each, +0.5/day aged, cap +8 each
  const inbox = items.filter((i) => i.type === "inbox");
  let inboxT = 0;
  inbox.forEach((i) => {
    const age = Math.max(0, daysBetween(isoDate(new Date(i.createdAt || now)), today));
    inboxT += Math.min(8, 2 + 0.5 * age);
  });
  if (inbox.length) parts.push({ key: "inbox", label: `${inbox.length} ${inbox.length === 1 ? "shape" : "shapes"} in the fog`, amt: inboxT });

  // stalled projects (no actionable next action): +8 each — wall breach
  const isBlocked = (i) => (i.blockedBy || []).some((bid) => { const b = items.find((x) => x.id === bid); return b && !b.done; });
  const active = projects.filter((p) => p.status === "active");
  const stalled = active.filter((p) => items.filter((i) => i.projectId === p.id && i.type === "next" && !i.done && !isBlocked(i)).length === 0 && items.some((i) => i.projectId === p.id));
  if (stalled.length) parts.push({ key: "stalled", label: `${stalled.length} wall ${stalled.length === 1 ? "breach" : "breaches"}`, amt: stalled.length * 8 });

  // overdue weekly review: the clock starts at the LATER of last review or journey start,
  // so a brand-new survivor has no phantom backlog. Grace of 7 days, then +3/day, cap +30.
  const anchor = lastReview || (journeyStarted ? isoDate(new Date(journeyStarted)) : today);
  const sinceReview = daysBetween(anchor, today);
  if (sinceReview > 7) {
    const amt = Math.min(30, (sinceReview - 7) * 3);
    parts.push({ key: "review", label: `fortify overdue ${sinceReview - 7}d`, amt });
  }

  // missed scheduled raids: +4 each
  const missed = items.filter((i) => i.type === "calendar" && !i.done && i.dueDate && i.dueDate < today);
  if (missed.length) parts.push({ key: "missed", label: `${missed.length} missed ${missed.length === 1 ? "raid" : "raids"}`, amt: missed.length * 4 });

  // lapsed routines today: +1.5 each scheduled-but-undone
  const brokenToday = habits.filter((h) => isScheduled(h, today) && !log[h.id + "|" + today]).length;
  if (brokenToday) parts.push({ key: "habits", label: `${brokenToday} ${brokenToday === 1 ? "routine" : "routines"} unattended`, amt: brokenToday * 1.5 });

  // daily upkeep: every OPEN next action costs 0.1/day to "feed" — the backlog tax.
  // Uncapped on purpose: hoarding tasks you never finish steadily raises the threat,
  // pushing you to either complete or cull. Completing an action removes its share.
  const openActions = items.filter((i) => i.type === "next" && !i.done).length;
  const upkeep = openActions * 0.1;
  if (upkeep > 0) parts.push({ key: "upkeep", label: `upkeep on ${openActions} open ${openActions === 1 ? "action" : "actions"}`, amt: upkeep });

  let raw = parts.reduce((s, p) => s + p.amt, 0);

  // Fortified buffer: a recent review caps threat low for a few days
  let fortified = false;
  if (siegeBrokenAt) {
    const d = daysBetween(isoDate(new Date(siegeBrokenAt)), today);
    if (d <= FORTIFY_FLOOR_DAYS) { raw = Math.min(raw, 35); fortified = true; }
  }
  const value = Math.max(0, Math.min(100, Math.round(raw)));
  return { value, parts, fortified };
}

const THREAT_BANDS = [
  { max: 20, name: "SECURE", varc: "--t-secure" },
  { max: 45, name: "UNSETTLED", varc: "--t-unsettled" },
  { max: 70, name: "THREATENED", varc: "--t-threatened" },
  { max: 99, name: "OVERRUN", varc: "--t-overrun" },
  { max: 100, name: "UNDER SIEGE", varc: "--t-siege" },
];
const threatBand = (v) => THREAT_BANDS.find((b) => v <= b.max) || THREAT_BANDS[THREAT_BANDS.length - 1];

// Cosmetic gear catalog (gear is visual only; rank gates tier, GTD buys item)
/* ============================================================================
   COSMETICS — avatars (8-bit pixel art) and themes (palette swaps)
   Avatars are drawn from compact 12-row grids: each string is a row, each char
   a palette key. "." = transparent. Recoloring = swapping the palette map.
============================================================================ */
// Avatars: each entry has id, name, tier, cost, tile color, and either
// a `src` (base64 PNG — crips pixel art rendered with image-rendering:pixelated)
// or a `grid`+`pal` (legacy SVG grid, used for placeholder entries).
const AVATARS = [
  { id: "av-f-survivor", name: "Survivor (F)", tier: 1, cost: 0, tile: "#2c6a55",
    src: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAABgcEAQP/xAAmEAACAgICAQQCAwEAAAAAAAABAgMEBREGEiEABxMxIjIIFVFh/8QAGQEAAgMBAAAAAAAAAAAAAAAAAQIAAwQF/8QAJxEAAQIFAwMFAQAAAAAAAAAAAQIDAAQRITEFBhITQVEVI2Gx0fH/2gAMAwEAAhEDEQA/AI1VhN6WVBO8MMLdJHjK/IX0G6r2BA8EEsQfsAAkkp2XHzC7FXrXrRgI7TvPCjOq+f0deq9iQPBRuvkkn8VJPks2fw96W9jLnStbZe6dVPVwuvpt/YH2P88/Q9I+I+3mZ5hx+nzLl3IcZjMI+QGOgluzwRpsqxeQhpoR1XqNhSXbXhWC+uzrU/qjU+57hQnAAxTtbFT5/kZXUv8AMq5UEbb2NWOJWxYeCUyIriSSSdShYBjqSTYKjZGiN6IIOwV8D3isvUmZGljVX7J4DoxIVtbPXfVgVP0QfJGmNY5f7C2OM8dtZy/muHNXrdO4PH68H7OqD857EcY8sP2Yb+hskAxFqk68ryK1J8RNRp3ZKq2scXSOwkbEK8cYZoujb7eN/uSDs79NtrUp9MylkqK0HIzT5qfH1WBK9YGijURuylipUwuZa1RhtvZqCGs8tSKcV3IkUkd9Mm/kDd42DK0Ue1cbAae1PBeQ5T22x2bw2JtZWi8kkMtahZSCaGRJ+zuOzp+MqiJHKMH1Cg+gCobMVbeToWaWOrGxKOoc/LHGqHYIBLsNnQ3obI2N62Nuv4r5n3XMmUwPBrWGevU1PNSzXyfGhJZT06fkp39jY8gf99Dc7cuqcV0lVNiq+Dj8tFr6UOAgHuKw0zXDEmoUuO8YuYnOcgxVez/d18Pkaq2uzu0cQTs4ctSTddTIqdY5gE1+UQjsgK5/OxNjWxjxZKSF6jSd2idFVGDNs9mLKSTttkn8m+zX+X+9vvZxnkGTwtvjvDLM+MKrYesspXbRJKAoadXY9ZF+l+/A36iWCu38qt3M5KX5reRuy25pdKvyO52zaXQG27eAAP8APT7TbHqHIXoDEYbTzKgb4zH/2Q==" },
  { id: "av-m-survivor", name: "Survivor (M)", tier: 1, cost: 0, tile: "#3a4a63",
    src: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAGgAAAQUBAAAAAAAAAAAAAAAABwEDBQYIBP/EACkQAAIBAwMDBAEFAAAAAAAAAAECAwQFEQYSIQAHExQiMUEyI1FhgfD/xAAYAQADAQEAAAAAAAAAAAAAAAABAwUCBv/EACcRAAEDAgUDBQEAAAAAAAAAAAECAxEAIQQGEkFhBTGBInGhscHw/9oADAMBAAIRAxEAPwACamuj22mRYVzNNkIx+FxjJ/k8/wC+5Gx0dLbtMPebutRdS8KzbWqZowucYVdrqfv3M2cn8Rhd0kRq22V1fRpWUsKSQ0zSrJ+sgclVR32xlt7hVZWYqpAByTwcJPfrhSWujpa+13KnpTSwhQ4jEcsZXCuBJCchtjEckHBx8ddDmPGvuYsttL9KbWMbCfM0vEBagAg+9X2SwrTUFtrLppmOgguqBqV4L3JLMgJnCM0bSk7WWnZ0kCSROCvJ5HVdQ5aVd27xzSRbtu3dscruxk4zjOMnGcZPz1yQXzSNJUPJDbtRwT0+d7JDRK0fO05xDkcnH946eiqrXUwu9rp7+krS7y1dLT+L3EOxIVA3KsSMcZI+ujlvqL7WKKF6lJUO1zBkXubCO9YZKgu8wfP3Tldd6q32Ktt9O9tAqxIy+qQb0d4vFI0TZG0tGdpzkcDGDknR9n7X6M7k2W0alseoJ6F4YkRWoYomRVjZvCFR0PjKZfGMEEsD+OBlCm1OkNXWU0/lSGWfiqpJNsqqpAGCcgrjccfuxIx0YOw2jdP3GjShp+7V801cZm4gort6P1bO7BPFHx5CVRd2GYg7QQPgTOtvsv4pSm0abnnVzx/b0XACqCI/aKt57XaV1FLb9G0CXulpbUk8bVTWGVHMrSeSaWSpqAKeaN3VcJFGWDFWQiIMBni+U3pNTXum9a9cYLnUweqfG6cRytGrnbxkqi/HVx750Oqu3OrqOyDuJrm4W+4UKyxS111qFSWTfIskQdZFQEKIzgg/mMlQc9DyknppVMdOyjxexo9u0x44wVPK/B4I+ureUcO2HlO6xMQBvff42nmKY2kTIr//2Q==" },
  { id: "av-f-scout",    name: "Scout (F)",    tier: 2, cost: 140,  tile: "#bd5b27", src: null },
  { id: "av-m-ranger",   name: "Ranger (M)",   tier: 2, cost: 140,  tile: "#3f6b3a", src: null },
  { id: "av-f-warden",   name: "Warden (F)",   tier: 4, cost: 480,  tile: "#1f4e3e", src: null },
  { id: "av-m-warden",   name: "Warden (M)",   tier: 4, cost: 480,  tile: "#2a2a2a", src: null },
  { id: "av-f-architect",name: "Architect (F)",tier: 6, cost: 1100, tile: "#7a2e1a", src: null },
  { id: "av-m-architect",name: "Architect (M)",tier: 6, cost: 1100, tile: "#3a2e10", src: null },
];

// Themes recolor the whole palette (buttons + backdrop) via a class on .gtd.
// "vars" override the base CSS variables. tier gates access, cost is in ₲.
const THEMES = [
  { id: "theme-settlement", name: "Settlement", tier: 1, cost: 0, swatch: "#2c6a55", vars: null },
  { id: "theme-dusk", name: "Dusk Patrol", tier: 2, cost: 220, swatch: "#3a4a63",
    vars: { "--paper": "#eef0f4", "--paper2": "#e2e6ee", "--card": "#f8fafc", "--line": "#d4dae6", "--line2": "#c2cad9", "--pine": "#3a4a63", "--pine-d": "#27324a", "--pine-soft": "#dde3ef", "--clay": "#c2763a", "--clay-soft": "#f0e4d6", "--amber": "#b08518" } },
  { id: "theme-ember", name: "Ember Watch", tier: 4, cost: 520, swatch: "#7a2e1a",
    vars: { "--paper": "#f4ece6", "--paper2": "#ece0d6", "--card": "#fbf6f1", "--line": "#e3d2c4", "--line2": "#d6c0ad", "--pine": "#a23a28", "--pine-d": "#7a2418", "--pine-soft": "#f0ddd4", "--clay": "#c2762a", "--clay-soft": "#f3e4d2", "--amber": "#bf7b1a" } },
  { id: "theme-mono", name: "Ash & Bone", tier: 3, cost: 360, swatch: "#3a3a3a",
    vars: { "--paper": "#ecebe8", "--paper2": "#e0dfdb", "--card": "#f7f6f3", "--line": "#d8d6d0", "--line2": "#c6c4bc", "--pine": "#3a3a38", "--pine-d": "#222220", "--pine-soft": "#e0e0db", "--clay": "#8a6a4a", "--clay-soft": "#e8e2d8", "--amber": "#9a8a4a" } },
  { id: "theme-bloom", name: "Spring Bloom", tier: 5, cost: 700, swatch: "#7a4a8a",
    vars: { "--paper": "#f3eef4", "--paper2": "#e9e1ec", "--card": "#fbf8fc", "--line": "#e0d4e6", "--line2": "#cebcd6", "--pine": "#7a4a8a", "--pine-d": "#5a3468", "--pine-soft": "#ece0f0", "--clay": "#c25a8a", "--clay-soft": "#f3dde8", "--amber": "#c08a16" } },
];

/* ============================================================================
   THEME / STYLE
============================================================================ */
const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

.gtd { --paper:#f3efe6; --paper2:#ece7da; --card:#fbf9f4; --ink:#221f1a; --ink2:#5c554a;
  --muted:#938b7c; --line:#e2dccd; --line2:#d4cdba; --pine:#2c6a55; --pine-d:#1f4e3e;
  --clay:#bd5b27; --clay-soft:#f0e2d4; --pine-soft:#dfeae3; --amber:#c08a16;
  --t-secure:#3f8f5f; --t-unsettled:#c0a015; --t-threatened:#cf7b1e; --t-overrun:#c0392b; --t-siege:#7a1a12;
  font-family:'IBM Plex Sans',sans-serif; color:var(--ink); background:var(--paper);
  -webkit-font-smoothing:antialiased; }
.gtd.siege { --paper:#231a18; --paper2:#2c1f1c; --card:#2a201d; --ink:#f0e6e2; --ink2:#c7b3ac;
  --muted:#9c8077; --line:#3d2c27; --line2:#4a342e; --pine:#a23a28; --pine-d:#7a1a12;
  --pine-soft:#3a221d; --clay:#d8643a; --clay-soft:#3a221d; }
.gtd * { box-sizing:border-box; }
.gtd.siege * { transition:background .4s, color .4s, border-color .4s; }
.serif { font-family:'Newsreader',serif; }
.mono { font-family:'IBM Plex Mono',monospace; }
.gtd ::-webkit-scrollbar { width:9px; height:9px; }
.gtd ::-webkit-scrollbar-thumb { background:var(--line2); border-radius:6px; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
@keyframes floatup { from{opacity:0;transform:translateY(6px)} 15%{opacity:1} 80%{opacity:1} to{opacity:0;transform:translateY(-14px)} }
.toast { position:absolute; bottom:18px; left:50%; transform:translateX(-50%); z-index:90;
  display:flex; flex-direction:column; gap:6px; align-items:center; pointer-events:none; }
.toast .t { background:var(--ink); color:var(--paper); font-family:'IBM Plex Mono',monospace; font-size:12px;
  padding:6px 13px; border-radius:20px; animation:floatup 2.6s ease forwards; box-shadow:0 3px 14px rgba(0,0,0,.18); }
.strip { display:flex; align-items:center; gap:14px; padding:7px 14px; cursor:pointer;
  border-bottom:1px solid var(--line); background:var(--card); transition:background .14s; user-select:none; }
.strip:hover { background:var(--paper2); }
.strip .seg { display:flex; align-items:center; gap:6px; font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--ink2); }
.threat-bar { height:7px; border-radius:6px; background:var(--paper2); overflow:hidden; position:relative; }
.threat-bar > i { display:block; height:100%; border-radius:6px; transition:width .5s ease, background .3s; }
.xp-bar { height:5px; border-radius:6px; background:var(--paper2); overflow:hidden; }
.xp-bar > i { display:block; height:100%; background:var(--amber); border-radius:6px; transition:width .5s ease; }
.gtd-glyph { display:inline-block; position:relative; font-weight:600; font-family:'IBM Plex Mono',monospace; }
.gtd-glyph::before { content:""; position:absolute; left:50%; top:8%; bottom:8%; width:1px; background:currentColor; transform:translateX(-2.5px); }
.gtd-glyph::after { content:""; position:absolute; left:50%; top:8%; bottom:8%; width:1px; background:currentColor; transform:translateX(0.5px); }
.gear-card { border:1px solid var(--line2); border-radius:11px; padding:12px; background:var(--card); display:flex; flex-direction:column; gap:8px; }
.gear-card.equipped { border-color:var(--pine); box-shadow:0 0 0 2px var(--pine-soft); }
.gear-card.locked { opacity:.55; }
.raid { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--card); cursor:pointer; transition:all .13s; }
.raid:hover { background:var(--paper2); border-color:var(--line2); }
.subq { font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--muted); letter-spacing:1.5px; font-style:normal; vertical-align:middle; margin-left:6px; }

/* ---- App shell layout (desktop default = two columns) ---- */
.app-shell { position:relative; height:760px; display:flex; overflow:hidden; border-radius:14px; border:1px solid var(--line); }
.sidebar { width:232px; flex-shrink:0; background:var(--paper2); border-right:1px solid var(--line);
  padding:18px 13px; display:flex; flex-direction:column; overflow:auto; }
.mobile-topbar { display:none; }
.drawer-backdrop { display:none; }
.hamburger { display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px;
  border-radius:9px; border:1px solid var(--line2); background:var(--card); color:var(--ink); cursor:pointer; }
.hamburger:hover { background:var(--paper2); }

/* ---- Mobile / narrow screens: sidebar becomes an off-canvas drawer ---- */
@media (max-width: 760px) {
  .app-shell { height:100dvh; border-radius:0; border:none; }
  .mobile-topbar { display:flex; align-items:center; gap:11px;
    padding:10px 14px;
    padding-top:calc(10px + env(safe-area-inset-top, 0px));
    border-bottom:1px solid var(--line); background:var(--card); flex-shrink:0; }
  .sidebar {
    position:absolute; top:0; left:0; bottom:0; z-index:60; width:264px; max-width:84vw;
    transform:translateX(-100%); transition:transform .24s ease; box-shadow:0 0 0 rgba(0,0,0,0);
    padding-top:calc(18px + env(safe-area-inset-top, 0px));
  }
  .app-shell.drawer-open .sidebar { transform:translateX(0); box-shadow:6px 0 24px rgba(0,0,0,.22); }
  .app-shell.drawer-open .drawer-backdrop {
    display:block; position:absolute; inset:0; z-index:55; background:rgba(20,16,14,.42);
    animation:fade .2s ease;
  }
}
/* On true desktop, never show the drawer chrome even if state flips */
@media (min-width: 761px) {
  .mobile-topbar, .drawer-backdrop { display:none !important; }
  .sidebar { transform:none !important; }
}
/* Tighten interior spacing on phones so nothing clips */
@media (max-width: 760px) {
  .content-scroll { padding:16px !important; padding-bottom:calc(16px + env(safe-area-inset-bottom, 0px)) !important; }
  .strip { gap:10px; padding:7px 12px; flex-wrap:wrap; }
  .strip .seg { font-size:11px; }
}

.card { background:var(--card); border:1px solid var(--line); border-radius:12px; }
.hair { border-color:var(--line); }

.btn { font-family:'IBM Plex Sans',sans-serif; font-size:13px; font-weight:500; border-radius:9px;
  padding:8px 13px; border:1px solid var(--line2); background:var(--card); color:var(--ink);
  cursor:pointer; transition:all .14s ease; display:inline-flex; align-items:center; gap:6px;
  white-space:nowrap; }
.btn:hover { background:var(--paper2); }
.btn-accent { background:var(--pine); border-color:var(--pine); color:#fbf9f4; }
.btn-accent:hover { background:var(--pine-d); }
.btn-clay { background:var(--clay); border-color:var(--clay); color:#fbf9f4; }
.btn-clay:hover { filter:brightness(.93); }
.btn-ghost { background:transparent; border-color:transparent; color:var(--ink2); padding:6px 9px; }
.btn-ghost:hover { background:var(--paper2); }
.btn-danger:hover { background:#f6e3da; border-color:var(--clay); color:var(--clay); }
.btn-sm { padding:5px 9px; font-size:12px; }

.input { font-family:'IBM Plex Sans',sans-serif; font-size:14px; color:var(--ink);
  background:var(--card); border:1px solid var(--line2); border-radius:9px; padding:9px 12px;
  width:100%; outline:none; transition:border .14s; }
.input:focus { border-color:var(--pine); box-shadow:0 0 0 3px var(--pine-soft); }
.input::placeholder { color:var(--muted); }

.pill { font-family:'IBM Plex Mono',monospace; font-size:11px; padding:2px 8px; border-radius:20px;
  border:1px solid var(--line2); color:var(--ink2); background:var(--paper); white-space:nowrap; }
.pill.on { background:var(--pine); color:#fbf9f4; border-color:var(--pine); }
.pill-ctx { color:var(--pine-d); background:var(--pine-soft); border-color:transparent; }

.nav { display:flex; align-items:center; gap:10px; width:100%; padding:9px 12px; border-radius:10px;
  cursor:pointer; color:var(--ink2); font-size:14px; font-weight:500; border:1px solid transparent;
  transition:all .13s; text-align:left; }
.nav:hover { background:var(--paper2); }
.nav.active { background:var(--card); color:var(--ink); border-color:var(--line); box-shadow:0 1px 0 rgba(0,0,0,.02); }
.nav .ico { color:var(--muted); flex-shrink:0; }
.nav.active .ico { color:var(--pine); }
.count { margin-left:auto; font-family:'IBM Plex Mono',monospace; font-size:11px; min-width:20px;
  text-align:center; padding:1px 6px; border-radius:20px; background:var(--paper2); color:var(--ink2); }
.count.hot { background:var(--clay); color:#fbf9f4; }

.checkbox { width:20px; height:20px; border-radius:50%; border:1.6px solid var(--line2);
  cursor:pointer; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  transition:all .13s; background:var(--card); }
.checkbox:hover { border-color:var(--pine); }
.checkbox.done { background:var(--pine); border-color:var(--pine); }

.row { display:flex; align-items:flex-start; gap:11px; padding:11px 13px; border-bottom:1px solid var(--line);
  transition:background .12s; }
.row:hover { background:var(--paper2); }
.row:last-child { border-bottom:none; }

.overlay { position:absolute; inset:0; background:rgba(34,31,26,.34); backdrop-filter:blur(2px);
  display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; z-index:50;
  animation:fade .18s ease; overflow:auto; }
@keyframes fade { from{opacity:0} to{opacity:1} }
@keyframes rise { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
.rise { animation:rise .22s ease both; }
.stagger > * { animation:rise .3s ease both; }

.hgrid { display:flex; gap:5px; }
.hcell { width:24px; height:24px; border-radius:6px; border:1px solid var(--line2); background:var(--paper);
  display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .12s;
  font-size:10px; }
.hcell:hover { border-color:var(--pine); }
.hcell.done { background:var(--pine); border-color:var(--pine); color:#fbf9f4; }
.hcell.future { opacity:.35; cursor:default; }
.hcell.off { background:transparent; border-style:dashed; opacity:.5; cursor:default; }

.tag-ink { color:var(--ink2); }
.cal { display:grid; grid-template-columns:repeat(7,1fr); gap:6px; }
.cal-h { font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--muted); text-align:center; padding-bottom:2px; letter-spacing:1px; }
.cal-cell { min-height:80px; border:1px solid var(--line); border-radius:9px; background:var(--card); padding:5px 6px; display:flex; flex-direction:column; gap:3px; overflow:hidden; }
.cal-cell.empty { background:transparent; border-color:transparent; }
.cal-cell.today { border-color:var(--pine); box-shadow:0 0 0 2px var(--pine-soft); }
.cal-cell.weekend { background:var(--paper2); }
.cal-day { font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:500; color:var(--ink2); }
.cal-cell.today .cal-day { color:var(--pine); font-weight:600; }
.cal-item { font-size:10px; line-height:1.3; background:var(--pine-soft); color:var(--pine-d); border-radius:5px;
  padding:2px 5px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cal-item.over { background:var(--clay-soft); color:var(--clay); }
.act-row .edit-btn { opacity:.3; transition:opacity .12s; }
.act-row:hover .edit-btn { opacity:1; }
a.linklike { color:var(--pine-d); cursor:pointer; text-decoration:underline; }
`;

/* ============================================================================
   SMALL UI
============================================================================ */
function Pill({ on, ctx, children, onClick }) {
  return (
    <button className={"pill " + (on ? "on " : "") + (ctx ? "pill-ctx " : "")}
      onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      {children}
    </button>
  );
}
function Empty({ icon, title, sub }) {
  const I = icon;
  return (
    <div style={{ textAlign: "center", padding: "54px 20px", color: "var(--muted)" }}>
      <I size={30} style={{ opacity: .5 }} />
      <div className="serif" style={{ fontSize: 19, color: "var(--ink2)", marginTop: 12 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

/* ============================================================================
   CLARIFY MODAL — the heart of GTD inbox processing
============================================================================ */
function Clarify({ item, contexts, onClose, onTransform, onDelete }) {
  const [title, setTitle] = useState(item.title);
  const [notes, setNotes] = useState(item.notes || "");
  const [step, setStep] = useState("decide"); // decide | next | waiting | calendar
  const [ctx, setCtx] = useState(contexts[0]);
  const [energy, setEnergy] = useState("medium");
  const [time, setTime] = useState("15m");
  const [recur, setRecur] = useState("");
  const [who, setWho] = useState("");
  const [date, setDate] = useState(todayStr());

  const base = () => ({ ...item, title: title.trim() || item.title, notes });

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card rise" style={{ width: 540, maxWidth: "100%", padding: 22 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--clay)", letterSpacing: .5 }}>CLARIFY</span>
          <button className="btn-ghost btn" onClick={onClose}><X size={16} /></button>
        </div>
        <input className="input serif" style={{ fontSize: 19, padding: "6px 0", border: "none", background: "transparent" }}
          value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input" rows={2} placeholder="Notes / details…" style={{ marginTop: 8, resize: "vertical" }}
          value={notes} onChange={(e) => setNotes(e.target.value)} />

        {step === "decide" && (
          <div style={{ marginTop: 18 }}>
            <div className="tag-ink" style={{ fontSize: 13, marginBottom: 8 }}>Is it actionable?</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button className="btn btn-accent" onClick={() => onTransform({ ...base(), type: "next", done: true, completedAt: Date.now(), context: ctx, projectId: null })}>
                <Check size={15} /> Do it now (under 2 min)
              </button>
              <button className="btn" onClick={() => setStep("next")}><Zap size={15} /> Next action</button>
              <button className="btn" onClick={() => setStep("waiting")}><Hourglass size={15} /> Delegate / waiting</button>
              <button className="btn" onClick={() => onTransform({ ...base(), _makeProject: true })}><FolderKanban size={15} /> It's a project</button>
              <button className="btn" onClick={() => setStep("calendar")}><Calendar size={15} /> Schedule it</button>
              <button className="btn" onClick={() => onTransform({ ...base(), type: "someday", projectId: null })}><Moon size={15} /> Someday / maybe</button>
              <button className="btn" onClick={() => onTransform({ ...base(), type: "reference", projectId: null })}><BookOpen size={15} /> Reference</button>
              <button className="btn btn-danger" onClick={() => onDelete(item.id)}><Trash2 size={15} /> Trash</button>
            </div>
          </div>
        )}

        {step === "next" && (
          <div style={{ marginTop: 18 }} className="rise">
            <div className="tag-ink" style={{ fontSize: 13, marginBottom: 7 }}>Context</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {contexts.map((c) => <Pill key={c} on={ctx === c} onClick={() => setCtx(c)}>{c}</Pill>)}
            </div>
            <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
              <div>
                <div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Energy</div>
                <div style={{ display: "flex", gap: 6 }}>{ENERGY.map((e) => <Pill key={e} on={energy === e} onClick={() => setEnergy(e)}>{e}</Pill>)}</div>
              </div>
              <div>
                <div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Time</div>
                <div style={{ display: "flex", gap: 6 }}>{TIMES.map((t) => <Pill key={t} on={time === t} onClick={() => setTime(t)}>{t}</Pill>)}</div>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Repeat</div>
              <div style={{ display: "flex", gap: 6 }}>{RECUR.map((r) => <Pill key={r.v} on={recur === r.v} onClick={() => setRecur(r.v)}>{r.label}</Pill>)}</div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button className="btn btn-accent" onClick={() => onTransform({ ...base(), type: "next", done: false, context: ctx, energy, time, recur: recur || null })}>
                <ArrowRight size={15} /> Add to Next Actions
              </button>
              <button className="btn btn-ghost" onClick={() => setStep("decide")}>Back</button>
            </div>
          </div>
        )}

        {step === "waiting" && (
          <div style={{ marginTop: 18 }} className="rise">
            <div className="tag-ink" style={{ fontSize: 13, marginBottom: 7 }}>Waiting on whom / what?</div>
            <input className="input" autoFocus placeholder="e.g. Reply from advisor" value={who} onChange={(e) => setWho(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn btn-accent" onClick={() => onTransform({ ...base(), type: "waiting", waitingOn: who.trim(), since: todayStr() })}>
                <Hourglass size={15} /> Add to Waiting For
              </button>
              <button className="btn btn-ghost" onClick={() => setStep("decide")}>Back</button>
            </div>
          </div>
        )}

        {step === "calendar" && (
          <div style={{ marginTop: 18 }} className="rise">
            <div className="tag-ink" style={{ fontSize: 13, marginBottom: 7 }}>Date (the hard landscape — only true date-specific items)</div>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 200 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn btn-accent" onClick={() => onTransform({ ...base(), type: "calendar", dueDate: date })}>
                <Calendar size={15} /> Schedule
              </button>
              <button className="btn btn-ghost" onClick={() => setStep("decide")}>Back</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   EDIT MODAL — edit any item after creation
============================================================================ */
function EditItem({ item, contexts, onClose, onSave, onDelete }) {
  const [f, setF] = useState({
    title: item.title, notes: item.notes || "", context: item.context || contexts[0],
    energy: item.energy || "medium", time: item.time || "15m", recur: item.recur || "",
    waitingOn: item.waitingOn || "", dueDate: item.dueDate || todayStr(),
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = () => {
    const patch = { title: f.title.trim() || item.title, notes: f.notes };
    if (item.type === "next") Object.assign(patch, { context: f.context, energy: f.energy, time: f.time, recur: f.recur || null });
    if (item.type === "waiting") patch.waitingOn = f.waitingOn;
    if (item.type === "calendar") patch.dueDate = f.dueDate;
    onSave(item.id, patch);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card rise" style={{ width: 520, maxWidth: "100%", padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--pine)", letterSpacing: .5 }}>EDIT</span>
          <button className="btn btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <input className="input serif" style={{ fontSize: 19, padding: "6px 0", border: "none", background: "transparent" }}
          value={f.title} onChange={(e) => set("title", e.target.value)} />
        <textarea className="input" rows={2} placeholder="Notes / details…" style={{ marginTop: 8, resize: "vertical" }}
          value={f.notes} onChange={(e) => set("notes", e.target.value)} />

        {item.type === "next" && (
          <div style={{ marginTop: 14 }}>
            <div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Context</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{contexts.map((c) => <Pill key={c} on={f.context === c} onClick={() => set("context", c)}>{c}</Pill>)}</div>
            <div style={{ display: "flex", gap: 22, marginTop: 12, flexWrap: "wrap" }}>
              <div><div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Energy</div><div style={{ display: "flex", gap: 6 }}>{ENERGY.map((e) => <Pill key={e} on={f.energy === e} onClick={() => set("energy", e)}>{e}</Pill>)}</div></div>
              <div><div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Time</div><div style={{ display: "flex", gap: 6 }}>{TIMES.map((t) => <Pill key={t} on={f.time === t} onClick={() => set("time", t)}>{t}</Pill>)}</div></div>
              <div><div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Repeat</div><div style={{ display: "flex", gap: 6 }}>{RECUR.map((r) => <Pill key={r.v} on={f.recur === r.v} onClick={() => set("recur", r.v)}>{r.label}</Pill>)}</div></div>
            </div>
          </div>
        )}
        {item.type === "waiting" && (
          <div style={{ marginTop: 14 }}><div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Waiting on</div>
            <input className="input" value={f.waitingOn} onChange={(e) => set("waitingOn", e.target.value)} /></div>
        )}
        {item.type === "calendar" && (
          <div style={{ marginTop: 14 }}><div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Date</div>
            <input className="input" type="date" style={{ maxWidth: 200 }} value={f.dueDate} onChange={(e) => set("dueDate", e.target.value)} /></div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button className="btn btn-accent" onClick={save}><Check size={15} /> Save</button>
          <button className="btn btn-danger" onClick={() => onDelete(item.id)}><Trash2 size={15} /> Delete</button>
          <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   CONTEXT MANAGER — add/remove contexts, apply research preset
============================================================================ */
function ContextManager({ contexts, onClose, onSave }) {
  const [list, setList] = useState(contexts);
  const [nc, setNc] = useState("");
  const norm = (s) => { let t = s.trim().replace(/\s+/g, "-").toLowerCase(); if (t && !t.startsWith("@")) t = "@" + t; return t; };
  const add = () => { const t = norm(nc); if (t && !list.includes(t)) setList([...list, t]); setNc(""); };
  const addPreset = (ctxs) => setList((l) => [...new Set([...l, ...ctxs])]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card rise" style={{ width: 480, maxWidth: "100%", padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span className="serif" style={{ fontSize: 19 }}>Contexts</span>
          <button className="btn btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--ink2)", marginTop: 0 }}>Where or with what tool an action can be done. Removing a context leaves existing actions tagged with it intact.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 14 }}>
          {list.map((c) => (
            <span key={c} className="pill pill-ctx" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {c}<X size={11} style={{ cursor: "pointer" }} onClick={() => setList(list.filter((x) => x !== c))} />
            </span>
          ))}
        </div>
        <div className="subq" style={{ marginBottom: 7 }}>PRESETS — add a domain's contexts in one tap</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          {Object.entries(CONTEXT_PRESETS).map(([name, ctxs]) => {
            const missing = ctxs.filter((c) => !list.includes(c));
            const fully = missing.length === 0;
            return (
              <button key={name} className="btn btn-sm" disabled={fully} style={{ opacity: fully ? .5 : 1 }}
                title={fully ? "already added" : ctxs.join(" ")} onClick={() => addPreset(ctxs)}>
                <Plus size={12} /> {name}{fully ? " ✓" : ""}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" placeholder="Add a context…" value={nc} onChange={(e) => setNc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="btn" onClick={add}><Plus size={15} /></button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button className="btn btn-accent" onClick={() => onSave(list)}><Check size={15} /> Save</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
// Shows an "Install app" button only when the browser says the PWA is installable.
// Captures the deferred beforeinstallprompt event and fires it on click. Hides itself
// once installed or in browsers that don't support programmatic install (e.g. iOS Safari,
// where users install via the Share sheet instead).
function InstallButton() {
  const [prompt, setPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    if (standalone) { setInstalled(true); return; }
    const onPrompt = (e) => { e.preventDefault(); setPrompt(e); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  if (installed || !prompt) return null;
  return (
    <button className="btn btn-accent btn-sm" style={{ width: "100%", marginTop: 8 }}
      onClick={async () => { prompt.prompt(); try { await prompt.userChoice; } catch (e) {} setPrompt(null); }}>
      <Download size={14} /> Install app
    </button>
  );
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);
  const [habits, setHabits] = useState([]);
  const [log, setLog] = useState({});
  const [settings, setSettings] = useState({ contexts: DEFAULT_CONTEXTS, lastReview: null });
  const [areas, setAreas] = useState([]);
  const [horizons, setHorizons] = useState({ goals: [], vision: [], purpose: [] });
  const [game, setGame] = useState({ xp: 0, gtd: 0, ownedCosmetics: ["av-f-survivor", "av-m-survivor", "theme-settlement"], equipped: { avatar: "av-f-survivor", theme: "theme-settlement" }, lastTended: null, siegeBrokenAt: null, inSiege: false });
  const [toasts, setToasts] = useState([]);

  const [view, setView] = useState("today");
  const [capture, setCapture] = useState("");
  const [clarifyId, setClarifyId] = useState(null);
  const [ctxFilter, setCtxFilter] = useState("all");
  const [expanded, setExpanded] = useState({});
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [lastCloudSync, setLastCloudSync] = useState(null);
  const [editId, setEditId] = useState(null);
  const [ctxMgrOpen, setCtxMgrOpen] = useState(false);
  const [openArea, setOpenArea] = useState(null);
  const [meta, setMeta] = useState({ version: APP_VERSION, name: "" });
  const [onboarding, setOnboarding] = useState(false);
  const [whatsNew, setWhatsNew] = useState(null); // array of {version, notes} or null
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile nav drawer
  const captureRef = useRef(null);
  const aside_touchX = useRef(null);

  // stateRef always holds the latest committed values of every data slice.
  // snapshot() reads from here so it's never one render behind (the stale
  // closure problem that caused pushed data to be missing the latest change).
  const stateRef = useRef({ items:[], projects:[], habits:[], log:{}, settings:{ contexts: DEFAULT_CONTEXTS, lastReview: null }, areas:[], horizons:{ goals:[], vision:[], purpose:[] }, game:{ xp:0, gtd:0, ownedCosmetics:["av-f-survivor","av-m-survivor","theme-settlement"], equipped:{ avatar:"av-f-survivor", theme:"theme-settlement" }, lastTended:null, siegeBrokenAt:null, inSiege:false }, meta:{ version: APP_VERSION, name:"" } });

  // ---- load (with version detection + migrations) ----
  useEffect(() => {
    (async () => {
      // load everything first
      const loaded = {
        items: await store.load(KEYS.items, []),
        projects: await store.load(KEYS.projects, []),
        habits: await store.load(KEYS.habits, []),
        log: await store.load(KEYS.log, {}),
        settings: await store.load(KEYS.settings, { contexts: DEFAULT_CONTEXTS, lastReview: null }),
        areas: await store.load(KEYS.areas, []),
        horizons: await store.load(KEYS.horizons, { goals: [], vision: [], purpose: [] }),
        game: await store.load(KEYS.game, { xp: 0, gtd: 0, ownedCosmetics: ["av-f-survivor", "av-m-survivor", "theme-settlement"], equipped: { avatar: "av-f-survivor", theme: "theme-settlement" }, lastTended: null, siegeBrokenAt: null, inSiege: false }),
      };
      const savedMeta = await store.load(KEYS.meta, null);

      // decide: new user, returning-outdated, or current
      const isNew = !savedMeta || typeof savedMeta.version !== "number";
      if (isNew) {
        // brand-new: stamp current version, open onboarding
        const m = { version: APP_VERSION, name: "", createdAt: Date.now(), journeyStarted: Date.now() };
        setMeta(m); store.save(KEYS.meta, m);
        applyLoaded(loaded);
        setOnboarding(true);
      } else if (savedMeta.version < APP_VERSION) {
        // returning on an old save: migrate data, persist, show What's New
        const { data, pending } = runMigrations(loaded, savedMeta.version);
        applyLoaded(data);
        // persist any reshaped slices
        store.save(KEYS.game, data.game);
        store.save(KEYS.horizons, data.horizons);
        store.save(KEYS.settings, data.settings);
        const m = { ...savedMeta, version: APP_VERSION, journeyStarted: savedMeta.journeyStarted || savedMeta.createdAt || Date.now(), updatedAt: savedMeta.updatedAt || savedMeta.journeyStarted || savedMeta.createdAt || Date.now() };
        setMeta(m); store.save(KEYS.meta, m);
        if (pending.length) setWhatsNew(pending);
      } else {
        // up to date
        setMeta(savedMeta);
        applyLoaded(loaded);
      }
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- simple sync engine ------------------------------------------------
  // Cloud is the single source of truth when signed in.
  //   • On sign-in / app-open: pull from cloud. Seed cloud if it's empty.
  //   • After any local change: push immediately (no debounce).
  // ---- sync engine: higher XP wins, no prompts, no loops -----------------
  // Three rules that prevent the feedback loop:
  //   1. applyBlob sets isApplying=true so the push-on-change effect skips,
  //      breaking the pull→push→Realtime→pull cycle.
  //   2. Equal XP means already in sync — do nothing (not "apply cloud").
  //   3. Realtime uses the payload data directly — no re-fetch, no XP compare,
  //      just apply what the other device already saved.

  const xpOf = (b) => (b?.game?.xp) || 0;
  // Content count used as tiebreaker when XP is equal — catches inbox items,
  // projects, areas, and waiting-for entries which don't generate XP.
  const countOf = (b) => (b?.items?.length || 0) + (b?.projects?.length || 0) + (b?.areas?.length || 0);
  // Reads from stateRef so it is always current even in async/stale-closure contexts.
  const snapshot = () => ({ version: APP_VERSION, ...stateRef.current });

  function applyLoaded(d) {
    setItems(d.items); setProjects(d.projects); setHabits(d.habits); setLog(d.log);
    setSettings(d.settings); setAreas(d.areas); setHorizons(d.horizons); setGame(d.game);
    // seed stateRef so snapshot() is immediately correct after load
    stateRef.current = { items: d.items, projects: d.projects, habits: d.habits, log: d.log,
      settings: d.settings, areas: d.areas, horizons: d.horizons, game: d.game, meta: stateRef.current.meta };
  }

  // Guard: true while we're applying a cloud blob. The push-on-change effect
  // checks this and skips, so a pull never causes a push.
  const isApplying = useRef(false);

  const applyBlob = (blob) => {
    let b = { items: blob.items||[], projects: blob.projects||[], habits: blob.habits||[],
      log: blob.log||{}, settings: blob.settings||{ contexts: DEFAULT_CONTEXTS, lastReview: null },
      areas: blob.areas||[], horizons: blob.horizons||{ goals:[], vision:[], purpose:[] }, game: blob.game||game };
    const fromV = typeof blob.version === "number" ? blob.version : 0;
    if (fromV < APP_VERSION) b = runMigrations(b, fromV).data;
    isApplying.current = true;
    saveItems(b.items); saveProjects(b.projects); saveHabits(b.habits);
    saveLog(b.log); saveSettings(b.settings); saveAreas(b.areas);
    saveHorizons(b.horizons); saveGame(b.game);
    // Each save* call above updates stateRef so snapshot() is immediately current.
    if (blob.meta) {
      saveMeta({ ...blob.meta, version: Math.max(APP_VERSION, blob.meta.version || 0) });
    }
    // Reset isApplying after React's batch flush so the push effect skips this cycle.
    setTimeout(() => { isApplying.current = false; }, 0);
  };

  // On open / focus / manual: compare XP, highest wins. Equal = already in sync.
  const syncWithCloud = async (sess) => {
    const s = sess || session;
    if (!syncEnabled || !s || !loaded) return;
    setSyncBusy(true);
    const cloud = await cloudLoad(s.user.id);
    const localXP = xpOf(snapshot());
    const cloudXP = xpOf(cloud?.data);
    const localCount = countOf(snapshot());
    const cloudCount  = countOf(cloud?.data);
    if (!cloud || localXP > cloudXP || (localXP === cloudXP && localCount > cloudCount)) {
      // local wins: more XP, or equal XP but more content (inbox/projects/areas)
      if (localXP > 0 || localCount > 0) await cloudSave(s.user.id, snapshot());
    } else if (cloudXP > localXP || (localXP === cloudXP && cloudCount > localCount)) {
      // cloud wins: more XP, or equal XP but more content on cloud side
      applyBlob(cloud.data);
    }
    // truly equal on both XP and count → already in sync, nothing to do
    setLastCloudSync(Date.now());
    setSyncBusy(false);
  };

  // Realtime: another device saved. Use the payload data directly — no re-fetch,
  // no XP comparison, just apply. The isApplying guard prevents this from
  // triggering a push back to the cloud.
  const applyRealtimeData = (data) => {
    if (!data) return;
    const remoteXP    = xpOf(data);
    const remoteCount = countOf(data);
    const localXP     = xpOf(snapshot());
    const localCount  = countOf(snapshot());
    // Apply if remote has more XP, or equal XP but more content
    if (remoteXP > localXP || (remoteXP === localXP && remoteCount > localCount)) {
      applyBlob(data);
      setLastCloudSync(Date.now());
    }
  };

  // Push immediately after any user-driven local change (skipped during applyBlob)
  const pushCloud = async (sess) => {
    const s = sess || session;
    if (!syncEnabled || !s || !loaded) return;
    const snap = snapshot();
    if (xpOf(snap) === 0) return;
    setSyncBusy(true);
    const ts = await cloudSave(s.user.id, snap);
    if (ts) setLastCloudSync(Date.now());
    setSyncBusy(false);
  };

  const doSignOut = async () => { await signOut(); setSession(null); setLastCloudSync(null); };
  const manualSync = () => { if (session && loaded) syncWithCloud(session); };

  // Auth: restore session, defer sync until local data is loaded
  const pendingSync = useRef(null);
  useEffect(() => {
    if (!syncEnabled) return;
    let unsub = () => {};
    (async () => {
      const sess = await getSession();
      if (sess) { pendingSync.current = sess; setSession(sess); }
      unsub = onAuthChange((s, event) => {
        setSession(s);
        if (s && event !== "TOKEN_REFRESHED") pendingSync.current = s;
      });
    })();
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!syncEnabled || !loaded || !pendingSync.current) return;
    const sess = pendingSync.current;
    pendingSync.current = null;
    syncWithCloud(sess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, session]);

  // Realtime: another device saved → apply their data directly from payload
  useEffect(() => {
    if (!syncEnabled || !session || !loaded) return;
    const unsub = subscribeRealtime(session.user.id, (data) => {
      applyRealtimeData(data);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, loaded]);

  // Focus / visibility: sync on foregrounding (10s gap)
  const lastSync = useRef(0);
  useEffect(() => {
    if (!syncEnabled) return;
    const doSync = () => {
      if (!session || !loaded) return;
      const now = Date.now();
      if (now - lastSync.current < 10_000) return;
      lastSync.current = now;
      syncWithCloud(session);
    };
    const onVis = () => { if (document.visibilityState === "visible") doSync(); };
    window.addEventListener("focus", doSync);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("focus", doSync); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, loaded]);

  // Push after any user-driven data change (skipped when isApplying is true)
  const firstChange = useRef(true);
  useEffect(() => {
    if (!loaded) return;
    if (firstChange.current) { firstChange.current = false; return; }
    if (isApplying.current) return; // cloud pull in progress — don't echo it back
    const stamped = { ...stateRef.current.meta, updatedAt: Date.now() };
    saveMeta(stamped); // updates stateRef.meta too, so snapshot() picks it up
    if (syncEnabled && session) pushCloud(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, projects, habits, log, settings, areas, horizons, game]);


  // ---- persisted setters — each also updates stateRef so snapshot() is never stale ----
  const saveItems    = (v) => { setItems(v);    store.save(KEYS.items, v);    stateRef.current = { ...stateRef.current, items: v }; };
  const saveProjects = (v) => { setProjects(v); store.save(KEYS.projects, v); stateRef.current = { ...stateRef.current, projects: v }; };
  const saveHabits   = (v) => { setHabits(v);   store.save(KEYS.habits, v);   stateRef.current = { ...stateRef.current, habits: v }; };
  const saveLog      = (v) => { setLog(v);       store.save(KEYS.log, v);      stateRef.current = { ...stateRef.current, log: v }; };
  const saveSettings = (v) => { setSettings(v); store.save(KEYS.settings, v); stateRef.current = { ...stateRef.current, settings: v }; };
  const saveAreas    = (v) => { setAreas(v);    store.save(KEYS.areas, v);    stateRef.current = { ...stateRef.current, areas: v }; };
  const saveHorizons = (v) => { setHorizons(v); store.save(KEYS.horizons, v); stateRef.current = { ...stateRef.current, horizons: v }; };
  const saveGame     = (v) => { setGame(v);     store.save(KEYS.game, v);     stateRef.current = { ...stateRef.current, game: v }; };
  const saveMeta     = (v) => { setMeta(v);     store.save(KEYS.meta, v);     stateRef.current = { ...stateRef.current, meta: v }; };

  // ---- onboarding completion: persist name + seed GVP into horizons ----
  const finishOnboarding = ({ name, goals, vision, purpose }) => {
    saveMeta({ ...meta, version: APP_VERSION, name: (name || "").trim() });
    const add = (arr, texts) => {
      const extra = (texts || []).filter((t) => t && t.trim()).map((t) => ({ id: uid(), text: t.trim(), areaId: null }));
      return [...(arr || []), ...extra];
    };
    const nh = {
      goals: add(horizons.goals, goals),
      vision: add(horizons.vision, vision),
      purpose: add(horizons.purpose, purpose),
    };
    saveHorizons(nh);
    setOnboarding(false);
  };

  // ---- survival rewards ----
  const pushToast = (msg) => {
    const id = uid();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };
  // award (or reclaim, with negative xp/gtd) — XP/₲ are clamped at 0 so a claw-back
  // can never drive a balance negative. XP is permanent and accrues even in siege;
  // the ₲ economy is frozen in siege (positive grants only).
  const award = (xp, gtd, msg, opts = {}) => {
    setGame((g) => {
      const siegeFrozen = g.inSiege && !opts.duringSiege;
      const ng = { ...g, lastTended: Date.now() };
      const beforeLvl = levelFromXP(g.xp);
      ng.xp = Math.max(0, g.xp + (xp || 0));
      // ₲ moves on grants always; on reclaims always (you can lose ₲ in siege, just not earn it)
      if (!siegeFrozen || (gtd || 0) < 0) ng.gtd = Math.max(0, g.gtd + (gtd || 0));
      store.save(KEYS.game, ng);
      const afterLvl = levelFromXP(ng.xp);
      if (msg) {
        const bits = [];
        if (xp) bits.push(`${xp > 0 ? "+" : ""}${xp} XP`);
        if (gtd && (!siegeFrozen || gtd < 0)) bits.push(`${gtd > 0 ? "+" : ""}${gtd} ₲`);
        pushToast(`${msg}${bits.length ? "  " + bits.join("  ") : ""}`);
      }
      if (afterLvl > beforeLvl) setTimeout(() => pushToast(`◆ Rank up — Level ${afterLvl}, ${rankFor(afterLvl)}`), 700);
      return ng;
    });
  };

  // ---- item ops ----
  const addCapture = () => {
    const t = capture.trim();
    if (!t) return;
    saveItems([{ id: uid(), title: t, notes: "", type: "inbox", createdAt: Date.now(), done: false }, ...items]);
    setCapture("");
    captureRef.current && captureRef.current.focus();
  };
  const updateItem = (id, patch) => saveItems(items.map((i) => i.id === id ? { ...i, ...patch } : i));
  const deleteItem = (id) => saveItems(items.filter((i) => i.id !== id));
  const toggleDone = (id) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const completing = !it.done;

    if (completing) {
      // compute and RECORD exactly what we grant, so a future restore reclaims the same amount
      const w = actionWeight(it, items);
      const tier = toneTier(w);
      const ax = actionXP(w), ag = actionGTD(w);

      // project-claim detection on the post-completion list
      let claim = null;
      if (it.projectId) {
        const remainingAfter = items.filter((i) => i.projectId === it.projectId && i.type === "next" && !i.done && i.id !== id).length;
        if (remainingAfter === 0) {
          const rooms = items.filter((i) => i.projectId === it.projectId && i.type === "next").length || 1;
          claim = { xp: 25 * Math.max(1, Math.round(rooms / 2)), gtd: 15 * rooms, proj: it.projectId };
        }
      }

      const patch = { done: true, completedAt: Date.now(), awarded: { xp: ax, gtd: ag }, claimAwarded: claim };
      let next = items.map((i) => i.id === id ? { ...i, ...patch } : i);
      if (it.recur) {
        // the respawned occurrence starts fresh with no award history
        const { awarded, claimAwarded, ...seed } = it;
        next = [{ ...seed, id: uid(), done: false, completedAt: null, createdAt: Date.now(),
          dueDate: it.dueDate ? nextRecurDate(it.dueDate, it.recur) : undefined }, ...next];
      }
      saveItems(next);

      award(ax, ag, `${TONE_META[tier].label} down`);
      if (claim) {
        const proj = projects.find((p) => p.id === claim.proj);
        setTimeout(() => award(claim.xp, claim.gtd, `Structure claimed: ${proj ? proj.title : "building"}`), 500);
      }
    } else {
      // RESTORE: reclaim exactly what was granted (recorded on the item), then clear the record
      const back = it.awarded || { xp: 0, gtd: 0 };
      const claimBack = it.claimAwarded || null;
      const patch = { done: false, completedAt: null, awarded: null, claimAwarded: null };
      saveItems(items.map((i) => i.id === id ? { ...i, ...patch } : i));
      const totXp = (back.xp || 0) + (claimBack ? claimBack.xp : 0);
      const totGtd = (back.gtd || 0) + (claimBack ? claimBack.gtd : 0);
      if (totXp || totGtd) award(-totXp, -totGtd, "Restored — reward reclaimed");
    }
  };

  const handleTransform = (next) => {
    const remainingInbox = items.filter((i) => i.type === "inbox" && i.id !== next.id).length;
    if (next._makeProject) {
      const pid = uid();
      saveProjects([{ id: pid, title: next.title, outcome: "", notes: next.notes || "", status: "active", createdAt: Date.now() }, ...projects]);
      deleteItem(next.id);
      setExpanded((e) => ({ ...e, [pid]: true }));
      setClarifyId(null);
      setView("projects");
      award(10, 0, "Threat identified → new structure");
      if (remainingInbox === 0) setTimeout(() => award(50, 20, "◆ Perimeter secure — the fog clears"), 500);
      return;
    }
    const { _makeProject, ...clean } = next;
    updateItem(next.id, clean);
    setClarifyId(null);
    award(10, 0, "Threat identified");
    if (remainingInbox === 0) setTimeout(() => award(50, 20, "◆ Perimeter secure — the fog clears"), 500);
  };

  // ---- project ops ----
  const addProject = (title) => {
    if (!title.trim()) return;
    saveProjects([{ id: uid(), title: title.trim(), outcome: "", notes: "", status: "active", createdAt: Date.now() }, ...projects]);
  };
  const updateProject = (id, patch) => saveProjects(projects.map((p) => p.id === id ? { ...p, ...patch } : p));
  const deleteProject = (id) => {
    saveProjects(projects.filter((p) => p.id !== id));
    saveItems(items.filter((i) => i.projectId !== id));
  };
  const addActionToProject = (pid, title, context) => {
    if (!title.trim()) return;
    saveItems([{ id: uid(), title: title.trim(), notes: "", type: "next", context, projectId: pid, createdAt: Date.now(), done: false, energy: "medium", time: "15m" }, ...items]);
  };
  const restoreItem = (id) => { const it = items.find((i) => i.id === id); if (it && it.done) toggleDone(id); };
  const reactivateProject = (id) => updateProject(id, { status: "active" });

  // ---- area ops (Horizon 2) ----
  const addArea = (title) => { if (!title.trim()) return; saveAreas([...areas, { id: uid(), title: title.trim(), notes: "", createdAt: Date.now() }]); };
  const updateArea = (id, patch) => saveAreas(areas.map((a) => a.id === id ? { ...a, ...patch } : a));
  const deleteArea = (id) => {
    saveAreas(areas.filter((a) => a.id !== id));
    saveProjects(projects.map((p) => p.areaId === id ? { ...p, areaId: null } : p)); // unfile, don't delete projects
    saveHorizons({ ...horizons, goals: (horizons.goals || []).map((g) => g.areaId === id ? { ...g, areaId: null } : g) });
    if (openArea === id) setOpenArea(null);
  };
  const assignProjectArea = (pid, areaId) => updateProject(pid, { areaId });

  // ---- horizon ops (3 Goals / 4 Vision / 5 Purpose) ----
  const addHorizon = (key, text, areaId) => {
    if (!text.trim()) return;
    saveHorizons({ ...horizons, [key]: [...(horizons[key] || []), { id: uid(), text: text.trim(), areaId: areaId || null }] });
  };
  const updateHorizon = (key, id, patch) => saveHorizons({ ...horizons, [key]: (horizons[key] || []).map((x) => x.id === id ? { ...x, ...patch } : x) });
  const deleteHorizon = (key, id) => saveHorizons({ ...horizons, [key]: (horizons[key] || []).filter((x) => x.id !== id) });

  // ---- habit ops ----
  const addHabit = (name, cadence, days) => {
    if (!name.trim()) return;
    saveHabits([...habits, { id: uid(), name: name.trim(), cadence, days: days || [], createdAt: Date.now() }]);
  };
  const deleteHabit = (id) => {
    saveHabits(habits.filter((h) => h.id !== id));
    const nl = { ...log };
    Object.keys(nl).forEach((k) => { if (k.startsWith(id + "|")) delete nl[k]; });
    saveLog(nl);
  };
  const updateHabit = (id, patch) => saveHabits(habits.map((h) => h.id === id ? { ...h, ...patch } : h));
  const toggleLog = (hid, ds) => {
    const k = hid + "|" + ds;
    const nl = { ...log };
    const prev = nl[k]; // truthy = done; may be an object with recorded award
    if (prev) {
      // un-toggling: reclaim exactly what this entry granted
      delete nl[k];
      saveLog(nl);
      const rec = (typeof prev === "object" && prev) ? prev : { xp: 5, gtd: 3 }; // legacy entries default
      const xp = (rec.xp || 0), gtd = (rec.gtd || 0);
      if (xp || gtd) award(-xp, -gtd, "Routine un-marked — reward reclaimed");
    } else {
      // toggling on — only today's routine earns (no backdate farming)
      const earns = ds === todayStr();
      if (earns) {
        const h = habits.find((x) => x.id === hid);
        const streak = h ? habitStreak(h, { ...nl, [k]: true }) : 0;
        const milestone = [7, 30, 100].includes(streak) ? streak : 0;
        const xp = 5 + milestone, gtd = 3 + milestone;
        nl[k] = { at: Date.now(), xp, gtd };
        saveLog(nl);
        award(5, 3, "Routine held");
        if (milestone) setTimeout(() => award(milestone, milestone, `◆ ${milestone}-day streak — the settlement endures`), 500);
      } else {
        nl[k] = { at: Date.now(), xp: 0, gtd: 0 };
        saveLog(nl);
      }
    }
  };

  // ---- weekly review payday (the boss) + siege break ----
  // Fortification can be raised only on the weekend (Fri/Sat/Sun) and only ONCE per
  // weekend window — completing it Friday locks it through Sunday.
  const reviewAllowed = () => {
    const now = new Date();
    const dow = now.getDay(); // 0 Sun .. 6 Sat
    const isWeekend = dow === 5 || dow === 6 || dow === 0;
    // Friday that anchors the current weekend window:
    //   Fri(5)→today, Sat(6)→yesterday, Sun(0)→2 days ago.
    const back = dow === 5 ? 0 : dow === 6 ? 1 : dow === 0 ? 2 : 0;
    const windowStart = new Date(now); windowStart.setDate(now.getDate() - back);
    const windowStartStr = isoDate(windowStart);
    const doneThisWeekend = !!settings.lastReview && isWeekend && settings.lastReview >= windowStartStr;
    return { isWeekend, doneThisWeekend, ok: isWeekend && !doneThisWeekend };
  };
  const completeReview = () => {
    const gate = reviewAllowed();
    if (!gate.ok) {
      pushToast(gate.doneThisWeekend ? "Already fortified this weekend. The walls hold." : "The fortification can only be raised on the weekend.");
      return;
    }
    const today = todayStr();
    saveSettings({ ...settings, lastReview: today });
    const wasSiege = game.inSiege;
    const ng = { ...game, lastTended: Date.now(), siegeBrokenAt: Date.now(), inSiege: false };
    ng.xp = game.xp + 200;
    ng.gtd = game.gtd + 100;
    saveGame(ng);
    pushToast("◆◆ SETTLEMENT FORTIFIED  +200 XP  +100 ₲");
    if (wasSiege) setTimeout(() => pushToast("The siege is broken. Dawn comes."), 800);
    const after = levelFromXP(ng.xp), before = levelFromXP(game.xp);
    if (after > before) setTimeout(() => pushToast(`◆ Rank up — Level ${after}, ${rankFor(after)}`), 1100);
  };

  // ---- cosmetics (avatars + themes) ----
  const ownsCosmetic = (id) => (game.ownedCosmetics || []).includes(id);
  const buyCosmetic = (item) => {
    if (ownsCosmetic(item.id) || game.gtd < item.cost || game.inSiege) return;
    saveGame({ ...game, gtd: game.gtd - item.cost, ownedCosmetics: [...(game.ownedCosmetics || []), item.id] });
    pushToast(`Acquired: ${item.name}`);
  };
  const equipCosmetic = (kind, item) => { // kind: "avatar" | "theme"
    if (!ownsCosmetic(item.id)) return;
    saveGame({ ...game, equipped: { ...game.equipped, [kind]: item.id } });
  };

  // ---- export / import ----
  const exportData = () => JSON.stringify({
    version: APP_VERSION, exportedAt: new Date().toISOString(), items, projects, habits, log, settings, areas, horizons, game, meta,
  }, null, 2);
  const importData = (text) => {
    try {
      const d = JSON.parse(text);
      // assemble a bundle, run migrations if the file predates the current app version
      let bundle = {
        items: d.items || [], projects: d.projects || [], habits: d.habits || [],
        log: d.log || {}, settings: d.settings || { contexts: DEFAULT_CONTEXTS, lastReview: null },
        areas: d.areas || [], horizons: d.horizons || { goals: [], vision: [], purpose: [] },
        game: d.game || game,
      };
      const fromV = typeof d.version === "number" ? d.version : 0;
      if (fromV < APP_VERSION) bundle = runMigrations(bundle, fromV).data;
      saveItems(bundle.items); saveProjects(bundle.projects); saveHabits(bundle.habits);
      saveLog(bundle.log); saveSettings(bundle.settings); saveAreas(bundle.areas);
      saveHorizons(bundle.horizons); saveGame(bundle.game);
      const importedMeta = d.meta && typeof d.meta === "object" ? d.meta : meta;
      saveMeta({ ...importedMeta, version: APP_VERSION });
      setExportOpen(false);
    } catch (e) { alert("Invalid file"); }
  };

  // ---- derived ----
  const itemById = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);
  // a task is blocked while any of its precursor tasks is not yet done
  const isBlocked = (i) => (i.blockedBy || []).some((bid) => { const b = itemById[bid]; return b && !b.done; });

  const inbox = items.filter((i) => i.type === "inbox");
  const nexts = items.filter((i) => i.type === "next" && !i.done && !isBlocked(i));
  const blockedCount = items.filter((i) => i.type === "next" && !i.done && isBlocked(i)).length;
  const waiting = items.filter((i) => i.type === "waiting" && !i.done);
  const somedays = items.filter((i) => i.type === "someday");
  const refs = items.filter((i) => i.type === "reference");
  const scheduled = items.filter((i) => i.type === "calendar" && !i.done).sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const activeProjects = projects.filter((p) => p.status === "active");
  const projectNexts = (pid) => items.filter((i) => i.projectId === pid && i.type === "next" && !i.done);
  // stalled = no *actionable* (unblocked) next action
  const stalled = activeProjects.filter((p) => projectNexts(p.id).filter((i) => !isBlocked(i)).length === 0);

  const completedItems = items.filter((i) => i.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const completedProjects = projects.filter((p) => p.status === "complete");

  const contexts = settings.contexts || DEFAULT_CONTEXTS;
  const filteredNexts = ctxFilter === "all" ? nexts : nexts.filter((i) => i.context === ctxFilter);
  const nextsByCtx = useMemo(() => {
    const g = {};
    filteredNexts.forEach((i) => { (g[i.context || "@anywhere"] ||= []).push(i); });
    return g;
  }, [filteredNexts]);

  const todayHabits = habits.filter((h) => isScheduled(h, todayStr()));
  const daysSinceReview = settings.lastReview ? daysBetween(settings.lastReview, todayStr()) : null;

  const clarifyItem = items.find((i) => i.id === clarifyId);
  const editItem = items.find((i) => i.id === editId);
  const projName = (id) => projects.find((p) => p.id === id)?.title;

  // ---- live threat (computed, never stored as a free number) ----
  const threat = useMemo(() => threatBreakdown({
    items, projects, habits, log, lastReview: settings.lastReview, lastTended: game.lastTended, siegeBrokenAt: game.siegeBrokenAt, journeyStarted: meta.journeyStarted,
  }), [items, projects, habits, log, settings.lastReview, game.lastTended, game.siegeBrokenAt, meta.journeyStarted]);
  const band = threatBand(threat.value);

  // siege latch: enter at 100, exit handled by review or dropping below 70
  useEffect(() => {
    if (!loaded) return;
    if (threat.value >= 100 && !game.inSiege) {
      saveGame({ ...game, inSiege: true });
      pushToast("⚠ THE WALL IS BREACHED — UNDER SIEGE");
    } else if (game.inSiege && threat.value < 70) {
      saveGame({ ...game, inSiege: false, siegeBrokenAt: Date.now() });
      pushToast("You've pushed them back. The siege lifts.");
    }
  }, [threat.value, loaded]);

  const lvl = levelProgress(game.xp);
  const rank = rankFor(lvl.level);
  const goWatch = () => setView("watchtower");

  if (!loaded) {
    return (
      <div className="gtd" style={{ height: 720, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{STYLE}</style>
        <div className="serif" style={{ color: "var(--muted)" }}>Opening your system…</div>
      </div>
    );
  }

  const NAV = [
    { id: "watchtower", label: "The Watchtower", icon: Radar },
    { id: "today", label: "Today", icon: Sun },
    { id: "inbox", label: "Inbox", icon: Inbox, count: inbox.length, hot: inbox.length > 0 },
    { id: "next", label: "Next Actions", icon: Zap, count: nexts.length },
    { id: "projects", label: "Projects", icon: FolderKanban, count: activeProjects.length, warn: stalled.length },
    { id: "waiting", label: "Waiting For", icon: Hourglass, count: waiting.length },
    { id: "calendar", label: "Scheduled", icon: Calendar, count: scheduled.length },
    { id: "someday", label: "Someday / Maybe", icon: Moon, count: somedays.length },
    { id: "reference", label: "Reference", icon: BookOpen, count: refs.length },
    { section: "Higher Horizons" },
    { id: "areas", label: "Areas of Focus", icon: Compass, count: areas.length },
    { id: "horizons", label: "Goals · Vision · Purpose", icon: Mountain },
    { section: "Practice" },
    { id: "habits", label: "Habits", icon: Repeat, count: habits.length },
    { id: "review", label: "Weekly Review", icon: ListChecks },
    { id: "archive", label: "Archive", icon: Archive, count: completedItems.length },
  ];

  return (
    <>
    {/* Sign-in gate: no app without an account */}
    {syncEnabled && !session && (
      <div className="gtd app-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", flexDirection: "column", gap: 20 }}>
        <style>{STYLE}</style>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--pine)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Sparkles size={24} color="#fbf9f4" />
          </div>
          <div>
            <div className="serif" style={{ fontSize: 26, lineHeight: 1 }}>Clearmind</div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: 1 }}>GTD · SURVIVAL</div>
          </div>
        </div>
        <p style={{ fontSize: 14, color: "var(--ink2)", textAlign: "center", maxWidth: 280, margin: 0, lineHeight: 1.5 }}>
          Sign in to sync your settlement across every device.
        </p>
        {syncBusy
          ? <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>Signing in…</div>
          : <button className="btn btn-accent" style={{ minWidth: 220 }} onClick={() => signInWithGoogle()}>
              <Link2 size={16} /> Sign in with Google
            </button>}
      </div>
    )}
    {(!syncEnabled || session) && (
    <div className={"gtd app-shell" + (game.inSiege ? " siege" : "") + (drawerOpen ? " drawer-open" : "")}
      style={!game.inSiege && themeById(game.equipped?.theme).vars ? themeById(game.equipped.theme).vars : undefined}>
      <style>{STYLE}</style>

      {/* Mobile backdrop — tap to close the drawer */}
      <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />

      {/* SIDEBAR (permanent on desktop, drawer on mobile) */}
      <aside className="sidebar" onTouchStart={(e) => { aside_touchX.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => { if (aside_touchX.current != null && e.changedTouches[0].clientX < aside_touchX.current - 50) setDrawerOpen(false); aside_touchX.current = null; }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 6px 16px" }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: "var(--pine)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Sparkles size={17} color="#fbf9f4" />
          </div>
          <div>
            <div className="serif" style={{ fontSize: 17, lineHeight: 1, fontWeight: 600 }}>Clearmind</div>
            <div className="mono" style={{ fontSize: 9.5, color: "var(--muted)", letterSpacing: 1 }}>GTD · HABITS</div>
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map((n, idx) => {
            if (n.section) return (
              <div key={"s" + idx} className="mono" style={{ fontSize: 9, color: "var(--muted)", letterSpacing: 1.2, padding: "12px 8px 4px" }}>{n.section.toUpperCase()}</div>
            );
            const I = n.icon;
            return (
              <button key={n.id} className={"nav" + (view === n.id ? " active" : "")} onClick={() => { setView(n.id); setDrawerOpen(false); }}>
                <I size={17} className="ico" />
                <span>{n.label}</span>
                {n.warn ? <span className="count hot" title="stalled projects">{n.warn}!</span>
                  : (n.count > 0 ? <span className={"count" + (n.hot ? " hot" : "")}>{n.count}</span> : null)}
              </button>
            );
          })}
        </nav>
        <div style={{ marginTop: "auto", paddingTop: 14 }}>
          <button className="btn btn-sm" style={{ width: "100%" }} onClick={() => { setSettingsOpen(true); setDrawerOpen(false); }}>
            <Settings2 size={14} /> Settings
          </button>
          <InstallButton />
          {daysSinceReview !== null && daysSinceReview >= 7 && (
            <div onClick={() => setView("review")} className="mono" style={{ cursor: "pointer", marginTop: 10, fontSize: 10.5, color: "var(--clay)", textAlign: "center" }}>
              Review due ({daysSinceReview}d ago)
            </div>
          )}
        </div>
      </aside>

      {/* MAIN */}
      <main className="main-col" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* MOBILE TOP BAR — hamburger to open the drawer; hidden on desktop */}
        <div className="mobile-topbar">
          <button className="hamburger" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <Menu size={20} />
          </button>
          <span className="serif" style={{ fontSize: 17, fontWeight: 600 }}>Clearmind</span>
        </div>

        {/* STATUS STRIP — glanceable, doorway to the Watchtower */}
        <StatusStrip threat={threat} band={band} lvl={lvl} rank={rank} gtd={game.gtd} siege={game.inSiege} onClick={goWatch} />

        {/* CAPTURE BAR — always present */}
        <div style={{ padding: "14px 22px", borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
          <div style={{ display: "flex", gap: 9 }}>
            <input ref={captureRef} className="input" placeholder="Capture anything on your mind — press Enter…"
              value={capture} onChange={(e) => setCapture(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCapture()} autoFocus />
            <button className="btn btn-accent" onClick={addCapture}><Send size={15} /> Capture</button>
          </div>
        </div>

        <div className="content-scroll" style={{ flex: 1, overflow: "auto", padding: "22px" }}>
          {view === "watchtower" && <Watchtower {...{ threat, band, lvl, rank, game, items, projects, nexts, stalled, daysSinceReview, settings, setView, setClarifyId, onEdit: setEditId, buyCosmetic, equipCosmetic }} />}
          {view === "today" && <TodayView {...{ inbox, nextsByCtx, filteredNexts, scheduled, todayHabits, log, toggleLog, stalled, setView, toggleDone, projName, daysSinceReview, onEdit: setEditId, items, name: meta.name }} />}
          {view === "inbox" && <InboxView {...{ inbox, setClarifyId }} />}
          {view === "next" && <NextView {...{ nextsByCtx, contexts, ctxFilter, setCtxFilter, toggleDone, projName, count: filteredNexts.length, blockedCount, onEdit: setEditId, onManageCtx: () => setCtxMgrOpen(true), items }} />}
          {view === "projects" && <ProjectsView {...{ activeProjects, allItems: items, projectNexts, expanded, setExpanded, addProject, updateProject, deleteProject, addActionToProject, toggleDone, updateItem, isBlocked, contexts, onEdit: setEditId, areas, assignProjectArea }} />}
          {view === "waiting" && <WaitingView {...{ waiting, toggleDone, updateItem, deleteItem, onEdit: setEditId }} />}
          {view === "calendar" && <CalendarView {...{ scheduled, toggleDone, deleteItem, onEdit: setEditId }} />}
          {view === "someday" && <SomedayView {...{ somedays, updateItem, deleteItem, onEdit: setEditId }} />}
          {view === "reference" && <ReferenceView {...{ refs, deleteItem, updateItem, onEdit: setEditId }} />}
          {view === "habits" && <HabitsView {...{ habits, log, toggleLog, addHabit, deleteHabit, updateHabit, purposes: horizons.purpose || [], setView }} />}
          {view === "review" && <ReviewView {...{ inbox, nexts, waiting, stalled, somedays, setView, settings, daysSinceReview, completeReview, siege: game.inSiege, gate: reviewAllowed() }} />}
          {view === "archive" && <ArchiveView {...{ completedItems, completedProjects, projName, restoreItem, deleteItem, reactivateProject, deleteProject }} />}
          {view === "areas" && <AreasView {...{ areas, projects, activeProjects, projectNexts, isBlocked, addArea, updateArea, deleteArea, assignProjectArea, toggleDone, openArea, setOpenArea, onEdit: setEditId, horizons, setView }} />}
          {view === "horizons" && <HorizonsView {...{ horizons, areas, addHorizon, updateHorizon, deleteHorizon, setView, setOpenArea }} />}
        </div>
      </main>

      {/* TOASTS */}
      <div className="toast">
        {toasts.map((t) => <div key={t.id} className="t">{t.msg}</div>)}
      </div>

      {clarifyItem && (
        <Clarify item={clarifyItem} contexts={contexts} onClose={() => setClarifyId(null)}
          onTransform={handleTransform} onDelete={(id) => { deleteItem(id); setClarifyId(null); }} />
      )}
      {editItem && (
        <EditItem item={editItem} contexts={contexts} onClose={() => setEditId(null)}
          onSave={(id, patch) => { updateItem(id, patch); setEditId(null); }}
          onDelete={(id) => { deleteItem(id); setEditId(null); }} />
      )}
      {ctxMgrOpen && (
        <ContextManager contexts={contexts} onClose={() => setCtxMgrOpen(false)}
          onSave={(list) => { saveSettings({ ...settings, contexts: list }); setCtxMgrOpen(false); }} />
      )}
      {exportOpen && <ExportModal text={exportData()} onClose={() => setExportOpen(false)} onImport={importData} />}
      {settingsOpen && <SettingsModal meta={meta} onSaveName={(nm) => saveMeta({ ...meta, name: nm })}
        onOpenExport={() => { setSettingsOpen(false); setExportOpen(true); }} onClose={() => setSettingsOpen(false)}
        syncEnabled={syncEnabled} session={session} syncBusy={syncBusy} lastCloudSync={lastCloudSync}
        onSignOut={doSignOut} onManualSync={manualSync} />}
      {onboarding && <WelcomeModal onFinish={finishOnboarding} />}
      {!onboarding && whatsNew && <WhatsNewModal name={meta.name} entries={whatsNew} onClose={() => setWhatsNew(null)} />}
    </div>
    )}
    </>
  );
}

/* ============================================================================
   VIEWS
============================================================================ */
function SectionTitle({ children, sub }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h1 className="serif" style={{ fontSize: 27, fontWeight: 600, margin: 0, lineHeight: 1.1 }}>{children}</h1>
      {sub && <div style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ActionRow({ item, toggleDone, projName, showCtx, onEdit, items }) {
  const w = items ? actionWeight(item, items) : null;
  const tier = w != null ? toneTier(w) : null;
  const meta = tier ? TONE_META[tier] : null;
  return (
    <div className="row act-row">
      <div className={"checkbox" + (item.done ? " done" : "")} onClick={() => toggleDone(item.id)}>
        {item.done && <Check size={13} color="#fbf9f4" />}
      </div>
      <div style={{ flex: 1, minWidth: 0, cursor: onEdit ? "pointer" : "default" }} onClick={() => onEdit && onEdit(item.id)}>
        <div style={{ fontSize: 14, textDecoration: item.done ? "line-through" : "none", color: item.done ? "var(--muted)" : "var(--ink)", display: "flex", alignItems: "center", gap: 7 }}>
          {meta && <span title={`${meta.label} — ${encounterLine(tier, item.title.length)}`} style={{ color: meta.color, fontWeight: 700, flexShrink: 0 }}>{meta.sigil}</span>}
          {item.title}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap", alignItems: "center" }}>
          {showCtx && item.context && <span className="pill pill-ctx">{item.context}</span>}
          {item.energy && <span className="pill">{item.energy}</span>}
          {item.time && <span className="pill">{item.time}</span>}
          {item.recur && <span className="pill" style={{ color: "var(--clay)" }}><Repeat size={9} style={{ verticalAlign: -1 }} /> {item.recur}</span>}
          {item.dueDate && <span className="pill">{relDate(item.dueDate)}</span>}
          {meta && <span className="mono" style={{ fontSize: 10, color: meta.color }}>{meta.label}</span>}
          {item.projectId && projName && projName(item.projectId) && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>↳ {projName(item.projectId)}</span>
          )}
        </div>
      </div>
      {onEdit && <button className="btn btn-ghost btn-sm edit-btn" onClick={() => onEdit(item.id)}><Pencil size={13} /></button>}
    </div>
  );
}

function TodayView({ inbox, nextsByCtx, filteredNexts, scheduled, todayHabits, log, toggleLog, stalled, setView, toggleDone, projName, daysSinceReview, onEdit, items, name }) {
  const todayScheduled = scheduled.filter((i) => i.dueDate <= todayStr());
  const first = (name || "").trim().split(" ")[0];
  return (
    <div className="stagger">
      <SectionTitle sub={new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}>
        {first ? `Good to see you, ${first}` : "Good to see you"}
      </SectionTitle>

      {inbox.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 16, borderColor: "var(--clay)", background: "var(--clay-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13.5 }}>You have <b>{inbox.length}</b> unprocessed {inbox.length === 1 ? "item" : "items"} in your inbox.</span>
            <button className="btn btn-clay btn-sm" onClick={() => setView("inbox")}>Clarify now <ArrowRight size={13} /></button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="serif" style={{ fontSize: 16 }}><Zap size={14} style={{ verticalAlign: -2, color: "var(--pine)" }} /> Next Actions</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{filteredNexts.length}</span>
          </div>
          {filteredNexts.length === 0 ? <Empty icon={Zap} title="Nothing queued" sub="Process your inbox to surface actions." />
            : filteredNexts.slice(0, 8).map((i) => <ActionRow key={i.id} item={i} toggleDone={toggleDone} projName={projName} showCtx onEdit={onEdit} items={items} />)}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <span className="serif" style={{ fontSize: 16 }}><Repeat size={14} style={{ verticalAlign: -2, color: "var(--clay)" }} /> Today's Habits</span>
            </div>
            {todayHabits.length === 0 ? <div style={{ padding: 16, fontSize: 13, color: "var(--muted)" }}>No habits scheduled today.</div>
              : todayHabits.map((h) => {
                const done = !!log[h.id + "|" + todayStr()];
                return (
                  <div key={h.id} className="row" style={{ alignItems: "center" }}>
                    <div className={"checkbox" + (done ? " done" : "")} onClick={() => toggleLog(h.id, todayStr())}>{done && <Check size={13} color="#fbf9f4" />}</div>
                    <span style={{ flex: 1, fontSize: 13.5, color: done ? "var(--muted)" : "var(--ink)", textDecoration: done ? "line-through" : "none" }}>{h.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--clay)" }}><Flame size={11} style={{ verticalAlign: -1 }} /> {habitStreak(h, log)}</span>
                  </div>
                );
              })}
          </div>

          {(todayScheduled.length > 0) && (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <span className="serif" style={{ fontSize: 16 }}><Calendar size={14} style={{ verticalAlign: -2, color: "var(--pine)" }} /> Due / Scheduled</span>
              </div>
              {todayScheduled.map((i) => (
                <div key={i.id} className="row" style={{ alignItems: "center" }}>
                  <div className="checkbox" onClick={() => toggleDone(i.id)} />
                  <span style={{ flex: 1, fontSize: 13.5 }}>{i.title}</span>
                  <span className="pill" style={{ color: i.dueDate < todayStr() ? "var(--clay)" : "var(--ink2)" }}>{relDate(i.dueDate)}</span>
                </div>
              ))}
            </div>
          )}

          {stalled.length > 0 && (
            <div onClick={() => setView("projects")} className="card" style={{ padding: 13, cursor: "pointer", display: "flex", gap: 9, alignItems: "center" }}>
              <AlertTriangle size={16} color="var(--clay)" />
              <span style={{ fontSize: 13 }}><b>{stalled.length}</b> {stalled.length === 1 ? "project has" : "projects have"} no next action.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InboxView({ inbox, setClarifyId }) {
  return (
    <div className="stagger">
      <SectionTitle sub="Empty your head here, then clarify each item: trash, do, defer, delegate, or file.">Inbox <span className="subq">THE FOG</span></SectionTitle>
      {inbox.length === 0 ? <Empty icon={Inbox} title="Inbox zero" sub="Nothing to process. Mind like water." />
        : <div className="card" style={{ overflow: "hidden" }}>
          {inbox.map((i) => (
            <div key={i.id} className="row" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => setClarifyId(i.id)}>
              <Inbox size={15} color="var(--muted)" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14 }}>{i.title}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>{relDate(isoDate(new Date(i.createdAt)))}</div>
              </div>
              <button className="btn btn-accent btn-sm">Clarify <ArrowRight size={12} /></button>
            </div>
          ))}
        </div>}
    </div>
  );
}

function NextView({ nextsByCtx, contexts, ctxFilter, setCtxFilter, toggleDone, projName, count, blockedCount, onEdit, onManageCtx, items }) {
  const keys = Object.keys(nextsByCtx).sort();
  return (
    <div className="stagger">
      <SectionTitle sub="What you can actually do, grouped by context. Filter to where you are right now.">Next Actions <span className="subq">THE FIELD</span></SectionTitle>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <Filter size={14} color="var(--muted)" />
        <Pill on={ctxFilter === "all"} onClick={() => setCtxFilter("all")}>all</Pill>
        {contexts.map((c) => <Pill key={c} on={ctxFilter === c} onClick={() => setCtxFilter(c)}>{c}</Pill>)}
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={onManageCtx}><Settings2 size={13} /> Contexts</button>
      </div>
      {blockedCount > 0 && (
        <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, display: "flex", alignItems: "center", gap: 5 }}>
          <Lock size={11} /> {blockedCount} action{blockedCount > 1 ? "s" : ""} hidden — waiting on a precursor in their project
        </div>
      )}
      {count === 0 ? <Empty icon={Zap} title="No actions here" sub="Process the inbox or change the filter." />
        : keys.map((k) => (
          <div key={k} style={{ marginBottom: 16 }}>
            <div className="mono pill pill-ctx" style={{ display: "inline-block", marginBottom: 8 }}>{k}</div>
            <div className="card" style={{ overflow: "hidden" }}>
              {nextsByCtx[k].map((i) => <ActionRow key={i.id} item={i} toggleDone={toggleDone} projName={projName} onEdit={onEdit} items={items} />)}
            </div>
          </div>
        ))}
    </div>
  );
}

function ProjectsView({ activeProjects, allItems, projectNexts, expanded, setExpanded, addProject, updateProject, deleteProject, addActionToProject, toggleDone, updateItem, isBlocked, contexts, onEdit, areas, assignProjectArea }) {
  const [np, setNp] = useState("");
  const [menuFor, setMenuFor] = useState(null); // project id whose settings menu is open
  const [menuPos, setMenuPos] = useState(null); // {top,right} anchor for the fixed popover
  const [confirmDel, setConfirmDel] = useState(null); // project id pending delete confirm
  const areaName = (id) => areas.find((a) => a.id === id)?.title;
  const menuProject = activeProjects.find((p) => p.id === menuFor);
  return (
    <>
    <div className="stagger">
      <SectionTitle sub="Any outcome needing more than one step. Chain tasks with precursors so only what's truly doable surfaces as a next action.">Projects <span className="subq">INFESTED STRUCTURES</span></SectionTitle>
      <div style={{ display: "flex", gap: 9, marginBottom: 18 }}>
        <input className="input" placeholder="New project — desired outcome…" value={np}
          onChange={(e) => setNp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { addProject(np); setNp(""); } }} />
        <button className="btn btn-accent" onClick={() => { addProject(np); setNp(""); }}><Plus size={15} /> Add</button>
      </div>
      {activeProjects.length === 0 ? <Empty icon={FolderKanban} title="No active projects" />
        : activeProjects.map((p) => {
          const acts = projectNexts(p.id);
          const actionable = acts.filter((i) => !isBlocked(i)).length;
          const open = expanded[p.id];
          const isStalled = actionable === 0;
          return (
            <div key={p.id} className="card" style={{ marginBottom: 12, overflow: "hidden", borderColor: isStalled && acts.length ? "var(--clay)" : "var(--line)" }}>
              <div className="row" style={{ alignItems: "center", borderBottom: open ? "1px solid var(--line)" : "none" }}>
                <button className="btn-ghost btn" style={{ padding: 4 }} onClick={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}>
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div style={{ flex: 1 }}>
                  <div className="serif" style={{ fontSize: 16 }}>{p.title}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: isStalled && acts.length ? "var(--clay)" : "var(--muted)", marginTop: 2 }}>
                    {acts.length === 0 ? "⚠ needs a next action"
                      : isStalled ? "⚠ all tasks blocked — check the chain"
                      : `${actionable} actionable · ${acts.length} open`}
                    {areaName(p.areaId) && <span> · <Compass size={9} style={{ verticalAlign: -1 }} /> {areaName(p.areaId)}</span>}
                  </div>
                </div>
                <div>
                  <button className="btn btn-sm btn-ghost" title="Project settings"
                    onClick={(e) => {
                      if (menuFor === p.id) { setMenuFor(null); return; }
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
                      setMenuFor(p.id); setConfirmDel(null);
                    }}>
                    <Settings2 size={14} />
                  </button>
                </div>
              </div>
              {open && <ProjectBody p={p} acts={acts} addActionToProject={addActionToProject} toggleDone={toggleDone}
                updateItem={updateItem} isBlocked={isBlocked} allItems={allItems} contexts={contexts} onEdit={onEdit} />}
            </div>
          );
        })}
    </div>

    {/* Settings popover rendered at the view root — outside .stagger, so no transformed
        ancestor hijacks position:fixed. This is what keeps it from being clipped by a card. */}
    {menuProject && menuPos && (
      <>
        <div style={{ position: "fixed", inset: 0, zIndex: 80 }} onClick={() => { setMenuFor(null); setConfirmDel(null); }} />
        <div className="card" style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 81, width: 230, padding: 10, boxShadow: "0 10px 28px rgba(0,0,0,.20)" }}>
          {areas.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="subq" style={{ marginBottom: 5 }}>AREA OF FOCUS</div>
              <select className="input" style={{ width: "100%", padding: "6px 8px", fontSize: 12.5 }} value={menuProject.areaId || ""}
                onChange={(e) => assignProjectArea(menuProject.id, e.target.value || null)}>
                <option value="">— no area —</option>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
              </select>
            </div>
          )}
          <div className="subq" style={{ marginBottom: 5 }}>ACTIONS</div>
          <button className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "flex-start" }}
            onClick={() => { updateProject(menuProject.id, { status: "complete" }); setMenuFor(null); }}>
            <Check size={14} /> Mark complete
          </button>
          {confirmDel === menuProject.id ? (
            <button className="btn btn-sm btn-clay" style={{ width: "100%", justifyContent: "flex-start", marginTop: 4 }}
              onClick={() => { deleteProject(menuProject.id); setMenuFor(null); setConfirmDel(null); }}>
              <Trash2 size={14} /> Tap again to delete
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm btn-danger" style={{ width: "100%", justifyContent: "flex-start", marginTop: 4 }}
              onClick={() => setConfirmDel(menuProject.id)}>
              <Trash2 size={14} /> Delete project…
            </button>
          )}
        </div>
      </>
    )}
    </>
  );
}

function ProjectBody({ p, acts, addActionToProject, toggleDone, updateItem, isBlocked, allItems, contexts, onEdit }) {
  const [t, setT] = useState("");
  const [c, setC] = useState(contexts[0]);
  const [depFor, setDepFor] = useState(null); // task id whose precursor picker is open
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const titleOf = (id) => (byId[id] ? byId[id].title : "(removed)");

  // valid precursor candidates for task T: other project tasks that won't form a cycle
  const candidates = (task) => acts.filter((o) =>
    o.id !== task.id &&
    !(task.blockedBy || []).includes(o.id) &&
    !precursorClosure(o.id, allItems).has(task.id));

  const addDep = (task, depId) => updateItem(task.id, { blockedBy: [...(task.blockedBy || []), depId] });
  const removeDep = (task, depId) => updateItem(task.id, { blockedBy: (task.blockedBy || []).filter((x) => x !== depId) });

  return (
    <div style={{ padding: "4px 0" }}>
      {acts.map((i) => {
        const blocked = isBlocked(i);
        const deps = (i.blockedBy || []).filter((d) => byId[d]);
        return (
          <div key={i.id} style={{ borderBottom: "1px solid var(--line)" }}>
            <div className="row act-row" style={{ borderBottom: "none", opacity: blocked ? .6 : 1 }}>
              <div className={"checkbox" + (i.done ? " done" : "")} onClick={() => toggleDone(i.id)}>{i.done && <Check size={13} color="#fbf9f4" />}</div>
              <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onEdit(i.id)}>
                <div style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                  {blocked && <Lock size={12} color="var(--clay)" />}{i.title}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap", alignItems: "center" }}>
                  {i.context && <span className="pill pill-ctx">{i.context}</span>}
                  {i.recur && <span className="pill" style={{ color: "var(--clay)" }}><Repeat size={9} style={{ verticalAlign: -1 }} /> {i.recur}</span>}
                  {deps.map((d) => (
                    <span key={d} className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 4, background: byId[d].done ? "var(--pine-soft)" : "var(--clay-soft)", color: byId[d].done ? "var(--pine-d)" : "var(--clay)", borderColor: "transparent" }}>
                      <Link2 size={9} /> after: {titleOf(d)}
                      <X size={10} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); removeDep(i, d); }} />
                    </span>
                  ))}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" title="Add precursor" onClick={() => setDepFor(depFor === i.id ? null : i.id)}><Link2 size={13} /></button>
              <button className="btn btn-ghost btn-sm edit-btn" onClick={() => onEdit(i.id)}><Pencil size={13} /></button>
            </div>
            {depFor === i.id && (
              <div className="rise" style={{ padding: "0 13px 11px 44px" }}>
                <div className="tag-ink" style={{ fontSize: 11.5, marginBottom: 6 }}>Must be done before this task:</div>
                {candidates(i).length === 0 ? <div style={{ fontSize: 12, color: "var(--muted)" }}>No eligible tasks (add more, or others would create a loop).</div>
                  : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {candidates(i).map((o) => (
                      <Pill key={o.id} onClick={() => { addDep(i, o.id); setDepFor(null); }}>+ {o.title}</Pill>
                    ))}
                  </div>}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 7, padding: "11px 13px", alignItems: "center", flexWrap: "wrap" }}>
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Add next action…" value={t}
          onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { addActionToProject(p.id, t, c); setT(""); } }} />
        <select className="input" style={{ width: 130 }} value={c} onChange={(e) => setC(e.target.value)}>
          {contexts.map((x) => <option key={x}>{x}</option>)}
        </select>
        <button className="btn btn-accent btn-sm" onClick={() => { addActionToProject(p.id, t, c); setT(""); }}><Plus size={13} /></button>
      </div>
    </div>
  );
}

function WaitingView({ waiting, toggleDone, deleteItem, onEdit }) {
  return (
    <div className="stagger">
      <SectionTitle sub="Delegated or pending on someone else. Review these so nothing slips.">Waiting For <span className="subq">SUPPLY RUNS</span></SectionTitle>
      {waiting.length === 0 ? <Empty icon={Hourglass} title="Nothing pending" />
        : <div className="card" style={{ overflow: "hidden" }}>
          {waiting.map((i) => (
            <div key={i.id} className="row" style={{ alignItems: "center" }}>
              <div className="checkbox" onClick={() => toggleDone(i.id)} />
              <div style={{ flex: 1, cursor: "pointer" }} onClick={() => onEdit(i.id)}>
                <div style={{ fontSize: 14 }}>{i.title}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  {i.waitingOn ? "on: " + i.waitingOn : "waiting"}{i.since ? ` · since ${i.since}` : ""}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => onEdit(i.id)}><Pencil size={13} /></button>
              <button className="btn btn-sm btn-danger" onClick={() => deleteItem(i.id)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>}
    </div>
  );
}

function CalendarView({ scheduled, toggleDone, deleteItem, onEdit }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const startPad = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const byDate = useMemo(() => {
    const m = {};
    scheduled.forEach((it) => { (m[it.dueDate] ||= []).push(it); });
    return m;
  }, [scheduled]);
  const cellDate = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;
  const shift = (n) => setCursor(new Date(year, month + n, 1));
  const goToday = () => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); };

  return (
    <div className="stagger">
      <SectionTitle sub="The hard landscape — items truly tied to a date.">Scheduled <span className="subq">TIMED RAIDS</span></SectionTitle>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div className="serif" style={{ fontSize: 20 }}>{cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-sm" onClick={() => shift(-1)}><ChevronRight size={14} style={{ transform: "rotate(180deg)" }} /></button>
          <button className="btn btn-sm" onClick={goToday}>Today</button>
          <button className="btn btn-sm" onClick={() => shift(1)}><ChevronRight size={14} /></button>
        </div>
      </div>

      <div className="cal" style={{ marginBottom: 8 }}>
        {DOW.map((d) => <div key={d} className="cal-h">{d.toUpperCase()}</div>)}
      </div>
      <div className="cal">
        {cells.map((d, idx) => {
          if (d === null) return <div key={idx} className="cal-cell empty" />;
          const ds = cellDate(d);
          const items = byDate[ds] || [];
          const isToday = ds === todayStr();
          const dow = new Date(ds + "T00:00").getDay();
          return (
            <div key={idx} className={"cal-cell" + (isToday ? " today" : "") + ((dow === 0 || dow === 6) ? " weekend" : "")}>
              <div className="cal-day">{d}</div>
              {items.slice(0, 3).map((it) => (
                <div key={it.id} className={"cal-item" + (ds < todayStr() ? " over" : "")} title={it.title} onClick={() => onEdit(it.id)}>
                  {it.title}
                </div>
              ))}
              {items.length > 3 && <div style={{ fontSize: 9.5, color: "var(--muted)", paddingLeft: 2 }}>+{items.length - 3} more</div>}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 22 }}>
        <div className="mono" style={{ fontSize: 11, color: "var(--pine)", letterSpacing: 1, marginBottom: 8 }}>UPCOMING</div>
        {scheduled.length === 0 ? <Empty icon={Calendar} title="Nothing scheduled" />
          : <div className="card" style={{ overflow: "hidden" }}>
            {scheduled.map((i) => (
              <div key={i.id} className="row" style={{ alignItems: "center" }}>
                <div className="checkbox" onClick={() => toggleDone(i.id)} />
                <span style={{ flex: 1, fontSize: 14, cursor: "pointer" }} onClick={() => onEdit(i.id)}>{i.title}</span>
                <span className="pill" style={{ color: i.dueDate < todayStr() ? "var(--clay)" : "var(--ink2)" }}>{i.dueDate} · {relDate(i.dueDate)}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(i.id)}><Pencil size={13} /></button>
                <button className="btn btn-sm btn-danger" onClick={() => deleteItem(i.id)}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>}
      </div>
    </div>
  );
}

function SomedayView({ somedays, updateItem, deleteItem, onEdit }) {
  return (
    <div className="stagger">
      <SectionTitle sub="Things you might do someday. Revisit in your weekly review.">Someday / Maybe <span className="subq">THE FRONTIER</span></SectionTitle>
      {somedays.length === 0 ? <Empty icon={Moon} title="Empty" />
        : <div className="card" style={{ overflow: "hidden" }}>
          {somedays.map((i) => (
            <div key={i.id} className="row" style={{ alignItems: "center" }}>
              <Moon size={14} color="var(--muted)" />
              <span style={{ flex: 1, fontSize: 14, cursor: "pointer" }} onClick={() => onEdit(i.id)}>{i.title}</span>
              <button className="btn btn-sm" title="Activate to inbox" onClick={() => updateItem(i.id, { type: "inbox" })}>Activate</button>
              <button className="btn btn-ghost btn-sm" onClick={() => onEdit(i.id)}><Pencil size={13} /></button>
              <button className="btn btn-sm btn-danger" onClick={() => deleteItem(i.id)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>}
    </div>
  );
}

function ReferenceView({ refs, deleteItem, onEdit }) {
  return (
    <div className="stagger">
      <SectionTitle sub="Non-actionable material worth keeping.">Reference <span className="subq">THE ARCHIVE</span></SectionTitle>
      {refs.length === 0 ? <Empty icon={BookOpen} title="No reference notes" />
        : <div className="card" style={{ overflow: "hidden" }}>
          {refs.map((i) => (
            <div key={i.id} className="row" style={{ alignItems: "flex-start" }}>
              <BookOpen size={14} color="var(--muted)" style={{ marginTop: 2 }} />
              <div style={{ flex: 1, cursor: "pointer" }} onClick={() => onEdit(i.id)}>
                <div style={{ fontSize: 14 }}>{i.title}</div>
                {i.notes && <div style={{ fontSize: 12.5, color: "var(--ink2)", marginTop: 3 }}>{i.notes}</div>}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => onEdit(i.id)}><Pencil size={13} /></button>
              <button className="btn btn-sm btn-danger" onClick={() => deleteItem(i.id)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>}
    </div>
  );
}

function HabitsView({ habits, log, toggleLog, addHabit, deleteHabit, updateHabit, purposes, setView }) {
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [linkFor, setLinkFor] = useState(null); // habit id whose purpose picker is open
  const purposeText = (id) => (purposes.find((p) => p.id === id) || {}).text;
  const last14 = useMemo(() => {
    const arr = [];
    const d = new Date();
    for (let i = 13; i >= 0; i--) { const x = new Date(d); x.setDate(d.getDate() - i); arr.push(isoDate(x)); }
    return arr;
  }, []);
  const submit = () => { addHabit(name, cadence, cadence === "custom" ? days : []); setName(""); };
  return (
    <div className="stagger">
      <SectionTitle sub="Build consistency. Tap a day to mark it done; streaks reward momentum. Link a routine to your Purpose to remember why it matters.">Habits <span className="subq">DAILY ROUTINES</span></SectionTitle>

      <div className="card" style={{ padding: 14, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
          <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="New habit — e.g. Read 20 min" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <select className="input" style={{ width: 150 }} value={cadence} onChange={(e) => setCadence(e.target.value)}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="custom">Custom days</option>
          </select>
          <button className="btn btn-clay" onClick={submit}><Plus size={15} /> Add</button>
        </div>
        {cadence === "custom" && (
          <div style={{ display: "flex", gap: 6, marginTop: 11 }}>
            {DOW.map((d, idx) => (
              <Pill key={d} on={days.includes(idx)} onClick={() => setDays((p) => p.includes(idx) ? p.filter((x) => x !== idx) : [...p, idx])}>{d}</Pill>
            ))}
          </div>
        )}
      </div>

      {habits.length === 0 ? <Empty icon={Repeat} title="No habits yet" sub="Add one above to start tracking." />
        : habits.map((h) => {
          const linked = h.purposeId && purposeText(h.purposeId);
          return (
          <div key={h.id} className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 11 }}>
              <div style={{ flex: 1 }}>
                <div className="serif" style={{ fontSize: 17 }}>{h.name}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                  {h.cadence === "daily" ? "every day" : h.cadence === "weekdays" ? "weekdays" : "custom: " + (h.days || []).map((d) => DOW[d]).join(" ")}
                </div>
              </div>
              <div style={{ textAlign: "right", marginRight: 12 }}>
                <div className="mono" style={{ fontSize: 18, color: "var(--clay)", lineHeight: 1 }}><Flame size={15} style={{ verticalAlign: -2 }} /> {habitStreak(h, log)}</div>
                <div className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{habitRate(h, log)}% · 30d</div>
              </div>
              <button className="btn btn-sm btn-ghost" title="Link to a Purpose" onClick={() => setLinkFor(linkFor === h.id ? null : h.id)}><Sparkles size={13} /></button>
              <button className="btn btn-sm btn-danger" onClick={() => deleteHabit(h.id)}><Trash2 size={13} /></button>
            </div>

            {linked && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 12, color: "var(--clay)" }}>
                <Sparkles size={12} /> <span style={{ fontStyle: "italic" }}>in service of: {linked}</span>
              </div>
            )}

            {linkFor === h.id && (
              <div className="rise" style={{ marginBottom: 11, padding: 11, background: "var(--paper2)", borderRadius: 9 }}>
                {purposes.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--ink2)" }}>
                    No Purpose statements yet. Add some under <a className="linklike" onClick={() => setView("horizons")}>Goals · Vision · Purpose</a>, then link them here.
                  </div>
                ) : (
                  <>
                    <div className="subq" style={{ marginBottom: 6 }}>THIS ROUTINE SERVES…</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {purposes.map((p) => (
                        <Pill key={p.id} on={h.purposeId === p.id} onClick={() => { updateHabit(h.id, { purposeId: h.purposeId === p.id ? null : p.id }); setLinkFor(null); }}>{p.text}</Pill>
                      ))}
                      {h.purposeId && <Pill onClick={() => { updateHabit(h.id, { purposeId: null }); setLinkFor(null); }}>✕ clear</Pill>}
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="hgrid">
              {last14.map((ds) => {
                const sched = isScheduled(h, ds);
                const done = !!log[h.id + "|" + ds];
                const dnum = new Date(ds + "T00:00").getDate();
                return (
                  <div key={ds} className={"hcell " + (!sched ? "off" : done ? "done" : "")} title={ds}
                    onClick={() => sched && toggleLog(h.id, ds)}>
                    {sched ? (done ? <Check size={12} /> : dnum) : ""}
                  </div>
                );
              })}
            </div>
          </div>
          );
        })}
    </div>
  );
}

function ReviewView({ inbox, nexts, waiting, stalled, somedays, setView, settings, daysSinceReview, completeReview, siege, gate }) {
  const [checks, setChecks] = useState({});
  const steps = [
    { g: "Get Clear", items: [
      { t: `Process inbox to zero (${inbox.length} left)`, go: "inbox" },
      { t: "Empty your head — capture any loose thoughts" },
    ]},
    { g: "Get Current", items: [
      { t: `Review Next Actions list (${nexts.length})`, go: "next" },
      { t: `Review Waiting For — chase what's stale (${waiting.length})`, go: "waiting" },
      { t: `Review each project for a defined next action${stalled.length ? ` (${stalled.length} stalled)` : ""}`, go: "projects" },
      { t: "Review calendar — past & upcoming", go: "calendar" },
    ]},
    { g: "Get Creative", items: [
      { t: `Review Someday / Maybe — pull anything in? (${somedays.length})`, go: "someday" },
      { t: "Scan Areas of Focus — is each one being served?", go: "areas" },
      { t: "Reread Goals, Vision & Purpose — still aligned?", go: "horizons" },
      { t: "Add bold new ideas to the system" },
    ]},
  ];
  const all = steps.flatMap((s) => s.items);
  const done = all.filter((_, idx) => checks[idx]).length;
  const complete = () => { completeReview(); setChecks({}); };
  let idx = -1;
  return (
    <div className="stagger">
      <SectionTitle sub={settings.lastReview ? `Last fortified: ${settings.lastReview}${daysSinceReview != null ? ` (${daysSinceReview}d ago)` : ""}` : "The settlement has never been fortified."}>
        Weekly Review <span className="subq">FORTIFY · THE BOSS</span>
      </SectionTitle>
      {siege && (
        <div className="card" style={{ padding: 13, marginBottom: 14, borderColor: "var(--t-siege)", background: "var(--clay-soft)", display: "flex", gap: 9, alignItems: "center" }}>
          <Shield size={17} color="var(--t-siege)" />
          <span style={{ fontSize: 13 }}>The settlement is <b>under siege</b>. Completing this fortification is the surest way to break it.</span>
        </div>
      )}
      {!gate.isWeekend && (
        <div className="card" style={{ padding: 13, marginBottom: 14, display: "flex", gap: 9, alignItems: "center" }}>
          <Calendar size={16} color="var(--muted)" />
          <span style={{ fontSize: 13, color: "var(--ink2)" }}>Fortification crews only muster on the <b>weekend</b> (Fri–Sun). You can still walk the checklist now, but the settlement can't be fortified until then.</span>
        </div>
      )}
      {gate.isWeekend && gate.doneThisWeekend && (
        <div className="card" style={{ padding: 13, marginBottom: 14, display: "flex", gap: 9, alignItems: "center" }}>
          <Check size={16} color="var(--pine)" />
          <span style={{ fontSize: 13, color: "var(--ink2)" }}>Already fortified this weekend. The walls hold — come back next weekend.</span>
        </div>
      )}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ height: 6, background: "var(--paper2)", borderRadius: 6, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ height: "100%", width: `${(done / all.length) * 100}%`, background: "var(--pine)", transition: "width .25s" }} />
        </div>
        {steps.map((s) => (
          <div key={s.g} style={{ marginBottom: 16 }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--pine)", letterSpacing: 1, marginBottom: 8 }}>{s.g.toUpperCase()}</div>
            {s.items.map((it) => {
              idx++; const i = idx; const c = !!checks[i];
              return (
                <div key={i} className="row" style={{ borderBottom: "none", padding: "7px 0", alignItems: "center" }}>
                  <div className={"checkbox" + (c ? " done" : "")} onClick={() => setChecks((p) => ({ ...p, [i]: !p[i] }))}>{c && <Check size={13} color="#fbf9f4" />}</div>
                  <span style={{ flex: 1, fontSize: 14, color: c ? "var(--muted)" : "var(--ink)", textDecoration: c ? "line-through" : "none" }}>{it.t}</span>
                  {it.go && <button className="btn btn-sm" onClick={() => setView(it.go)}>Open <ArrowRight size={12} /></button>}
                </div>
              );
            })}
          </div>
        ))}
        <button className="btn btn-accent" style={{ width: "100%", justifyContent: "center" }} disabled={done < all.length || !gate.ok}
          onClick={complete}>
          <Shield size={16} /> {
            !gate.isWeekend ? "Available on the weekend"
            : gate.doneThisWeekend ? "Fortified — back next weekend"
            : done < all.length ? `${done}/${all.length} — hold the line`
            : "Fortify the settlement  ·  +200 XP +100 ₲"
          }
        </button>
      </div>
    </div>
  );
}

function ArchiveView({ completedItems, completedProjects, projName, restoreItem, deleteItem, reactivateProject, deleteProject }) {
  const groups = useMemo(() => {
    const g = {};
    completedItems.forEach((i) => {
      const key = i.completedAt ? isoDate(new Date(i.completedAt)) : "earlier";
      (g[key] ||= []).push(i);
    });
    return g;
  }, [completedItems]);
  const dateKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const label = (k) => k === todayStr() ? "Today" : k === isoDate(new Date(Date.now() - 86400000)) ? "Yesterday"
    : new Date(k + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const typeLabel = { next: "action", waiting: "waiting", calendar: "scheduled", someday: "someday", reference: "reference", inbox: "inbox" };

  return (
    <div className="stagger">
      <SectionTitle sub="Everything you've completed. Restore anything that came back, or clear it for good.">Archive <span className="subq">THE FALLEN</span></SectionTitle>

      {completedProjects.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--pine)", letterSpacing: 1, marginBottom: 8 }}>COMPLETED PROJECTS</div>
          <div className="card" style={{ overflow: "hidden" }}>
            {completedProjects.map((p) => (
              <div key={p.id} className="row" style={{ alignItems: "center" }}>
                <CheckCircle2 size={15} color="var(--pine)" />
                <span style={{ flex: 1, fontSize: 14 }} className="serif">{p.title}</span>
                <button className="btn btn-sm" onClick={() => reactivateProject(p.id)}><RotateCcw size={13} /> Reopen</button>
                <button className="btn btn-sm btn-danger" onClick={() => deleteProject(p.id)}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mono" style={{ fontSize: 11, color: "var(--pine)", letterSpacing: 1, marginBottom: 8 }}>COMPLETED ITEMS</div>
      {completedItems.length === 0 ? <Empty icon={Archive} title="Nothing archived yet" sub="Completed tasks land here once you check them off." />
        : dateKeys.map((k) => (
          <div key={k} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 6, fontWeight: 500 }}>{label(k)}</div>
            <div className="card" style={{ overflow: "hidden" }}>
              {groups[k].map((i) => (
                <div key={i.id} className="row act-row" style={{ alignItems: "center" }}>
                  <div className="checkbox done" onClick={() => restoreItem(i.id)} title="Restore"><Check size={13} color="#fbf9f4" /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "var(--muted)", textDecoration: "line-through" }}>{i.title}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                      <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{typeLabel[i.type] || i.type}</span>
                      {i.context && <span className="pill pill-ctx">{i.context}</span>}
                      {i.projectId && projName(i.projectId) && <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>↳ {projName(i.projectId)}</span>}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => restoreItem(i.id)}><RotateCcw size={13} /> Restore</button>
                  <button className="btn btn-ghost btn-sm edit-btn btn-danger" onClick={() => deleteItem(i.id)}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function AreasView({ areas, projects, activeProjects, projectNexts, isBlocked, addArea, updateArea, deleteArea, toggleDone, openArea, setOpenArea, onEdit, horizons, setView }) {
  const [na, setNa] = useState("");
  const projectsIn = (aid) => activeProjects.filter((p) => p.areaId === aid);
  const goalsIn = (aid) => (horizons.goals || []).filter((g) => g.areaId === aid);
  const unfiled = activeProjects.filter((p) => !p.areaId);

  return (
    <div className="stagger">
      <SectionTitle sub="Horizon 2 — the ongoing spheres of work and life you maintain. Each holds its own projects and, through them, next actions.">Areas of Focus <span className="subq">DISTRICTS</span></SectionTitle>

      <div style={{ display: "flex", gap: 9, marginBottom: 18 }}>
        <input className="input" placeholder="New area — e.g. Dissertation, Teaching, Health…" value={na}
          onChange={(e) => setNa(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { addArea(na); setNa(""); } }} />
        <button className="btn btn-accent" onClick={() => { addArea(na); setNa(""); }}><Plus size={15} /> Add</button>
      </div>

      {areas.length === 0 ? <Empty icon={Compass} title="No areas yet" sub="Define the spheres you're responsible for, then file projects under them." />
        : areas.map((a) => {
          const ps = projectsIn(a.id);
          const open = openArea === a.id;
          const totalActionable = ps.reduce((n, p) => n + projectNexts(p.id).filter((i) => !isBlocked(i)).length, 0);
          const gs = goalsIn(a.id);
          return (
            <div key={a.id} className="card" style={{ marginBottom: 12, overflow: "hidden" }}>
              <div className="row" style={{ alignItems: "center", borderBottom: open ? "1px solid var(--line)" : "none" }}>
                <button className="btn-ghost btn" style={{ padding: 4 }} onClick={() => setOpenArea(open ? null : a.id)}>
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <Compass size={15} color="var(--pine)" />
                <div style={{ flex: 1 }}>
                  <div className="serif" style={{ fontSize: 16 }}>{a.title}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                    {ps.length} project{ps.length !== 1 ? "s" : ""} · {totalActionable} actionable{gs.length ? ` · ${gs.length} goal${gs.length > 1 ? "s" : ""}` : ""}
                  </div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => deleteArea(a.id)} title="Delete area (projects are unfiled, not deleted)"><Trash2 size={13} /></button>
              </div>
              {open && (
                <div style={{ padding: "12px 14px" }}>
                  <textarea className="input" rows={2} placeholder="What does maintaining this area look like? Standards, responsibilities…"
                    value={a.notes || ""} onChange={(e) => updateArea(a.id, { notes: e.target.value })} style={{ marginBottom: 14, resize: "vertical", fontSize: 13 }} />

                  {gs.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div className="mono" style={{ fontSize: 10, color: "var(--amber)", letterSpacing: 1, marginBottom: 6 }}>GOALS (H3)</div>
                      {gs.map((g) => <div key={g.id} style={{ fontSize: 13, color: "var(--ink2)", padding: "3px 0", display: "flex", gap: 7 }}><Target size={13} color="var(--amber)" style={{ marginTop: 2, flexShrink: 0 }} />{g.text}</div>)}
                    </div>
                  )}

                  <div className="mono" style={{ fontSize: 10, color: "var(--pine)", letterSpacing: 1, marginBottom: 8 }}>PROJECTS (H1)</div>
                  {ps.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)", paddingBottom: 6 }}>No projects filed here yet. Assign one from the Projects tab.</div>
                    : ps.map((p) => {
                      const acts = projectNexts(p.id);
                      return (
                        <div key={p.id} style={{ marginBottom: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                            <FolderKanban size={13} color="var(--ink2)" />
                            <span style={{ fontSize: 13.5, fontWeight: 500 }}>{p.title}</span>
                          </div>
                          <div style={{ borderLeft: "2px solid var(--line)", marginLeft: 6, paddingLeft: 8 }}>
                            {acts.length === 0 ? <div className="mono" style={{ fontSize: 11, color: "var(--clay)" }}>⚠ needs a next action</div>
                              : acts.map((i) => {
                                const blocked = isBlocked(i);
                                return (
                                  <div key={i.id} className="act-row" style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0", opacity: blocked ? .55 : 1 }}>
                                    <div className="checkbox" style={{ width: 17, height: 17 }} onClick={() => !blocked && toggleDone(i.id)}>{blocked && <Lock size={10} color="var(--clay)" />}</div>
                                    <span style={{ flex: 1, fontSize: 13, cursor: "pointer" }} onClick={() => onEdit(i.id)}>{i.title}</span>
                                    {i.context && <span className="pill pill-ctx">{i.context}</span>}
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}

      {unfiled.length > 0 && areas.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, marginBottom: 8 }}>UNFILED PROJECTS</div>
          <div className="card" style={{ overflow: "hidden" }}>
            {unfiled.map((p) => (
              <div key={p.id} className="row" style={{ alignItems: "center" }}>
                <FolderKanban size={14} color="var(--muted)" />
                <span style={{ flex: 1, fontSize: 13.5 }}>{p.title}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>assign in Projects tab</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HorizonHeading({ icon, color, code, title, blurb }) {
  const I = icon;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <I size={16} color="#fbf9f4" />
      </div>
      <div>
        <div className="serif" style={{ fontSize: 17, lineHeight: 1.1 }}>{title} <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{code}</span></div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{blurb}</div>
      </div>
    </div>
  );
}

function HorizonList({ hkey, list, areas, addHorizon, updateHorizon, deleteHorizon, withArea }) {
  const [t, setT] = useState("");
  const [aid, setAid] = useState("");
  const areaName = (id) => areas.find((a) => a.id === id)?.title;
  const submit = () => { addHorizon(hkey, t, withArea ? aid : null); setT(""); };
  return (
    <div className="card" style={{ padding: 14, marginBottom: 18 }}>
      {(list || []).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {list.map((x) => (
            <div key={x.id} className="row act-row" style={{ padding: "8px 0", alignItems: "flex-start" }}>
              <ChevronRight size={14} color="var(--muted)" style={{ marginTop: 3, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14 }}>{x.text}</div>
                {withArea && x.areaId && areaName(x.areaId) && (
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--pine)", marginTop: 3 }}><Compass size={9} style={{ verticalAlign: -1 }} /> {areaName(x.areaId)}</div>
                )}
              </div>
              {withArea && (
                <select className="input" style={{ width: 120, padding: "4px 7px", fontSize: 11.5 }} value={x.areaId || ""} onChange={(e) => updateHorizon(hkey, x.id, { areaId: e.target.value || null })}>
                  <option value="">— link area —</option>
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              )}
              <button className="btn btn-ghost btn-sm edit-btn btn-danger" onClick={() => deleteHorizon(hkey, x.id)}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Add a statement…" value={t}
          onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {withArea && areas.length > 0 && (
          <select className="input" style={{ width: 140 }} value={aid} onChange={(e) => setAid(e.target.value)}>
            <option value="">— no area —</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        )}
        <button className="btn btn-sm" onClick={submit}><Plus size={14} /></button>
      </div>
    </div>
  );
}

function HorizonsView({ horizons, areas, addHorizon, updateHorizon, deleteHorizon }) {
  return (
    <div className="stagger">
      <SectionTitle sub="The higher altitudes. These aren't task lists — they're statements you read during review to keep everything below them pointed in the right direction.">Goals · Vision · Purpose <span className="subq">THE SIGNAL</span></SectionTitle>

      <HorizonHeading icon={Target} color="var(--amber)" code="H3" title="Goals" blurb="What you want to accomplish in the next 1–2 years. Link each to the area it serves." />
      <HorizonList hkey="goals" list={horizons.goals} areas={areas} addHorizon={addHorizon} updateHorizon={updateHorizon} deleteHorizon={deleteHorizon} withArea />

      <HorizonHeading icon={Mountain} color="var(--pine)" code="H4" title="Vision" blurb="Where you're headed in 3–5 years — the longer arc your goals ladder up to." />
      <HorizonList hkey="vision" list={horizons.vision} areas={areas} addHorizon={addHorizon} updateHorizon={updateHorizon} deleteHorizon={deleteHorizon} />

      <HorizonHeading icon={Sparkles} color="var(--clay)" code="H5" title="Purpose & Principles" blurb="Why any of it matters, and the standards you hold. The view from the top." />
      <HorizonList hkey="purpose" list={horizons.purpose} areas={areas} addHorizon={addHorizon} updateHorizon={updateHorizon} deleteHorizon={deleteHorizon} />
    </div>
  );
}

// Renders an avatar. If the avatar has a src (base64 PNG), display it as a
// crisp pixel-art image. Fallback: solid tile color placeholder for avatars
// not yet drawn (future Piskel artwork). size controls the rendered square.
function AvatarPixels({ avatar, size = 56 }) {
  const a = avatar || AVATARS[0];
  if (a.src) {
    return (
      <img
        src={a.src}
        width={size}
        height={size}
        alt={a.name}
        style={{
          display: "block",
          borderRadius: 10,
          imageRendering: "pixelated",
          width: size,
          height: size,
        }}
      />
    );
  }
  // Placeholder tile for avatars not yet drawn
  return (
    <div style={{
      width: size, height: size, borderRadius: 10,
      background: a.tile || "var(--pine)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <span style={{ fontSize: size * 0.35, opacity: 0.5 }}>?</span>
    </div>
  );
}
const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
const avatarById = (id) => AVATARS.find((a) => a.id === id) || AVATARS[0];

function Glyph() { return <span className="gtd-glyph" style={{ padding: "0 3px" }}>G</span>; }

function StatusStrip({ threat, band, lvl, rank, gtd, siege, onClick }) {
  const c = `var(${band.varc})`;
  return (
    <div className="strip" onClick={onClick} title="Open the Watchtower" style={siege ? { background: "var(--clay-soft)" } : null}>
      <div className="seg" style={{ minWidth: 150 }}>
        {siege ? <Skull size={14} color={c} style={{ animation: "pulse 1s infinite" }} /> : <Shield size={14} color={c} />}
        <span style={{ color: c, fontWeight: 600 }}>{band.name}</span>
        <div className="threat-bar" style={{ width: 64 }}><i style={{ width: `${threat.value}%`, background: c }} /></div>
        <span style={{ color: c }}>{threat.value}</span>
      </div>
      <div className="seg">
        <span style={{ color: "var(--amber)", fontWeight: 600 }}>LV {lvl.level}</span>
        <div className="xp-bar" style={{ width: 54 }}><i style={{ width: `${lvl.pct}%` }} /></div>
        <span style={{ color: "var(--muted)" }}>{rank}</span>
      </div>
      <div className="seg" style={{ marginLeft: "auto" }}>
        <Glyph /><span style={{ fontWeight: 600 }}>{gtd}</span>
      </div>
      <Radar size={13} color="var(--muted)" />
    </div>
  );
}

function MeterRing({ value, color, siege }) {
  const r = 52, c = 2 * Math.PI * r, off = c - (value / 100) * c;
  return (
    <svg width="130" height="130" viewBox="0 0 130 130">
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--paper2)" strokeWidth="11" />
      <circle cx="65" cy="65" r={r} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 65 65)" style={{ transition: "stroke-dashoffset .6s ease, stroke .3s" }} />
      <text x="65" y="60" textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="30" fontWeight="600" fill={color}>{value}</text>
      <text x="65" y="80" textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="9.5" fill="var(--muted)" letterSpacing="1">THREAT</text>
      {siege && <text x="65" y="98" textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="8" fill={color}>SIEGE</text>}
    </svg>
  );
}

function Watchtower({ threat, band, lvl, rank, game, items, projects, nexts, stalled, daysSinceReview, settings, setView, setClarifyId, onEdit, buyCosmetic, equipCosmetic }) {
  const c = `var(${band.varc})`;
  // high-value raids: biggest brute, project nearest a claim, overdue fortify
  const raids = [];
  const sortedNext = [...nexts].map((i) => ({ i, w: actionWeight(i, items) })).sort((a, b) => b.w - a.w);
  if (sortedNext[0]) {
    const { i, w } = sortedNext[0];
    raids.push({ icon: Crosshair, color: TONE_META[toneTier(w)].color, title: i.title, sub: `${TONE_META[toneTier(w)].label} · worth ${actionXP(w)} XP`, go: () => onEdit(i.id) });
  }
  const active = projects.filter((p) => p.status === "active");
  const nearest = active.map((p) => ({ p, open: items.filter((i) => i.projectId === p.id && i.type === "next" && !i.done).length }))
    .filter((x) => x.open > 0).sort((a, b) => a.open - b.open)[0];
  if (nearest) raids.push({ icon: FolderKanban, color: "var(--pine)", title: nearest.p.title, sub: `${nearest.open} room${nearest.open > 1 ? "s" : ""} from claiming the structure`, go: () => setView("projects") });
  const weekendNow = [5, 6, 0].includes(new Date().getDay());
  if ((daysSinceReview === null || daysSinceReview >= 7)) {
    raids.push(weekendNow
      ? { icon: Shield, color: "var(--amber)", title: "Fortify the settlement", sub: "Weekly review — the biggest payday (+200 XP)", go: () => setView("review") }
      : { icon: Shield, color: "var(--muted)", title: "Fortification due", sub: "Crews muster on the weekend (Fri–Sun)", go: () => setView("review") });
  }
  const firstInbox = items.find((i) => i.type === "inbox");
  if (firstInbox) raids.push({ icon: Radar, color: c, title: "Identify the shapes in the fog", sub: `${items.filter((i) => i.type === "inbox").length} unprocessed · +10 XP each`, go: () => setView("inbox") });

  const tier = rankTier(lvl.level);
  const avatar = avatarById(game.equipped?.avatar);
  const owned = (id) => (game.ownedCosmetics || []).includes(id);

  return (
    <div className="stagger">
      <SectionTitle sub="Your settlement at a glance — what's threatening it, what's worth raiding, and who you've become.">
        The Watchtower
      </SectionTitle>

      {game.inSiege && (
        <div className="card" style={{ padding: 14, marginBottom: 16, borderColor: "var(--t-siege)", background: "var(--clay-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Skull size={20} color="var(--t-siege)" style={{ animation: "pulse 1.1s infinite" }} />
            <div style={{ flex: 1 }}>
              <div className="serif" style={{ fontSize: 17 }}>The settlement is overrun</div>
              <div style={{ fontSize: 12.5, color: "var(--ink2)" }}>The economy has collapsed — no trade until the line holds. Fortify, or push threat back below 70.</div>
            </div>
            <button className="btn btn-clay" onClick={() => setView("review")}><Shield size={15} /> Hold the line</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* SETTLEMENT STATUS */}
        <div className="card" style={{ padding: 16, display: "flex", gap: 16, alignItems: "center" }}>
          <MeterRing value={threat.value} color={c} siege={game.inSiege} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
              <span style={{ color: c, fontWeight: 600, fontFamily: "IBM Plex Mono", fontSize: 13 }}>{band.name}</span>
              {threat.fortified && <span className="pill" style={{ color: "var(--pine-d)", background: "var(--pine-soft)", borderColor: "transparent" }}>fortified</span>}
            </div>
            <div className="subq" style={{ marginBottom: 6 }}>WHAT'S DRIVING IT</div>
            {threat.parts.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Nothing. The walls are quiet.</div>
              : threat.parts.map((p) => (
                <div key={p.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0" }}>
                  <span style={{ color: "var(--ink2)" }}>{p.label}</span>
                  <span className="mono" style={{ color: c }}>+{Math.round(p.amt)}</span>
                </div>
              ))}
          </div>
        </div>

        {/* SURVIVOR CARD */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 13, alignItems: "center", marginBottom: 14 }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, background: "var(--paper2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
              <AvatarPixels avatar={avatar} size={56} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="serif" style={{ fontSize: 20, lineHeight: 1 }}>{rank}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>LEVEL {lvl.level} · {avatar.name}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 600 }}><Glyph /> {game.gtd}</div>
              <div className="subq">BALANCE</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }} className="mono">
            <span style={{ color: "var(--muted)" }}>{game.xp} XP</span>
            <span style={{ color: "var(--muted)" }}>{lvl.ceil - game.xp} to Lv {lvl.level + 1}</span>
          </div>
          <div className="xp-bar" style={{ margintop: 5, height: 7 }}><i style={{ width: `${lvl.pct}%` }} /></div>
        </div>
      </div>

      {/* HIGH-VALUE RAIDS */}
      <div className="subq" style={{ marginBottom: 8 }}>HIGH-VALUE RAIDS</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        {raids.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)" }}>No pressing targets. Enjoy the quiet.</div>
          : raids.map((r, i) => {
            const I = r.icon;
            return (
              <div key={i} className="raid" onClick={r.go}>
                <I size={17} color={r.color} style={{ flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{r.sub}</div>
                </div>
                <ArrowRight size={14} color="var(--muted)" style={{ marginLeft: "auto", flexShrink: 0 }} />
              </div>
            );
          })}
      </div>

      {/* QUARTERMASTER — cosmetic shop */}
      <div className="subq" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <ShoppingBag size={12} /> QUARTERMASTER · COSMETIC ONLY {game.inSiege && <span style={{ color: "var(--t-siege)" }}>· CLOSED (SIEGE)</span>}
      </div>

      {/* AVATARS */}
      <div className="subq" style={{ marginBottom: 7, color: "var(--pine)" }}>SURVIVORS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
        {AVATARS.map((a) => {
          const isOwned = owned(a.id);
          const isEquipped = game.equipped?.avatar === a.id;
          const tierLocked = rankTier(lvl.level) < a.tier;
          const affordable = game.gtd >= a.cost;
          return (
            <div key={a.id} className={"gear-card" + (isEquipped ? " equipped" : "") + (tierLocked ? " locked" : "")} style={{ alignItems: "center", textAlign: "center" }}>
              <div style={{ background: "var(--paper2)", borderRadius: 10, padding: 6 }}><AvatarPixels avatar={a} size={52} /></div>
              <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.1 }}>{a.name}</span>
              <div style={{ marginTop: "auto" }}>
                {isEquipped ? <span className="pill on">equipped</span>
                  : isOwned ? <button className="btn btn-sm" onClick={() => equipCosmetic("avatar", a)}>Equip</button>
                  : tierLocked ? <span className="pill" style={{ display: "inline-flex", gap: 3, alignItems: "center" }}><Lock size={9} /> T{a.tier}</span>
                  : <button className="btn btn-sm" disabled={!affordable || game.inSiege} onClick={() => buyCosmetic(a)} style={{ opacity: (!affordable || game.inSiege) ? .5 : 1 }}><Glyph />{a.cost}</button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* THEMES */}
      <div className="subq" style={{ marginBottom: 7, color: "var(--clay)" }}>THEMES — RECOLOR BUTTONS &amp; BACKDROP</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {THEMES.map((t) => {
          const isOwned = owned(t.id);
          const isEquipped = game.equipped?.theme === t.id;
          const tierLocked = rankTier(lvl.level) < t.tier;
          const affordable = game.gtd >= t.cost;
          // mini palette preview from the theme's key colors
          const sw = t.vars ? [t.vars["--paper"], t.vars["--pine"], t.vars["--clay"], t.vars["--amber"]] : ["#f3efe6", "#2c6a55", "#bd5b27", "#c08a16"];
          return (
            <div key={t.id} className={"gear-card" + (isEquipped ? " equipped" : "") + (tierLocked ? " locked" : "")}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", flexShrink: 0, border: "1px solid var(--line2)" }}>
                  {sw.map((c, i) => <div key={i} style={{ width: 12, height: 22, background: c }} />)}
                </div>
                <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.1 }}>{t.name}</span>
              </div>
              <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>theme · T{t.tier}</span>
                {isEquipped ? <span className="pill on">active</span>
                  : isOwned ? <button className="btn btn-sm" onClick={() => equipCosmetic("theme", t)}>Apply</button>
                  : tierLocked ? <span className="pill" style={{ display: "inline-flex", gap: 3, alignItems: "center" }}><Lock size={9} /> tier {t.tier}</span>
                  : <button className="btn btn-sm" disabled={!affordable || game.inSiege} onClick={() => buyCosmetic(t)} style={{ opacity: (!affordable || game.inSiege) ? .5 : 1 }}><Glyph />{t.cost}</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WelcomeModal({ onFinish }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [goals, setGoals] = useState("");
  const [vision, setVision] = useState("");
  const [purpose, setPurpose] = useState("");
  const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const finish = (skipGVP) => onFinish({
    name,
    goals: skipGVP ? [] : lines(goals),
    vision: skipGVP ? [] : lines(vision),
    purpose: skipGVP ? [] : lines(purpose),
  });

  return (
    <div className="overlay" style={{ alignItems: "center" }}>
      <div className="card rise" style={{ width: 560, maxWidth: "100%", padding: 26 }}>
        {step === 0 && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: "var(--pine)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Sparkles size={20} color="#fbf9f4" />
              </div>
              <div>
                <div className="serif" style={{ fontSize: 23, lineHeight: 1 }}>Welcome to Clearmind</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: 1, marginTop: 3 }}>A GTD SURVIVAL SYSTEM</div>
              </div>
            </div>
            <p style={{ fontSize: 14, color: "var(--ink2)", lineHeight: 1.5, marginTop: 0 }}>
              The world outside is everything unprocessed in your head. The settlement you'll defend is your trusted system — capture it all, clear it, and keep your mind like water. First, what should we call you?
            </p>
            <input className="input" autoFocus placeholder="Your name" value={name}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) setStep(1); }} style={{ marginTop: 6 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn btn-accent" disabled={!name.trim()} style={{ opacity: name.trim() ? 1 : .5 }} onClick={() => setStep(1)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="rise">
            <div className="serif" style={{ fontSize: 21, marginBottom: 4 }}>The Signal, {name.trim().split(" ")[0]}</div>
            <p style={{ fontSize: 13.5, color: "var(--ink2)", lineHeight: 1.5, marginTop: 4 }}>
              Before the tasks, the why. These are GTD's higher horizons — what you're walking toward. Jot whatever comes to mind (one per line), or skip and add them later from the Goals · Vision · Purpose tab.
            </p>
            <div style={{ marginTop: 14 }}>
              <div className="tag-ink" style={{ fontSize: 12.5, marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}><Target size={13} color="var(--amber)" /> Goals — next 1–2 years</div>
              <textarea className="input" rows={2} placeholder={"Finish the dissertation\nRun a half marathon"} value={goals} onChange={(e) => setGoals(e.target.value)} style={{ resize: "vertical" }} />
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="tag-ink" style={{ fontSize: 12.5, marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}><Mountain size={13} color="var(--pine)" /> Vision — 3–5 years out</div>
              <textarea className="input" rows={2} placeholder={"The kind of work and life I'm building toward"} value={vision} onChange={(e) => setVision(e.target.value)} style={{ resize: "vertical" }} />
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="tag-ink" style={{ fontSize: 12.5, marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}><Sparkles size={13} color="var(--clay)" /> Purpose — why any of it matters</div>
              <textarea className="input" rows={2} placeholder={"The principles I hold to"} value={purpose} onChange={(e) => setPurpose(e.target.value)} style={{ resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20 }}>
              <button className="btn btn-ghost" onClick={() => finish(true)}>Skip for now</button>
              <button className="btn btn-accent" onClick={() => finish(false)}><Check size={15} /> Enter the settlement</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WhatsNewModal({ name, entries, onClose }) {
  return (
    <div className="overlay" style={{ alignItems: "center" }}>
      <div className="card rise" style={{ width: 520, maxWidth: "100%", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <Sparkles size={18} color="var(--pine)" />
          <div className="serif" style={{ fontSize: 21 }}>What's New{name ? `, ${name.split(" ")[0]}` : ""}</div>
        </div>
        <p style={{ fontSize: 13, color: "var(--ink2)", marginTop: 0 }}>Your progress carried over untouched — here's what changed since you were last here.</p>
        <div style={{ maxHeight: 320, overflow: "auto", marginTop: 8 }}>
          {[...entries].sort((a, b) => b.version - a.version).map((e) => (
            <div key={e.version} style={{ marginBottom: 14 }}>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--pine)", letterSpacing: 1, marginBottom: 6 }}>VERSION {e.version}</div>
              {e.notes.map((n, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, color: "var(--ink)", padding: "3px 0" }}>
                  <span style={{ color: "var(--pine)", flexShrink: 0 }}>›</span>{n}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn btn-accent" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ meta, onSaveName, onOpenExport, onClose, syncEnabled, session, syncBusy, lastCloudSync, onSignOut, onManualSync }) {
  const [name, setName] = useState(meta.name || "");
  const started = meta.journeyStarted ? new Date(meta.journeyStarted).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;
  const syncedStr = lastCloudSync ? new Date(lastCloudSync).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card rise" style={{ width: 480, maxWidth: "100%", padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span className="serif" style={{ fontSize: 21 }}>Settings</span>
          <button className="btn btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="subq" style={{ marginBottom: 7 }}>PROFILE</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-accent btn-sm" onClick={() => onSaveName(name.trim())} disabled={name.trim() === (meta.name || "")}>Save</button>
        </div>
        {started && <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 16 }}>Surviving since {started}</div>}

        <div className="subq" style={{ marginBottom: 7 }}>ACCOUNT &amp; SYNC</div>
        {!syncEnabled ? (
          <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", alignItems: "center", gap: 10, background: "var(--paper2)" }}>
            <Lock size={15} color="var(--muted)" />
            <div style={{ fontSize: 12.5, color: "var(--ink2)" }}>Cloud sync isn't configured in this build.</div>
          </div>
        ) : session ? (
          <div className="card" style={{ padding: 13, marginBottom: 16, background: "var(--paper2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: syncBusy ? "var(--pine-soft)" : "var(--pine)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {syncBusy
                  ? <RotateCcw size={15} color="var(--pine)" style={{ animation: "spin 1s linear infinite" }} />
                  : <Check size={16} color="#fbf9f4" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{syncBusy ? "Syncing…" : "In sync"}</div>
                <div className="mono" style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.user?.email}</div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={onSignOut}>Sign out</button>
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.6 }}>
              {syncedStr ? <>Last synced {syncedStr}</> : "Not yet synced this session"}
              <br />Syncs on open, focus change, and device wake.
            </div>
            <button className="btn btn-sm" style={{ marginTop: 10, width: "100%" }} onClick={onManualSync} disabled={syncBusy}>
              <RotateCcw size={13} /> Sync now
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <button className="btn btn-accent" style={{ width: "100%" }} onClick={onSignIn}>
              <Link2 size={15} /> Sign in with Google to sync
            </button>
            <div className="mono" style={{ fontSize: 10, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
              Optional. Sign in to sync across your devices. Your data stays here either way.
            </div>
          </div>
        )}

        <div className="subq" style={{ marginBottom: 7 }}>DATA</div>
        <button className="btn btn-sm" style={{ width: "100%", justifyContent: "flex-start" }} onClick={onOpenExport}>
          <Download size={14} /> Export / Import your data
        </button>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
          Export anytime as a backup or to move data between devices manually.
        </div>
      </div>
    </div>
  );
}


function ExportModal({ text, onClose, onImport }) {
  const [tab, setTab] = useState("export");
  const [imp, setImp] = useState("");
  const copy = () => { try { navigator.clipboard.writeText(text); } catch (e) {} };
  const download = () => {
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "clearmind-backup.json"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {}
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card rise" style={{ width: 560, maxWidth: "100%", padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <Pill on={tab === "export"} onClick={() => setTab("export")}>Export</Pill>
            <Pill on={tab === "import"} onClick={() => setTab("import")}>Import</Pill>
          </div>
          <button className="btn btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        {tab === "export" ? (
          <>
            <p style={{ fontSize: 13, color: "var(--ink2)", marginTop: 0 }}>Your full system as JSON. Download it or copy it to move into a standalone build later.</p>
            <textarea className="input mono" readOnly rows={9} value={text} style={{ fontSize: 11 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn btn-accent" onClick={download}><Download size={15} /> Download .json</button>
              <button className="btn" onClick={copy}><Clipboard size={15} /> Copy</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "var(--ink2)", marginTop: 0 }}>Paste a previously exported JSON to restore. This replaces current data.</p>
            <textarea className="input mono" rows={9} placeholder="Paste JSON here…" value={imp} onChange={(e) => setImp(e.target.value)} style={{ fontSize: 11 }} />
            <button className="btn btn-clay" style={{ marginTop: 12 }} onClick={() => onImport(imp)}><Upload size={15} /> Restore</button>
          </>
        )}
      </div>
    </div>
  );
}
