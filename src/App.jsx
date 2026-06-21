import { useState, useEffect, useMemo, useRef } from "react";
import {
  Inbox, Zap, FolderKanban, Hourglass, Moon, BookOpen, Repeat,
  CheckCircle2, Plus, Trash2, Calendar, ChevronRight, ChevronDown,
  Check, X, Download, Upload, RotateCcw, Flame, Sparkles, ArrowRight,
  AlertTriangle, Sun, ListChecks, Send, Clipboard, Filter, Pencil, Settings2,
  Archive, Lock, Link2, Compass, Mountain, Target, ShoppingBag, Shield, Menu,
  Leaf, Timer, TreePine, ArrowUp, ArrowDown
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
  plants: "gtd:plants",
  seenVersion: "gtd:seenVersion",
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
const APP_VERSION = 19;

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
  13: {
    notes: [
      "Fixed XP and ₲ not syncing across devices after completing or clarifying tasks.",
      "Added a 300ms push debounce so completing a task (which triggers both a state change and an XP award) syncs as one coherent update.",
      "Fixed delete sync — deleting a task now correctly propagates even when the refunded XP caused the other device to think its copy was more progressed.",
    ],
  },
  14: {
    notes: [
      "App now fills the full screen on desktop, tablet, and mobile — no more fixed 760px window.",
      "Sidebar is now toggleable on desktop — click the menu icon in the top bar to collapse or expand, and the preference is remembered.",
      "iPad layout fixed — proper safe areas on all sides in both portrait and landscape.",
      "Pixel-art avatars now render crisply on all devices including high-DPI Retina screens.",
    ],
  },
  15: {
    notes: [
      "Welcome to the Greenhouse — Clearmind is now a calm, growth-focused system. No threats, no decay, only forward momentum.",
      "Your first plant is waiting: a Pothos cutting has been added to your greenhouse. Keep it growing with focus sessions.",
      "New Focus Timer — start any Next Action to enter focused work mode. Every minute you focus earns your plant one XP.",
      "Plants evolve through four stages as they earn focus XP — from a cutting to a lush, mature specimen.",
      "Seeds (❀) replace the old currency glyph. Your balance is unchanged.",
    ],
    migrate: (all) => {
      const game = { ...(all.game || {}) };
      delete game.inSiege;
      delete game.siegeBrokenAt;
      const plants = all.plants || {
        active: "plant-starter",
        owned: [{ id: "plant-starter", species: "pothos", xp: 0, stage: 0, maxed: false, plantedAt: Date.now(), nickname: null }],
      };
      return { ...all, game, plants };
    },
  },
  16: {
    notes: [
      "Fixed a bug where the What's New changelog wasn't showing after updates on synced devices.",
    ],
  },
  17: {
    notes: [
      "Goals can now link to a Vision, and Visions to a Purpose — building your full H3→H4→H5 hierarchy in Goals · Vision · Purpose.",
      "All goals, visions, and purposes are now editable in-place — pencil icon to fix a typo, links survive the edit.",
      "When clarifying an inbox item into a Next Action, you can now attach it to a project or area in the same step — or spin up a new project inline.",
      "New tab: The Canopy — a tree view of your full hierarchy from Purpose down to Actions, with Outline and Map modes.",
      "Actions can now live directly under an Area of Focus without needing a project.",
    ],
    migrate: (all) => {
      const horizons = { ...(all.horizons || {}) };
      horizons.goals  = (horizons.goals  || []).map((g) => ({ visionId: null,   ...g }));
      horizons.vision = (horizons.vision || []).map((v) => ({ purposeId: null,  ...v }));
      const items = (all.items || []).map((it) => ({ areaId: null, ...it }));
      return { ...all, horizons, items };
    },
  },
  18: {
    notes: [
      "Projects and Areas of Focus can now be renamed — gear icon on projects, pencil icon on areas.",
      "Drag-free reordering: up/down arrows let you arrange projects and areas exactly how you like.",
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
   GAME ENGINE (pure functions, no storage, no UI)
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
  { min: 1, name: "Sprout" }, { min: 3, name: "Seedling" }, { min: 5, name: "Gardener" },
  { min: 7, name: "Cultivator" }, { min: 10, name: "Botanist" }, { min: 13, name: "Horticulturist" },
  { min: 16, name: "Greenskeeper" }, { min: 20, name: "Master Gardener" },
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

// Cosmetic gear catalog (gear is visual only; rank gates tier, Seeds buy item)
/* ============================================================================
   COSMETICS — avatars (8-bit pixel art) and themes (palette swaps)
   Avatars are drawn from compact 12-row grids: each string is a row, each char
   a palette key. "." = transparent. Recoloring = swapping the palette map.
============================================================================ */
// Avatars: each entry has id, name, tier, cost, tile color, and either
// a `src` (base64 PNG — crips pixel art rendered with image-rendering:pixelated)
// or a `grid`+`pal` (legacy SVG grid, used for placeholder entries).
const AVATARS = [
  { id: "av-f-survivor", name: "Grower (F)", tier: 1, cost: 0, tile: "#2c6a55",
    src: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAABgcEAQP/xAAmEAACAgICAQQCAwEAAAAAAAABAgMEBREGEiEABxMxIjIIFVFh/8QAGQEAAgMBAAAAAAAAAAAAAAAAAQIAAwQF/8QAJxEAAQIFAwMFAQAAAAAAAAAAAQIDAAQRITEFBhITQVEVI2Gx0fH/2gAMAwEAAhEDEQA/AI1VhN6WVBO8MMLdJHjK/IX0G6r2BA8EEsQfsAAkkp2XHzC7FXrXrRgI7TvPCjOq+f0deq9iQPBRuvkkn8VJPks2fw96W9jLnStbZe6dVPVwuvpt/YH2P88/Q9I+I+3mZ5hx+nzLl3IcZjMI+QGOgluzwRpsqxeQhpoR1XqNhSXbXhWC+uzrU/qjU+57hQnAAxTtbFT5/kZXUv8AMq5UEbb2NWOJWxYeCUyIriSSSdShYBjqSTYKjZGiN6IIOwV8D3isvUmZGljVX7J4DoxIVtbPXfVgVP0QfJGmNY5f7C2OM8dtZy/muHNXrdO4PH68H7OqD857EcY8sP2Yb+hskAxFqk68ryK1J8RNRp3ZKq2scXSOwkbEK8cYZoujb7eN/uSDs79NtrUp9MylkqK0HIzT5qfH1WBK9YGijURuylipUwuZa1RhtvZqCGs8tSKcV3IkUkd9Mm/kDd42DK0Ue1cbAae1PBeQ5T22x2bw2JtZWi8kkMtahZSCaGRJ+zuOzp+MqiJHKMH1Cg+gCobMVbeToWaWOrGxKOoc/LHGqHYIBLsNnQ3obI2N62Nuv4r5n3XMmUwPBrWGevU1PNSzXyfGhJZT06fkp39jY8gf99Dc7cuqcV0lVNiq+Dj8tFr6UOAgHuKw0zXDEmoUuO8YuYnOcgxVez/d18Pkaq2uzu0cQTs4ctSTddTIqdY5gE1+UQjsgK5/OxNjWxjxZKSF6jSd2idFVGDNs9mLKSTttkn8m+zX+X+9vvZxnkGTwtvjvDLM+MKrYesspXbRJKAoadXY9ZF+l+/A36iWCu38qt3M5KX5reRuy25pdKvyO52zaXQG27eAAP8APT7TbHqHIXoDEYbTzKgb4zH/2Q==" },
  { id: "av-m-survivor", name: "Grower (M)", tier: 1, cost: 0, tile: "#3a4a63",
    src: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAGgAAAQUBAAAAAAAAAAAAAAAABwEDBQYIBP/EACkQAAIBAwMDBAEFAAAAAAAAAAECAwQFEQYSIQAHExQiMUEyI1FhgfD/xAAYAQADAQEAAAAAAAAAAAAAAAABAwUCBv/EACcRAAEDAgUDBQEAAAAAAAAAAAECAxEAIQQGEkFhBTGBInGhscHw/9oADAMBAAIRAxEAPwACamuj22mRYVzNNkIx+FxjJ/k8/wC+5Gx0dLbtMPebutRdS8KzbWqZowucYVdrqfv3M2cn8Rhd0kRq22V1fRpWUsKSQ0zSrJ+sgclVR32xlt7hVZWYqpAByTwcJPfrhSWujpa+13KnpTSwhQ4jEcsZXCuBJCchtjEckHBx8ddDmPGvuYsttL9KbWMbCfM0vEBagAg+9X2SwrTUFtrLppmOgguqBqV4L3JLMgJnCM0bSk7WWnZ0kCSROCvJ5HVdQ5aVd27xzSRbtu3dscruxk4zjOMnGcZPz1yQXzSNJUPJDbtRwT0+d7JDRK0fO05xDkcnH946eiqrXUwu9rp7+krS7y1dLT+L3EOxIVA3KsSMcZI+ujlvqL7WKKF6lJUO1zBkXubCO9YZKgu8wfP3Tldd6q32Ktt9O9tAqxIy+qQb0d4vFI0TZG0tGdpzkcDGDknR9n7X6M7k2W0alseoJ6F4YkRWoYomRVjZvCFR0PjKZfGMEEsD+OBlCm1OkNXWU0/lSGWfiqpJNsqqpAGCcgrjccfuxIx0YOw2jdP3GjShp+7V801cZm4gort6P1bO7BPFHx5CVRd2GYg7QQPgTOtvsv4pSm0abnnVzx/b0XACqCI/aKt57XaV1FLb9G0CXulpbUk8bVTWGVHMrSeSaWSpqAKeaN3VcJFGWDFWQiIMBni+U3pNTXum9a9cYLnUweqfG6cRytGrnbxkqi/HVx750Oqu3OrqOyDuJrm4W+4UKyxS111qFSWTfIskQdZFQEKIzgg/mMlQc9DyknppVMdOyjxexo9u0x44wVPK/B4I+ureUcO2HlO6xMQBvff42nmKY2kTIr//2Q==" },
  { id: "av-f-scout",    name: "Forager (F)",  tier: 2, cost: 140,  tile: "#bd5b27", src: null },
  { id: "av-m-ranger",   name: "Forager (M)",  tier: 2, cost: 140,  tile: "#3f6b3a", src: null },
  { id: "av-f-warden",   name: "Tender (F)",   tier: 4, cost: 480,  tile: "#1f4e3e", src: null },
  { id: "av-m-warden",   name: "Tender (M)",   tier: 4, cost: 480,  tile: "#2a2a2a", src: null },
  { id: "av-f-architect",name: "Botanist (F)", tier: 6, cost: 1100, tile: "#7a2e1a", src: null },
  { id: "av-m-architect",name: "Botanist (M)", tier: 6, cost: 1100, tile: "#3a2e10", src: null },
];

// Themes recolor the whole palette (buttons + backdrop) via a class on .gtd.
// "vars" override the base CSS variables. tier gates access, cost is in ₲.
const THEMES = [
  { id: "theme-settlement", name: "Greenhouse", tier: 1, cost: 0, swatch: "#2c6a55", vars: null },
  { id: "theme-dusk", name: "Dusk Garden", tier: 2, cost: 220, swatch: "#3a4a63",
    vars: { "--paper": "#eef0f4", "--paper2": "#e2e6ee", "--card": "#f8fafc", "--line": "#d4dae6", "--line2": "#c2cad9", "--pine": "#3a4a63", "--pine-d": "#27324a", "--pine-soft": "#dde3ef", "--clay": "#c2763a", "--clay-soft": "#f0e4d6", "--amber": "#b08518" } },
  { id: "theme-ember", name: "Terracotta", tier: 4, cost: 520, swatch: "#7a2e1a",
    vars: { "--paper": "#f4ece6", "--paper2": "#ece0d6", "--card": "#fbf6f1", "--line": "#e3d2c4", "--line2": "#d6c0ad", "--pine": "#a23a28", "--pine-d": "#7a2418", "--pine-soft": "#f0ddd4", "--clay": "#c2762a", "--clay-soft": "#f3e4d2", "--amber": "#bf7b1a" } },
  { id: "theme-mono", name: "Stone & Linen", tier: 3, cost: 360, swatch: "#3a3a3a",
    vars: { "--paper": "#ecebe8", "--paper2": "#e0dfdb", "--card": "#f7f6f3", "--line": "#d8d6d0", "--line2": "#c6c4bc", "--pine": "#3a3a38", "--pine-d": "#222220", "--pine-soft": "#e0e0db", "--clay": "#8a6a4a", "--clay-soft": "#e8e2d8", "--amber": "#9a8a4a" } },
  { id: "theme-bloom", name: "Wisteria", tier: 5, cost: 700, swatch: "#7a4a8a",
    vars: { "--paper": "#f3eef4", "--paper2": "#e9e1ec", "--card": "#fbf8fc", "--line": "#e0d4e6", "--line2": "#cebcd6", "--pine": "#7a4a8a", "--pine-d": "#5a3468", "--pine-soft": "#ece0f0", "--clay": "#c25a8a", "--clay-soft": "#f3dde8", "--amber": "#c08a16" } },
];

/* ============================================================================
   PLANT CATALOG — species definitions, stages, per-stage art
============================================================================ */
const PLANT_CATALOG = {
  pothos: {
    name: "Pothos", genus: "Epipremnum", species: "aureum",
    blurb: "Nearly unkillable and happy in low light. Likes to trail and be forgotten about — in a good way.",
    cost: 0, emoji: "🌿", tile: "#4a8a6a",
    stages: [
      { name: "Cutting",  xpToNext: 30,   src: "data:image/png;base64,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", tile: "#c8e6c9" },
      { name: "Rooted",   xpToNext: 90,   src: "data:image/png;base64,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", tile: "#81c784" },
      { name: "Trailing", xpToNext: 200,  src: "data:image/png;base64,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", tile: "#4caf50" },
      { name: "Lush",     xpToNext: null, src: "data:image/png;base64,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", tile: "#2e7d32" },
    ],
  },
  succulent: {
    name: "Echeveria", genus: "Echeveria", species: "elegans",
    blurb: "Stores water in its rosette of fleshy leaves. Thrives on neglect and bright indirect light.",
    cost: 500, emoji: "🌵", tile: "#80b4a4",
    stages: [
      { name: "Offset",  xpToNext: 50,  src: null, tile: "#b2dfdb" },
      { name: "Rosette", xpToNext: 150, src: null, tile: "#80cbc4" },
      { name: "Clump",   xpToNext: 300, src: null, tile: "#4db6ac" },
      { name: "Colony",  xpToNext: null, src: null, tile: "#00897b" },
    ],
  },
  snake_plant: {
    name: "Snake Plant", genus: "Dracaena", species: "trifasciata",
    blurb: "Thrives in any light and survives months without water. A quiet, steadfast companion.",
    cost: 1000, emoji: "🗡️", tile: "#558b2f",
    stages: [
      { name: "Pup",     xpToNext: 100,  src: null, tile: "#dcedc8" },
      { name: "Cluster", xpToNext: 300, src: null, tile: "#aed581" },
      { name: "Stand",   xpToNext: 600, src: null, tile: "#7cb342" },
      { name: "Grove",   xpToNext: null, src: null, tile: "#558b2f" },
    ],
  },
  monstera: {
    name: "Monstera", genus: "Monstera", species: "deliciosa",
    blurb: "The Swiss cheese plant — fenestrations open up as it matures into something truly dramatic.",
    cost: 2000, emoji: "🌴", tile: "#2e7d32",
    stages: [
      { name: "Seedling",    xpToNext: 200,  src: null, tile: "#c8e6c9" },
      { name: "Juvenile",    xpToNext: 600, src: null, tile: "#66bb6a" },
      { name: "Fenestrated", xpToNext: 1200, src: null, tile: "#388e3c" },
      { name: "Statement",   xpToNext: null, src: null, tile: "#1b5e20" },
    ],
  },
  fiddle_leaf: {
    name: "Fiddle-Leaf Fig", genus: "Ficus", species: "lyrata",
    blurb: "Dramatic, sculptural, and famously picky. Worth every fuss once it settles in.",
    cost: 3000, emoji: "🍃", tile: "#3e5c2a",
    stages: [
      { name: "Sapling",   xpToNext: 300,  src: null, tile: "#dcedc8" },
      { name: "Branching", xpToNext: 900, src: null, tile: "#9ccc65" },
      { name: "Standard",  xpToNext: 1800, src: null, tile: "#558b2f" },
      { name: "Canopy",    xpToNext: null, src: null, tile: "#33691e" },
    ],
  },
};

/* ============================================================================
   THEME / STYLE
============================================================================ */
const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

.gtd { --paper:#f3efe6; --paper2:#ece7da; --card:#fbf9f4; --ink:#221f1a; --ink2:#5c554a;
  --muted:#938b7c; --line:#e2dccd; --line2:#d4cdba; --pine:#2c6a55; --pine-d:#1f4e3e;
  --clay:#bd5b27; --clay-soft:#f0e2d4; --pine-soft:#dfeae3; --amber:#c08a16;
  font-family:'IBM Plex Sans',sans-serif; color:var(--ink); background:var(--paper);
  -webkit-font-smoothing:antialiased; }
.gtd * { box-sizing:border-box; }
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
.xp-bar { height:5px; border-radius:6px; background:var(--paper2); overflow:hidden; }
.xp-bar > i { display:block; height:100%; background:var(--amber); border-radius:6px; transition:width .5s ease; }
.gear-card { border:1px solid var(--line2); border-radius:11px; padding:12px; background:var(--card); display:flex; flex-direction:column; gap:8px; }
.gear-card.equipped { border-color:var(--pine); box-shadow:0 0 0 2px var(--pine-soft); }
.gear-card.locked { opacity:.55; }
.raid { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--card); cursor:pointer; transition:all .13s; }
.raid:hover { background:var(--paper2); border-color:var(--line2); }
.subq { font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--muted); letter-spacing:1.5px; font-style:normal; vertical-align:middle; margin-left:6px; }

/* ---- App shell layout (desktop default = two columns) ---- */
/* ---- App shell: full viewport on all screen sizes ---- */
.app-shell {
  position:relative; display:flex; overflow:hidden;
  /* Fill full viewport — no fixed 760px cap */
  height:100dvh; height:100vh; /* dvh for iOS, vh fallback */
  border-radius:0; border:none;
}
/* On larger screens, add a subtle inner border and rounded feel */
@media (min-width: 1024px) {
  #root { padding:16px; }
  .app-shell { border-radius:14px; border:1px solid var(--line); height:calc(100dvh - 32px); height:calc(100vh - 32px); }
}

.sidebar {
  width:248px; flex-shrink:0; background:var(--paper2);
  border-right:1px solid var(--line);
  padding:18px 13px; display:flex; flex-direction:column; overflow:auto;
  transition:width .2s ease, padding .2s ease;
  /* iPad landscape: respect left safe area */
  padding-left:max(13px, calc(13px + env(safe-area-inset-left, 0px)));
}
/* Collapsed sidebar on desktop */
.app-shell.sidebar-collapsed .sidebar {
  width:0; padding:0; border-right:none; overflow:hidden;
}
.sidebar-toggle {
  display:inline-flex; align-items:center; justify-content:center;
  width:30px; height:30px; border-radius:7px;
  border:1px solid var(--line2); background:var(--card);
  color:var(--ink); cursor:pointer; flex-shrink:0;
  transition:background .12s;
}
.sidebar-toggle:hover { background:var(--paper2); }

.mobile-topbar { display:none; }
.drawer-backdrop { display:none; }
.hamburger { display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px;
  border-radius:9px; border:1px solid var(--line2); background:var(--card); color:var(--ink); cursor:pointer; }
.hamburger:hover { background:var(--paper2); }

/* ---- Tablet (iPad): sidebar is permanent but narrower, safe areas on both sides ---- */
@media (min-width: 761px) and (max-width: 1023px) {
  #root { padding:0; }
  .app-shell { border-radius:0; border:none; height:100dvh; }
  .sidebar { width:220px; padding-top:calc(18px + env(safe-area-inset-top, 0px)); }
  .app-shell.sidebar-collapsed .sidebar { width:0; }
  .content-scroll { padding-bottom:calc(16px + env(safe-area-inset-bottom, 0px)); }
  .main-col { padding-right:env(safe-area-inset-right, 0px); }
}

/* ---- Mobile / narrow screens: sidebar is an off-canvas drawer ---- */
@media (max-width: 760px) {
  #root { padding:0; }
  .app-shell { height:100dvh; border-radius:0; border:none; }
  .mobile-topbar { display:flex; align-items:center; gap:11px;
    padding:10px 14px;
    padding-top:calc(10px + env(safe-area-inset-top, 0px));
    border-bottom:1px solid var(--line); background:var(--card); flex-shrink:0; }
  .sidebar {
    position:absolute; top:0; left:0; bottom:0; z-index:60; width:264px; max-width:84vw;
    transform:translateX(-100%); transition:transform .24s ease; box-shadow:0 0 0 rgba(0,0,0,0);
    padding-top:calc(18px + env(safe-area-inset-top, 0px));
    /* Reset collapsed state — on mobile the drawer handles open/close */
    width:264px !important; padding-left:13px !important;
  }
  .app-shell.drawer-open .sidebar { transform:translateX(0); box-shadow:6px 0 24px rgba(0,0,0,.22); }
  .app-shell.drawer-open .drawer-backdrop {
    display:block; position:absolute; inset:0; z-index:55; background:rgba(20,16,14,.42);
    animation:fade .2s ease;
  }
  /* Sidebar toggle not needed on mobile — drawer handles it */
  .sidebar-toggle { display:none; }
  .content-scroll { padding:16px !important; padding-bottom:calc(16px + env(safe-area-inset-bottom, 0px)) !important; }
  .strip { gap:10px; padding:7px 12px; flex-wrap:wrap; }
  .strip .seg { font-size:11px; }
}
/* Desktop: sidebar toggle visible, mobile chrome hidden */
@media (min-width: 761px) {
  .mobile-topbar, .drawer-backdrop { display:none !important; }
  .sidebar { transform:none !important; }
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
function Clarify({ item, contexts, projects, areas, onClose, onTransform, onDelete, onCreateProject }) {
  const [title, setTitle] = useState(item.title);
  const [notes, setNotes] = useState(item.notes || "");
  const [step, setStep] = useState("decide");
  const [ctx, setCtx] = useState(contexts[0]);
  const [energy, setEnergy] = useState("medium");
  const [time, setTime] = useState("15m");
  const [recur, setRecur] = useState("");
  const [who, setWho] = useState("");
  const [date, setDate] = useState(todayStr());
  const [projectId, setProjectId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [showNewProj, setShowNewProj] = useState(false);
  const [newProjTitle, setNewProjTitle] = useState("");
  const [newProjAreaId, setNewProjAreaId] = useState("");

  const base = () => ({ ...item, title: title.trim() || item.title, notes });

  const commitNew = () => {
    if (!newProjTitle.trim()) return;
    const pid = onCreateProject(newProjTitle.trim(), newProjAreaId || null);
    setProjectId(pid);
    setAreaId("");
    setShowNewProj(false);
    setNewProjTitle(""); setNewProjAreaId("");
  };

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

            <div style={{ marginTop: 14 }}>
              <div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Project (optional)</div>
              {showNewProj ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <input className="input" autoFocus placeholder="New project — desired outcome…"
                    value={newProjTitle} onChange={(e) => setNewProjTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && commitNew()} />
                  {areas.length > 0 && (
                    <select className="input" value={newProjAreaId} onChange={(e) => setNewProjAreaId(e.target.value)}>
                      <option value="">— no area —</option>
                      {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                  )}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm btn-accent" onClick={commitNew}><Plus size={13} /> Create & assign</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setShowNewProj(false); setNewProjTitle(""); setNewProjAreaId(""); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6 }}>
                  <select className="input" style={{ flex: 1 }} value={projectId}
                    onChange={(e) => { setProjectId(e.target.value); if (e.target.value) setAreaId(""); }}>
                    <option value="">— none —</option>
                    {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowNewProj(true)}><Plus size={13} /> New</button>
                </div>
              )}
              {!projectId && !showNewProj && areas.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="tag-ink" style={{ fontSize: 12, marginBottom: 6 }}>Or attach to an area</div>
                  <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                    <option value="">— none —</option>
                    {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button className="btn btn-accent" onClick={() => onTransform({ ...base(), type: "next", done: false, context: ctx, energy, time, recur: recur || null, projectId: projectId || null, areaId: (!projectId && areaId) ? areaId : null })}>
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
  const [game, setGame] = useState({ xp: 0, gtd: 0, ownedCosmetics: ["av-f-survivor", "av-m-survivor", "theme-settlement"], equipped: { avatar: "av-f-survivor", theme: "theme-settlement" }, lastTended: null });
  const [plants, setPlants] = useState({ active: "plant-starter", owned: [{ id: "plant-starter", species: "pothos", xp: 0, stage: 0, maxed: false, plantedAt: Date.now(), nickname: null }] });
  const [toasts, setToasts] = useState([]);
  const [focusItemId, setFocusItemId] = useState(null);
  const [evolutionData, setEvolutionData] = useState(null);

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("clearmind-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const toggleSidebar = () => setSidebarCollapsed(v => {
    const next = !v;
    try { localStorage.setItem("clearmind-sidebar-collapsed", String(next)); } catch {}
    return next;
  });
  const captureRef = useRef(null);
  const aside_touchX = useRef(null);

  // stateRef always holds the latest committed values of every data slice.
  // snapshot() reads from here so it's never one render behind (the stale
  // closure problem that caused pushed data to be missing the latest change).
  const stateRef = useRef({ items:[], projects:[], habits:[], log:{}, settings:{ contexts: DEFAULT_CONTEXTS, lastReview: null }, areas:[], horizons:{ goals:[], vision:[], purpose:[] }, game:{ xp:0, gtd:0, ownedCosmetics:["av-f-survivor","av-m-survivor","theme-settlement"], equipped:{ avatar:"av-f-survivor", theme:"theme-settlement" }, lastTended:null }, plants:{ active:"plant-starter", owned:[{ id:"plant-starter", species:"pothos", xp:0, stage:0, maxed:false, plantedAt:Date.now(), nickname:null }] }, meta:{ version: APP_VERSION, name:"" } });

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
        game: await store.load(KEYS.game, { xp: 0, gtd: 0, ownedCosmetics: ["av-f-survivor", "av-m-survivor", "theme-settlement"], equipped: { avatar: "av-f-survivor", theme: "theme-settlement" }, lastTended: null }),
        plants: await store.load(KEYS.plants, { active: "plant-starter", owned: [{ id: "plant-starter", species: "pothos", xp: 0, stage: 0, maxed: false, plantedAt: Date.now(), nickname: null }] }),
      };
      const savedMeta = await store.load(KEYS.meta, null);
      const seenV = await store.load(KEYS.seenVersion, null);

      // decide: new user, returning-outdated, or current
      const isNew = !savedMeta || typeof savedMeta.version !== "number";
      // For users without a seenVersion yet, use their pre-migration data version as the
      // baseline so they only see notes for versions they haven't encountered before.
      const preMigrationV = savedMeta?.version ?? 0;
      const effectiveSeenV = seenV !== null ? seenV : (isNew ? APP_VERSION : preMigrationV);

      if (isNew) {
        // brand-new: stamp current version, open onboarding
        const m = { version: APP_VERSION, name: "", createdAt: Date.now(), journeyStarted: Date.now() };
        setMeta(m); store.save(KEYS.meta, m);
        store.save(KEYS.seenVersion, APP_VERSION);
        applyLoaded(loaded);
        setOnboarding(true);
      } else if (savedMeta.version < APP_VERSION) {
        // returning on an old save: migrate data, persist
        const { data } = runMigrations(loaded, savedMeta.version);
        applyLoaded(data);
        // persist any reshaped slices
        store.save(KEYS.game, data.game);
        store.save(KEYS.horizons, data.horizons);
        store.save(KEYS.settings, data.settings);
        store.save(KEYS.items, data.items);
        const m = { ...savedMeta, version: APP_VERSION, journeyStarted: savedMeta.journeyStarted || savedMeta.createdAt || Date.now(), updatedAt: savedMeta.updatedAt || savedMeta.journeyStarted || savedMeta.createdAt || Date.now() };
        setMeta(m); store.save(KEYS.meta, m);
      } else {
        // up to date
        setMeta(savedMeta);
        applyLoaded(loaded);
      }

      // Show What's New for any versions this device hasn't seen yet.
      // We stamp seenVersion NOW (before syncWithCloud can push meta.version
      // to APP_VERSION from the cloud, which would make effectiveSeenV look
      // current and skip the modal on synced devices that never saw the notes).
      // The watermark is preMigrationV — the version the local data was at
      // when this device opened. seenVersion is updated to APP_VERSION only
      // after the user actually closes the modal.
      const changelogBaseline = seenV !== null ? seenV : (isNew ? APP_VERSION : preMigrationV);
      if (!isNew && changelogBaseline < APP_VERSION) {
        const pending = [];
        for (let v = changelogBaseline + 1; v <= APP_VERSION; v++) {
          const m = MIGRATIONS[v];
          if (m && Array.isArray(m.notes)) pending.push({ version: v, notes: m.notes });
        }
        if (pending.length) {
          setWhatsNew(pending);
          // Stamp seenVersion to preMigrationV now. This prevents the modal
          // from re-showing on every reload if the user dismisses it before
          // syncWithCloud fires (seenVersion will advance to APP_VERSION on close).
          // It also prevents synced devices from skipping the modal because
          // their meta.version was already bumped by the cloud.
          if (seenV === null) store.save(KEYS.seenVersion, preMigrationV);
        }
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

  const xpOf = (b) => (b?.game?.xp || 0) + ((b?.plants?.owned || []).reduce((s, p) => s + (p.xp || 0), 0));
  // Content count used as tiebreaker when XP is equal — catches inbox items,
  // projects, areas, and waiting-for entries which don't generate XP.
  const countOf = (b) => (b?.items?.length || 0) + (b?.projects?.length || 0) + (b?.areas?.length || 0);
  // Reads from stateRef so it is always current even in async/stale-closure contexts.
  const snapshot = () => ({ version: APP_VERSION, ...stateRef.current });

  function applyLoaded(d) {
    setItems(d.items); setProjects(d.projects); setHabits(d.habits); setLog(d.log);
    setSettings(d.settings); setAreas(d.areas); setHorizons(d.horizons); setGame(d.game);
    if (d.plants) setPlants(d.plants);
    // seed stateRef so snapshot() is immediately correct after load
    stateRef.current = { items: d.items, projects: d.projects, habits: d.habits, log: d.log,
      settings: d.settings, areas: d.areas, horizons: d.horizons, game: d.game,
      plants: d.plants || stateRef.current.plants, meta: stateRef.current.meta };
  }

  // Guard: true while we're applying a cloud blob. The push-on-change effect
  // checks this and skips, so a pull never causes a push.
  const isApplying = useRef(false);

  const applyBlob = (blob) => {
    let b = { items: blob.items||[], projects: blob.projects||[], habits: blob.habits||[],
      log: blob.log||{}, settings: blob.settings||{ contexts: DEFAULT_CONTEXTS, lastReview: null },
      areas: blob.areas||[], horizons: blob.horizons||{ goals:[], vision:[], purpose:[] }, game: blob.game||game,
      plants: blob.plants||plants };
    const fromV = typeof blob.version === "number" ? blob.version : 0;
    if (fromV < APP_VERSION) b = runMigrations(b, fromV).data;
    isApplying.current = true;
    saveItems(b.items); saveProjects(b.projects); saveHabits(b.habits);
    saveLog(b.log); saveSettings(b.settings); saveAreas(b.areas);
    saveHorizons(b.horizons); saveGame(b.game); savePlants(b.plants);
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

  // Push after any user-driven data change (skipped when isApplying is true).
  // 300ms debounce: completing a task triggers saveItems + award() in sequence.
  // Without the debounce, the first effect run (after saveItems) would push a
  // snapshot where XP hasn't updated yet. The debounce lets all synchronous
  // state updates settle before we read stateRef and push.
  const pushTimer = useRef(null);
  const firstChange = useRef(true);
  useEffect(() => {
    if (!loaded) return;
    if (firstChange.current) { firstChange.current = false; return; }
    if (isApplying.current) return; // cloud pull in progress — don't echo it back
    const stamped = { ...stateRef.current.meta, updatedAt: Date.now() };
    saveMeta(stamped);
    if (syncEnabled && session) {
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => { pushCloud(session); }, 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, projects, habits, log, settings, areas, horizons, game, plants]);


  // ---- persisted setters — each also updates stateRef so snapshot() is never stale ----
  const saveItems    = (v) => { setItems(v);    store.save(KEYS.items, v);    stateRef.current = { ...stateRef.current, items: v }; };
  const saveProjects = (v) => { setProjects(v); store.save(KEYS.projects, v); stateRef.current = { ...stateRef.current, projects: v }; };
  const saveHabits   = (v) => { setHabits(v);   store.save(KEYS.habits, v);   stateRef.current = { ...stateRef.current, habits: v }; };
  const saveLog      = (v) => { setLog(v);       store.save(KEYS.log, v);      stateRef.current = { ...stateRef.current, log: v }; };
  const saveSettings = (v) => { setSettings(v); store.save(KEYS.settings, v); stateRef.current = { ...stateRef.current, settings: v }; };
  const saveAreas    = (v) => { setAreas(v);    store.save(KEYS.areas, v);    stateRef.current = { ...stateRef.current, areas: v }; };
  const saveHorizons = (v) => { setHorizons(v); store.save(KEYS.horizons, v); stateRef.current = { ...stateRef.current, horizons: v }; };
  const saveGame     = (v) => { setGame(v);     store.save(KEYS.game, v);     stateRef.current = { ...stateRef.current, game: v }; };
  const savePlants   = (v) => { setPlants(v);   store.save(KEYS.plants, v);   stateRef.current = { ...stateRef.current, plants: v }; };
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
  // award (or reclaim, with negative xp/gtd) — XP/Seeds clamped at 0.
  const award = (xp, gtd, msg) => {
    const g = stateRef.current.game;
    const ng = { ...g, lastTended: Date.now() };
    const beforeLvl = levelFromXP(g.xp);
    ng.xp = Math.max(0, g.xp + (xp || 0));
    ng.gtd = Math.max(0, g.gtd + (gtd || 0));
    setGame(ng);
    store.save(KEYS.game, ng);
    stateRef.current = { ...stateRef.current, game: ng };
    const afterLvl = levelFromXP(ng.xp);
    if (msg) {
      const bits = [];
      if (xp) bits.push(`${xp > 0 ? "+" : ""}${xp} XP`);
      if (gtd) bits.push(`${gtd > 0 ? "+" : ""}${gtd} ❀`);
      pushToast(`${msg}${bits.length ? "  " + bits.join("  ") : ""}`);
    }
    if (afterLvl > beforeLvl) setTimeout(() => pushToast(`◆ Level up — Level ${afterLvl}, ${rankFor(afterLvl)}`), 700);
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

      award(ax, ag, "✓ Done");
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
      award(10, 0, "Clarified → new project");
      if (remainingInbox === 0) setTimeout(() => award(50, 20, "◆ Inbox clear"), 500);
      return;
    }
    const { _makeProject, ...clean } = next;
    updateItem(next.id, clean);
    setClarifyId(null);
    award(10, 0, "Clarified");
    if (remainingInbox === 0) setTimeout(() => award(50, 20, "◆ Inbox clear"), 500);
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
  const moveProject = (id, dir) => {
    const activeIds = projects.filter((p) => p.status === "active").map((p) => p.id);
    const pos = activeIds.indexOf(id);
    const swapId = activeIds[pos + dir];
    if (!swapId) return;
    const i1 = projects.findIndex((p) => p.id === id);
    const i2 = projects.findIndex((p) => p.id === swapId);
    const next = [...projects];
    [next[i1], next[i2]] = [next[i2], next[i1]];
    saveProjects(next);
  };

  // ---- area ops (Horizon 2) ----
  const addArea = (title) => { if (!title.trim()) return; saveAreas([...areas, { id: uid(), title: title.trim(), notes: "", createdAt: Date.now() }]); };
  const updateArea = (id, patch) => saveAreas(areas.map((a) => a.id === id ? { ...a, ...patch } : a));
  const moveArea = (id, dir) => {
    const idx = areas.findIndex((a) => a.id === id);
    const swap = idx + dir;
    if (swap < 0 || swap >= areas.length) return;
    const next = [...areas];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    saveAreas(next);
  };
  const deleteArea = (id) => {
    saveAreas(areas.filter((a) => a.id !== id));
    saveProjects(projects.map((p) => p.areaId === id ? { ...p, areaId: null } : p)); // unfile, don't delete projects
    saveHorizons({ ...horizons, goals: (horizons.goals || []).map((g) => g.areaId === id ? { ...g, areaId: null } : g) });
    if (openArea === id) setOpenArea(null);
  };
  const assignProjectArea = (pid, areaId) => updateProject(pid, { areaId });

  // ---- horizon ops (3 Goals / 4 Vision / 5 Purpose) ----
  const addHorizon = (key, text, areaId = null) => {
    if (!text.trim()) return;
    saveHorizons({ ...horizons, [key]: [...(horizons[key] || []), { id: uid(), text: text.trim(), areaId: areaId || null, visionId: null, purposeId: null }] });
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
        if (milestone) setTimeout(() => award(milestone, milestone, `◆ ${milestone}-day streak`), 500);
      } else {
        nl[k] = { at: Date.now(), xp: 0, gtd: 0 };
        saveLog(nl);
      }
    }
  };

  // ---- weekly review (available Fri–Sun, once per weekend) ----
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
      pushToast(gate.doneThisWeekend ? "Already tended this weekend. Come back next Friday." : "Weekly tending is on the weekend (Fri–Sun).");
      return;
    }
    const today = todayStr();
    saveSettings({ ...settings, lastReview: today });
    const g = stateRef.current.game;
    const ng = { ...g, lastTended: Date.now() };
    ng.xp = g.xp + 200;
    ng.gtd = g.gtd + 100;
    saveGame(ng);
    pushToast("◆◆ GREENHOUSE TENDED  +200 XP  +100 ❀");
    const after = levelFromXP(ng.xp), before = levelFromXP(g.xp);
    if (after > before) setTimeout(() => pushToast(`◆ Level up — Level ${after}, ${rankFor(after)}`), 800);
  };

  // ---- plant ops ----
  const addPlantXp = (minutes) => {
    if (!minutes || minutes <= 0) return;
    const p = stateRef.current.plants;
    if (!p || !p.active) return;
    const plantIdx = (p.owned || []).findIndex((x) => x.id === p.active);
    if (plantIdx === -1) return;
    const plant = { ...p.owned[plantIdx] };
    if (plant.maxed) return;
    plant.xp = (plant.xp || 0) + minutes;
    const speciesData = PLANT_CATALOG[plant.species];
    if (!speciesData) { savePlants({ ...p, owned: p.owned.map((x, i) => i === plantIdx ? plant : x) }); return; }
    let evolved = false;
    while (plant.stage < speciesData.stages.length - 1) {
      const stageData = speciesData.stages[plant.stage];
      if (stageData.xpToNext !== null && plant.xp >= stageData.xpToNext) { plant.stage += 1; evolved = true; }
      else break;
    }
    if (plant.stage >= speciesData.stages.length - 1) plant.maxed = true;
    savePlants({ ...p, owned: p.owned.map((x, i) => i === plantIdx ? plant : x) });
    if (evolved) setTimeout(() => setEvolutionData({ plant, speciesData }), 200);
  };
  const buyPlant = (speciesKey) => {
    const spec = PLANT_CATALOG[speciesKey];
    if (!spec) return;
    const g = stateRef.current.game;
    if (g.gtd < spec.cost) return;
    const p = stateRef.current.plants;
    const alreadyOwns = (p.owned || []).some((x) => x.species === speciesKey);
    if (alreadyOwns) return;
    const newPlant = { id: "plant-" + uid(), species: speciesKey, xp: 0, stage: 0, maxed: false, plantedAt: Date.now(), nickname: null };
    saveGame({ ...g, gtd: g.gtd - spec.cost });
    savePlants({ ...p, owned: [...(p.owned || []), newPlant], active: newPlant.id });
    pushToast(`${spec.emoji} ${spec.name} planted in your greenhouse`);
  };
  const setActivePlant = (id) => {
    const p = stateRef.current.plants;
    savePlants({ ...p, active: id });
  };

  // ---- cosmetics (avatars + themes) ----
  const ownsCosmetic = (id) => (stateRef.current.game.ownedCosmetics || []).includes(id);
  const buyCosmetic = (item) => {
    const g = stateRef.current.game;
    if (ownsCosmetic(item.id) || g.gtd < item.cost) return;
    saveGame({ ...g, gtd: g.gtd - item.cost, ownedCosmetics: [...(g.ownedCosmetics || []), item.id] });
    pushToast(`Acquired: ${item.name}`);
  };
  const equipCosmetic = (kind, item) => {
    if (!ownsCosmetic(item.id)) return;
    const g = stateRef.current.game;
    saveGame({ ...g, equipped: { ...g.equipped, [kind]: item.id } });
  };

  // ---- export / import ----
  const exportData = () => JSON.stringify({
    version: APP_VERSION, exportedAt: new Date().toISOString(), items, projects, habits, log, settings, areas, horizons, game, plants, meta,
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
        plants: d.plants || plants,
      };
      const fromV = typeof d.version === "number" ? d.version : 0;
      if (fromV < APP_VERSION) bundle = runMigrations(bundle, fromV).data;
      saveItems(bundle.items); saveProjects(bundle.projects); saveHabits(bundle.habits);
      saveLog(bundle.log); saveSettings(bundle.settings); saveAreas(bundle.areas);
      saveHorizons(bundle.horizons); saveGame(bundle.game); savePlants(bundle.plants);
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

  const lvl = levelProgress(game.xp);
  const rank = rankFor(lvl.level);
  const goGreenhouse = () => setView("greenhouse");

  if (!loaded) {
    return (
      <div className="gtd" style={{ height: 720, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{STYLE}</style>
        <div className="serif" style={{ color: "var(--muted)" }}>Opening your system…</div>
      </div>
    );
  }

  const NAV = [
    { id: "greenhouse", label: "The Greenhouse", icon: Leaf },
    { id: "today", label: "Today", icon: Sun, count: inbox.length + filteredNexts.length, hot: inbox.length > 0 },
    { id: "projects", label: "Projects", icon: FolderKanban, count: activeProjects.length, warn: stalled.length },
    { id: "waiting", label: "Waiting For", icon: Hourglass, count: waiting.length },
    { id: "calendar", label: "Scheduled", icon: Calendar, count: scheduled.length },
    { id: "someday", label: "Someday / Maybe", icon: Moon, count: somedays.length },
    { id: "reference", label: "Reference", icon: BookOpen, count: refs.length },
    { section: "Higher Horizons" },
    { id: "areas", label: "Areas of Focus", icon: Compass, count: areas.length },
    { id: "horizons", label: "Goals · Vision · Purpose", icon: Mountain },
    { id: "canopy", label: "The Canopy", icon: TreePine },
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
            <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: 1 }}>GTD · GREENHOUSE</div>
          </div>
        </div>
        <p style={{ fontSize: 14, color: "var(--ink2)", textAlign: "center", maxWidth: 280, margin: 0, lineHeight: 1.5 }}>
          Sign in to sync your greenhouse across every device.
        </p>
        {syncBusy
          ? <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>Signing in…</div>
          : <button className="btn btn-accent" style={{ minWidth: 220 }} onClick={() => signInWithGoogle()}>
              <Link2 size={16} /> Sign in with Google
            </button>}
      </div>
    )}
    {(!syncEnabled || session) && (
    <div className={"gtd app-shell" + (drawerOpen ? " drawer-open" : "") + (sidebarCollapsed ? " sidebar-collapsed" : "")}
      style={themeById(game.equipped?.theme).vars || undefined}>
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
            <div className="mono" style={{ fontSize: 9.5, color: "var(--muted)", letterSpacing: 1 }}>GTD · GREENHOUSE</div>
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

        {/* STATUS STRIP — glanceable, doorway to the Greenhouse */}
        {/* Sidebar toggle sits here on desktop so it's always accessible */}
        <div style={{ display: "flex", alignItems: "stretch" }}>
          <button className="sidebar-toggle" title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            onClick={toggleSidebar} style={{ margin: "0 0 0 10px", alignSelf: "center" }}>
            <Menu size={15} />
          </button>
          <div style={{ flex: 1 }}>
            <StatusStrip lvl={lvl} rank={rank} gtd={game.gtd} plants={plants} onClick={goGreenhouse} />
          </div>
        </div>

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
          {view === "greenhouse" && <Greenhouse {...{ lvl, rank, game, buyCosmetic, equipCosmetic, plants, buyPlant, setActivePlant }} />}
          {view === "today" && <TodayView {...{ inbox, nextsByCtx, filteredNexts, scheduled, todayHabits, log, toggleLog, stalled, setView, toggleDone, projName, daysSinceReview, onEdit: setEditId, items, name: meta.name, onStart: setFocusItemId, contexts, ctxFilter, setCtxFilter, blockedCount, onManageCtx: () => setCtxMgrOpen(true), setClarifyId }} />}
          {view === "projects" && <ProjectsView {...{ activeProjects, allItems: items, projectNexts, expanded, setExpanded, addProject, updateProject, deleteProject, addActionToProject, toggleDone, updateItem, isBlocked, contexts, onEdit: setEditId, areas, assignProjectArea, onStart: setFocusItemId, moveProject }} />}
          {view === "waiting" && <WaitingView {...{ waiting, toggleDone, updateItem, deleteItem, onEdit: setEditId }} />}
          {view === "calendar" && <CalendarView {...{ scheduled, toggleDone, deleteItem, onEdit: setEditId }} />}
          {view === "someday" && <SomedayView {...{ somedays, updateItem, deleteItem, onEdit: setEditId }} />}
          {view === "reference" && <ReferenceView {...{ refs, deleteItem, updateItem, onEdit: setEditId }} />}
          {view === "habits" && <HabitsView {...{ habits, log, toggleLog, addHabit, deleteHabit, updateHabit, purposes: horizons.purpose || [], setView }} />}
          {view === "review" && <ReviewView {...{ inbox, nexts, waiting, stalled, somedays, setView, settings, daysSinceReview, completeReview, gate: reviewAllowed() }} />}
          {view === "archive" && <ArchiveView {...{ completedItems, completedProjects, projName, restoreItem, deleteItem, reactivateProject, deleteProject }} />}
          {view === "areas" && <AreasView {...{ areas, projects, activeProjects, projectNexts, isBlocked, addArea, updateArea, deleteArea, assignProjectArea, toggleDone, openArea, setOpenArea, onEdit: setEditId, horizons, items, setView, moveArea }} />}
          {view === "horizons" && <HorizonsView {...{ horizons, areas, addHorizon, updateHorizon, deleteHorizon, setView, setOpenArea }} />}
          {view === "canopy" && <CanopyView {...{ horizons, areas, projects: activeProjects, items, setView, setOpenArea }} />}
        </div>
      </main>

      {/* TOASTS */}
      <div className="toast">
        {toasts.map((t) => <div key={t.id} className="t">{t.msg}</div>)}
      </div>

      {clarifyItem && (
        <Clarify item={clarifyItem} contexts={contexts} projects={activeProjects} areas={areas}
          onCreateProject={(title, areaId) => {
            const pid = uid();
            saveProjects([{ id: pid, title, outcome: "", notes: "", status: "active", areaId: areaId || null, createdAt: Date.now() }, ...projects]);
            setExpanded((e) => ({ ...e, [pid]: true }));
            return pid;
          }}
          onClose={() => setClarifyId(null)}
          onTransform={handleTransform}
          onDelete={(id) => { deleteItem(id); setClarifyId(null); }} />
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
      {!onboarding && whatsNew && <WhatsNewModal name={meta.name} entries={whatsNew} onClose={() => { store.save(KEYS.seenVersion, APP_VERSION); setWhatsNew(null); }} />}
      {focusItemId && (
        <FocusModal item={items.find((i) => i.id === focusItemId)} plants={plants}
          onDone={(minutes) => { addPlantXp(minutes); toggleDone(focusItemId); setFocusItemId(null); }}
          onCancel={(minutes) => { addPlantXp(minutes); setFocusItemId(null); }} />
      )}
      {evolutionData && (
        <EvolutionModal data={evolutionData} onClose={() => setEvolutionData(null)} />
      )}
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

function ActionRow({ item, toggleDone, projName, showCtx, onEdit, items, onStart }) {
  return (
    <div className="row act-row">
      <div className={"checkbox" + (item.done ? " done" : "")} onClick={() => toggleDone(item.id)}>
        {item.done && <Check size={13} color="#fbf9f4" />}
      </div>
      <div style={{ flex: 1, minWidth: 0, cursor: onEdit ? "pointer" : "default" }} onClick={() => onEdit && onEdit(item.id)}>
        <div style={{ fontSize: 14, textDecoration: item.done ? "line-through" : "none", color: item.done ? "var(--muted)" : "var(--ink)" }}>
          {item.title}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap", alignItems: "center" }}>
          {showCtx && item.context && <span className="pill pill-ctx">{item.context}</span>}
          {item.energy && <span className="pill">{item.energy}</span>}
          {item.time && <span className="pill">{item.time}</span>}
          {item.recur && <span className="pill" style={{ color: "var(--clay)" }}><Repeat size={9} style={{ verticalAlign: -1 }} /> {item.recur}</span>}
          {item.dueDate && <span className="pill">{relDate(item.dueDate)}</span>}
          {item.projectId && projName && projName(item.projectId) && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>↳ {projName(item.projectId)}</span>
          )}
        </div>
      </div>
      {onStart && !item.done && item.type === "next" && (
        <button className="btn btn-ghost btn-sm edit-btn" title="Focus session" onClick={(e) => { e.stopPropagation(); onStart(item.id); }}>
          <Timer size={13} />
        </button>
      )}
      {onEdit && <button className="btn btn-ghost btn-sm edit-btn" onClick={() => onEdit(item.id)}><Pencil size={13} /></button>}
    </div>
  );
}

function TodayView({ inbox, nextsByCtx, filteredNexts, scheduled, todayHabits, log, toggleLog, stalled, setView, toggleDone, projName, onEdit, items, name, onStart, contexts, ctxFilter, setCtxFilter, blockedCount, onManageCtx, setClarifyId }) {
  const todayScheduled = scheduled.filter((i) => i.dueDate <= todayStr());
  const first = (name || "").trim().split(" ")[0];
  const ctxKeys = Object.keys(nextsByCtx).sort();
  const [collapsedCtxs, setCollapsedCtxs] = useState(() => new Set());
  const [showFilter, setShowFilter] = useState(true);

  const toggleCtx = (k) => setCollapsedCtxs((prev) => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });

  return (
    <div className="stagger">
      <SectionTitle sub={new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}>
        {first ? `Good to see you, ${first}` : "Good to see you"}
      </SectionTitle>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, alignItems: "start" }}>
        {/* LEFT — Next Actions with context filter */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span className="serif" style={{ fontSize: 16 }}>
              <Zap size={14} style={{ verticalAlign: -2, color: "var(--pine)" }} /> Next Actions
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>{filteredNexts.length}</span>
            </span>
            <button className="btn btn-ghost btn-sm" title={showFilter ? "Hide filter" : "Show filter"} onClick={() => setShowFilter((v) => !v)}>
              <Filter size={13} style={{ color: showFilter ? "var(--pine)" : "var(--muted)" }} />
            </button>
          </div>

          {showFilter && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              <Pill on={ctxFilter === "all"} onClick={() => setCtxFilter("all")}>all</Pill>
              {contexts.map((c) => <Pill key={c} on={ctxFilter === c} onClick={() => setCtxFilter(c)}>{c}</Pill>)}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={onManageCtx}><Settings2 size={13} /> Contexts</button>
            </div>
          )}

          {blockedCount > 0 && (
            <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
              <Lock size={11} /> {blockedCount} action{blockedCount > 1 ? "s" : ""} hidden — waiting on a precursor
            </div>
          )}

          {filteredNexts.length === 0
            ? <Empty icon={Zap} title="Nothing queued" sub="Process your inbox to surface actions." />
            : ctxKeys.map((k) => {
              const collapsed = collapsedCtxs.has(k);
              return (
                <div key={k} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, cursor: "pointer", userSelect: "none" }} onClick={() => toggleCtx(k)}>
                    <span className="mono pill pill-ctx" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {k}
                      <span style={{ fontSize: 10, color: "var(--muted)" }}>{nextsByCtx[k].length}</span>
                    </span>
                    {collapsed ? <ChevronRight size={13} color="var(--muted)" /> : <ChevronDown size={13} color="var(--muted)" />}
                  </div>
                  {!collapsed && (
                    <div className="card" style={{ overflow: "hidden" }}>
                      {nextsByCtx[k].map((i) => <ActionRow key={i.id} item={i} toggleDone={toggleDone} projName={projName} onEdit={onEdit} items={items} onStart={onStart} />)}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {/* RIGHT — Inbox + Habits + Due/Scheduled + Stalled */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {inbox.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="serif" style={{ fontSize: 16 }}><Inbox size={14} style={{ verticalAlign: -2, color: "var(--clay)" }} /> Inbox</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--clay)" }}>{inbox.length}</span>
              </div>
              {inbox.map((i) => (
                <div key={i.id} className="row" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => setClarifyId(i.id)}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5 }}>{i.title}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>{relDate(isoDate(new Date(i.createdAt)))}</div>
                  </div>
                  <button className="btn btn-accent btn-sm" onClick={(e) => { e.stopPropagation(); setClarifyId(i.id); }}>Clarify <ArrowRight size={12} /></button>
                </div>
              ))}
            </div>
          )}

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

          {todayScheduled.length > 0 && (
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

function NextView({ nextsByCtx, contexts, ctxFilter, setCtxFilter, toggleDone, projName, count, blockedCount, onEdit, onManageCtx, items, onStart }) {
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
              {nextsByCtx[k].map((i) => <ActionRow key={i.id} item={i} toggleDone={toggleDone} projName={projName} onEdit={onEdit} items={items} onStart={onStart} />)}
            </div>
          </div>
        ))}
    </div>
  );
}

function ProjectsView({ activeProjects, allItems, projectNexts, expanded, setExpanded, addProject, updateProject, deleteProject, addActionToProject, toggleDone, updateItem, isBlocked, contexts, onEdit, areas, assignProjectArea, onStart, moveProject }) {
  const [np, setNp] = useState("");
  const [menuFor, setMenuFor] = useState(null); // project id whose settings menu is open
  const [menuPos, setMenuPos] = useState(null); // {top,right} anchor for the fixed popover
  const [confirmDel, setConfirmDel] = useState(null); // project id pending delete confirm
  const [renameId, setRenameId] = useState(null);
  const [renameText, setRenameText] = useState("");
  const areaName = (id) => areas.find((a) => a.id === id)?.title;
  const menuProject = activeProjects.find((p) => p.id === menuFor);
  return (
    <>
    <div className="stagger">
      <SectionTitle sub="Any outcome needing more than one step. Chain tasks with precursors so only what's truly doable surfaces as a next action.">Projects</SectionTitle>
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
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <button className="btn btn-sm btn-ghost" title="Move up" style={{ padding: "3px 5px" }}
                    onClick={() => moveProject(p.id, -1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button className="btn btn-sm btn-ghost" title="Move down" style={{ padding: "3px 5px" }}
                    onClick={() => moveProject(p.id, 1)}>
                    <ArrowDown size={13} />
                  </button>
                  <button className="btn btn-sm btn-ghost" title="Project settings"
                    onClick={(e) => {
                      if (menuFor === p.id) { setMenuFor(null); return; }
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
                      setMenuFor(p.id); setConfirmDel(null); setRenameId(null);
                    }}>
                    <Settings2 size={14} />
                  </button>
                </div>
              </div>
              {open && <ProjectBody p={p} acts={acts} addActionToProject={addActionToProject} toggleDone={toggleDone}
                updateItem={updateItem} isBlocked={isBlocked} allItems={allItems} contexts={contexts} onEdit={onEdit} onStart={onStart} />}
            </div>
          );
        })}
    </div>

    {/* Settings popover rendered at the view root — outside .stagger, so no transformed
        ancestor hijacks position:fixed. This is what keeps it from being clipped by a card. */}
    {menuProject && menuPos && (
      <>
        <div style={{ position: "fixed", inset: 0, zIndex: 80 }} onClick={() => { setMenuFor(null); setConfirmDel(null); }} />
        <div className="card" style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 81, width: 250, padding: 10, boxShadow: "0 10px 28px rgba(0,0,0,.20)" }}>
          <div style={{ marginBottom: 10 }}>
            <div className="subq" style={{ marginBottom: 5 }}>RENAME</div>
            {renameId === menuProject.id ? (
              <div style={{ display: "flex", gap: 5 }}>
                <input className="input" style={{ flex: 1, padding: "5px 8px", fontSize: 12.5 }} value={renameText}
                  autoFocus
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && renameText.trim()) { updateProject(menuProject.id, { title: renameText.trim() }); setRenameId(null); setMenuFor(null); }
                    if (e.key === "Escape") setRenameId(null);
                  }} />
                <button className="btn btn-accent btn-sm" onClick={() => { if (renameText.trim()) { updateProject(menuProject.id, { title: renameText.trim() }); setRenameId(null); setMenuFor(null); } }}><Check size={13} /></button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "flex-start" }}
                onClick={() => { setRenameId(menuProject.id); setRenameText(menuProject.title); }}>
                <Pencil size={13} /> Edit name…
              </button>
            )}
          </div>
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

function ProjectBody({ p, acts, addActionToProject, toggleDone, updateItem, isBlocked, allItems, contexts, onEdit, onStart }) {
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
              {onStart && !i.done && <button className="btn btn-ghost btn-sm edit-btn" title="Focus session" onClick={() => onStart(i.id)}><Timer size={13} /></button>}
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

function ReviewView({ inbox, nexts, waiting, stalled, somedays, setView, settings, daysSinceReview, completeReview, gate }) {
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
      <SectionTitle sub={settings.lastReview ? `Last tended: ${settings.lastReview}${daysSinceReview != null ? ` (${daysSinceReview}d ago)` : ""}` : "The greenhouse has never had a weekly tending."}>
        Weekly Review <span className="subq">TEND · THE GREENHOUSE</span>
      </SectionTitle>
      {!gate.isWeekend && (
        <div className="card" style={{ padding: 13, marginBottom: 14, display: "flex", gap: 9, alignItems: "center" }}>
          <Calendar size={16} color="var(--muted)" />
          <span style={{ fontSize: 13, color: "var(--ink2)" }}>Weekly tending happens on the <b>weekend</b> (Fri–Sun). Walk the checklist any time, but the reward is only available then.</span>
        </div>
      )}
      {gate.isWeekend && gate.doneThisWeekend && (
        <div className="card" style={{ padding: 13, marginBottom: 14, display: "flex", gap: 9, alignItems: "center" }}>
          <Check size={16} color="var(--pine)" />
          <span style={{ fontSize: 13, color: "var(--ink2)" }}>Already tended this weekend. Come back next Friday.</span>
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
          <Leaf size={16} /> {
            !gate.isWeekend ? "Available on the weekend"
            : gate.doneThisWeekend ? "Tended — come back next Friday"
            : done < all.length ? `${done}/${all.length} — keep going`
            : "Tend the greenhouse  ·  +200 XP +100 ❀"
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

function AreasView({ areas, projects, activeProjects, projectNexts, isBlocked, addArea, updateArea, deleteArea, assignProjectArea, toggleDone, openArea, setOpenArea, onEdit, horizons, items, setView, moveArea }) {
  const [na, setNa] = useState("");
  const [renameId, setRenameId] = useState(null);
  const [renameText, setRenameText] = useState("");
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
                  {renameId === a.id ? (
                    <div style={{ display: "flex", gap: 5, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                      <input className="input" style={{ flex: 1, padding: "4px 7px", fontSize: 13.5 }} value={renameText} autoFocus
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && renameText.trim()) { updateArea(a.id, { title: renameText.trim() }); setRenameId(null); }
                          if (e.key === "Escape") setRenameId(null);
                        }} />
                      <button className="btn btn-accent btn-sm" onClick={() => { if (renameText.trim()) { updateArea(a.id, { title: renameText.trim() }); setRenameId(null); } }}><Check size={13} /></button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setRenameId(null)}><X size={13} /></button>
                    </div>
                  ) : (
                    <>
                      <div className="serif" style={{ fontSize: 16 }}>{a.title}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                        {ps.length} project{ps.length !== 1 ? "s" : ""} · {totalActionable} actionable{gs.length ? ` · ${gs.length} goal${gs.length > 1 ? "s" : ""}` : ""}
                      </div>
                    </>
                  )}
                </div>
                {renameId !== a.id && (
                  <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <button className="btn btn-sm btn-ghost" title="Rename area" style={{ padding: "3px 5px" }}
                      onClick={(e) => { e.stopPropagation(); setRenameId(a.id); setRenameText(a.title); }}>
                      <Pencil size={13} />
                    </button>
                    <button className="btn btn-sm btn-ghost" title="Move up" style={{ padding: "3px 5px" }}
                      onClick={() => moveArea(a.id, -1)}>
                      <ArrowUp size={13} />
                    </button>
                    <button className="btn btn-sm btn-ghost" title="Move down" style={{ padding: "3px 5px" }}
                      onClick={() => moveArea(a.id, 1)}>
                      <ArrowDown size={13} />
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteArea(a.id)} title="Delete area (projects are unfiled, not deleted)"><Trash2 size={13} /></button>
                  </div>
                )}
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
                  {(() => {
                    const standaloneActs = (items || []).filter((i) => i.areaId === a.id && !i.projectId && i.type === "next" && !i.done);
                    if (!standaloneActs.length) return null;
                    return (
                      <div style={{ marginTop: 14 }}>
                        <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, marginBottom: 8 }}>STANDALONE ACTIONS</div>
                        {standaloneActs.map((i) => (
                          <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
                            <div className="checkbox" style={{ width: 17, height: 17 }} onClick={() => toggleDone(i.id)} />
                            <span style={{ flex: 1, fontSize: 13, cursor: "pointer" }} onClick={() => onEdit(i.id)}>{i.title}</span>
                            {i.context && <span className="pill pill-ctx">{i.context}</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
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

function HorizonList({ hkey, list, areas, visions, purposes, addHorizon, updateHorizon, deleteHorizon, withArea }) {
  const [t, setT] = useState("");
  const [aid, setAid] = useState("");
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState("");

  const areaName = (id) => areas.find((a) => a.id === id)?.title;
  const parentLinkField = hkey === "goals" ? "visionId" : hkey === "vision" ? "purposeId" : null;
  const parentList = hkey === "goals" ? (visions || []) : hkey === "vision" ? (purposes || []) : [];
  const parentLabel = hkey === "goals" ? "Vision" : hkey === "vision" ? "Purpose" : null;

  const submit = () => { addHorizon(hkey, t, withArea ? aid : null); setT(""); };
  const startEdit = (x) => { setEditId(x.id); setEditText(x.text); };
  const saveEdit = (x) => { if (editText.trim()) updateHorizon(hkey, x.id, { text: editText.trim() }); setEditId(null); };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 18 }}>
      {(list || []).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {(list || []).map((x) => (
            <div key={x.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line2)", display: "flex", gap: 8, alignItems: "flex-start" }}>
              <ChevronRight size={14} color="var(--muted)" style={{ marginTop: 3, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {editId === x.id ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <textarea className="input" rows={2} autoFocus style={{ flex: 1, fontSize: 13.5, resize: "vertical" }}
                      value={editText} onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(x); } }} />
                    <button className="btn btn-accent btn-sm" onClick={() => saveEdit(x)}><Check size={13} /></button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}><X size={13} /></button>
                  </div>
                ) : (
                  <div style={{ fontSize: 14, lineHeight: 1.4 }}>{x.text}</div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, alignItems: "center" }}>
                  {withArea && (
                    <select className="input" style={{ padding: "2px 6px", fontSize: 11, width: "auto", minWidth: 110 }}
                      value={x.areaId || ""} onChange={(e) => updateHorizon(hkey, x.id, { areaId: e.target.value || null })}>
                      <option value="">— area —</option>
                      {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                  )}
                  {parentLinkField && parentList.length > 0 && (
                    <select className="input" style={{ padding: "2px 6px", fontSize: 11, width: "auto", minWidth: 130 }}
                      value={x[parentLinkField] || ""} onChange={(e) => updateHorizon(hkey, x.id, { [parentLinkField]: e.target.value || null })}>
                      <option value="">— {parentLabel} —</option>
                      {parentList.map((p) => <option key={p.id} value={p.id}>{p.text.length > 40 ? p.text.slice(0, 40) + "…" : p.text}</option>)}
                    </select>
                  )}
                </div>
              </div>
              {editId !== x.id && (
                <div style={{ display: "flex", gap: 4, flexShrink: 0, marginTop: 2 }}>
                  <button className="btn btn-ghost btn-sm edit-btn" title="Edit" onClick={() => startEdit(x)}><Pencil size={12} /></button>
                  <button className="btn btn-ghost btn-sm edit-btn btn-danger" title="Delete" onClick={() => deleteHorizon(hkey, x.id)}><Trash2 size={12} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Add a statement…" value={t}
          onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {withArea && areas.length > 0 && (
          <select className="input" style={{ width: 130 }} value={aid} onChange={(e) => setAid(e.target.value)}>
            <option value="">— no area —</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        )}
        <button className="btn btn-sm" onClick={submit}><Plus size={14} /></button>
      </div>
    </div>
  );
}

/* ============================================================================
   THE CANOPY — full hierarchy tree view (H5 → H4 → H3 → H2 → H1 → Actions)
============================================================================ */
const CANOPY_STORE_KEY = "clearmind-canopy-view";

function CanopyView({ horizons, areas, projects, items, setView, setOpenArea }) {
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(CANOPY_STORE_KEY) || "outline"; } catch { return "outline"; }
  });
  const switchMode = (m) => {
    setMode(m);
    try { localStorage.setItem(CANOPY_STORE_KEY, m); } catch {}
  };

  // Build the tree once from all slices
  const tree = useMemo(() => {
    const goals  = horizons.goals  || [];
    const visions = horizons.vision || [];
    const purposes = horizons.purpose || [];

    const areaMap  = Object.fromEntries((areas    || []).map((a) => [a.id, a]));
    const projMap  = Object.fromEntries((projects || []).map((p) => [p.id, p]));

    // Build area children (projects + standalone actions) per area
    const areaChildren = (areaId) => {
      const ps = (projects || []).filter((p) => p.areaId === areaId);
      const standalone = (items || []).filter((i) => i.areaId === areaId && !i.projectId && i.type === "next" && !i.done);
      return {
        projects: ps.map((p) => ({
          id: p.id, label: p.title, level: 1, type: "project",
          children: (items || []).filter((i) => i.projectId === p.id && i.type === "next" && !i.done)
            .map((i) => ({ id: i.id, label: i.title, level: 0, type: "action", children: [] })),
        })),
        standalone: standalone.map((i) => ({ id: i.id, label: i.title, level: 0, type: "action", children: [] })),
      };
    };

    // Build goal node (H3)
    const goalNode = (g) => {
      const area = g.areaId ? areaMap[g.areaId] : null;
      const ac = area ? areaChildren(area.id) : { projects: [], standalone: [] };
      return {
        id: g.id, label: g.text, level: 3, type: "goal",
        areaId: g.areaId,
        children: area ? [{
          id: area.id, label: area.title, level: 2, type: "area",
          children: [...ac.projects, ...ac.standalone],
        }] : [],
      };
    };

    // Build vision node (H4)
    const visionNode = (v) => ({
      id: v.id, label: v.text, level: 4, type: "vision",
      children: goals.filter((g) => g.visionId === v.id).map(goalNode),
    });

    // Build purpose node (H5)
    const purposeNode = (p) => ({
      id: p.id, label: p.text, level: 5, type: "purpose",
      children: visions.filter((v) => v.purposeId === p.id).map(visionNode),
    });

    const purposeNodes = purposes.map(purposeNode);

    // Collect orphan visions (no purpose / purpose not found)
    const linkedVisionIds = new Set(visions.filter((v) => v.purposeId && purposes.find((p) => p.id === v.purposeId)).map((v) => v.id));
    const orphanVisions = visions.filter((v) => !linkedVisionIds.has(v.id)).map(visionNode);

    // Collect orphan goals (no vision / vision not found)
    const linkedGoalIds = new Set(goals.filter((g) => g.visionId && visions.find((v) => v.id === g.visionId)).map((g) => g.id));
    const orphanGoals = goals.filter((g) => !linkedGoalIds.has(g.id)).map(goalNode);

    // Collect orphan areas (not referenced by any goal)
    const referencedAreaIds = new Set(goals.map((g) => g.areaId).filter(Boolean));
    const orphanAreas = (areas || []).filter((a) => !referencedAreaIds.has(a.id)).map((a) => {
      const ac = areaChildren(a.id);
      return { id: a.id, label: a.title, level: 2, type: "area", children: [...ac.projects, ...ac.standalone] };
    });

    return { purposeNodes, orphanVisions, orphanGoals, orphanAreas };
  }, [horizons, areas, projects, items]);

  const navigateTo = (node) => {
    if (node.type === "purpose" || node.type === "vision" || node.type === "goal") setView("horizons");
    else if (node.type === "area") { setView("areas"); setOpenArea(node.id); }
    else if (node.type === "project") setView("projects");
    else if (node.type === "action") setView("today");
  };

  const levelColors = { 5: "var(--clay)", 4: "var(--pine)", 3: "var(--amber)", 2: "var(--ink2)", 1: "var(--muted)", 0: "var(--muted)" };
  const levelLabels = { 5: "H5 PURPOSE", 4: "H4 VISION", 3: "H3 GOAL", 2: "H2 AREA", 1: "H1 PROJECT", 0: "ACTION" };

  return (
    <div className="stagger">
      <SectionTitle sub="Your full hierarchy — from purpose down to actions. A quiet map of how your work connects.">
        The Canopy
      </SectionTitle>

      <div style={{ display: "flex", gap: 6, marginBottom: 18, alignItems: "center" }}>
        <Pill on={mode === "outline"} onClick={() => switchMode("outline")}>Outline</Pill>
        <Pill on={mode === "map"} onClick={() => switchMode("map")}>Map</Pill>
      </div>

      {mode === "outline"
        ? <CanopyOutline tree={tree} navigateTo={navigateTo} levelColors={levelColors} levelLabels={levelLabels} />
        : <CanopyMap tree={tree} navigateTo={navigateTo} levelColors={levelColors} />}
    </div>
  );
}

function CanopyOutline({ tree, navigateTo, levelColors, levelLabels }) {
  const [collapsed, setCollapsed] = useState({});
  const toggle = (id) => setCollapsed((p) => ({ ...p, [id]: !p[id] }));

  const renderNode = (node, depth = 0) => {
    const hasChildren = node.children && node.children.length > 0;
    const isCollapsed = collapsed[node.id];
    const color = levelColors[node.level] || "var(--muted)";
    return (
      <div key={node.id}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "5px 0", paddingLeft: depth * 18 }}>
          {hasChildren ? (
            <button className="btn btn-ghost" style={{ padding: 2, flexShrink: 0, marginTop: 1 }} onClick={() => toggle(node.id)}>
              {isCollapsed ? <ChevronRight size={13} color="var(--muted)" /> : <ChevronDown size={13} color="var(--muted)" />}
            </button>
          ) : (
            <div style={{ width: 21, flexShrink: 0 }} />
          )}
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flex: 1, cursor: "pointer" }} onClick={() => navigateTo(node)}>
            <span className="mono" style={{ fontSize: 9, color, letterSpacing: 0.5, flexShrink: 0, paddingTop: 2 }}>{levelLabels[node.level]}</span>
            <span style={{ fontSize: 13.5, color: "var(--ink)", lineHeight: 1.4 }}>{node.label}</span>
          </div>
        </div>
        {hasChildren && !isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  const hasContent = tree.purposeNodes.length || tree.orphanVisions.length || tree.orphanGoals.length || tree.orphanAreas.length;

  return (
    <div className="card" style={{ padding: 14 }}>
      {!hasContent && <div style={{ fontSize: 13, color: "var(--muted)", padding: "8px 0" }}>Add purposes, visions, and goals in Goals · Vision · Purpose to build your tree.</div>}
      {tree.purposeNodes.map((n) => renderNode(n))}
      {tree.orphanVisions.length > 0 && (
        <>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, marginTop: 14, marginBottom: 4 }}>NOT YET LINKED TO A PURPOSE</div>
          {tree.orphanVisions.map((n) => renderNode(n))}
        </>
      )}
      {tree.orphanGoals.length > 0 && (
        <>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, marginTop: 14, marginBottom: 4 }}>NOT YET LINKED TO A VISION</div>
          {tree.orphanGoals.map((n) => renderNode(n))}
        </>
      )}
      {tree.orphanAreas.length > 0 && (
        <>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, marginTop: 14, marginBottom: 4 }}>AREAS NOT REFERENCED BY A GOAL</div>
          {tree.orphanAreas.map((n) => renderNode(n))}
        </>
      )}
    </div>
  );
}

function CanopyMap({ tree, navigateTo, levelColors }) {
  const isNarrow = typeof window !== "undefined" && window.innerWidth <= 760;
  const NODE_W = 150, NODE_H = 44, H_GAP = 14, V_GAP = 56;

  // Flatten tree into a list of {node, depth} for layout
  const allTrees = [
    ...tree.purposeNodes,
    ...tree.orphanVisions,
    ...tree.orphanGoals,
    ...tree.orphanAreas,
  ];

  // Layout: assign x,y to every node using a post-order subtree-width algorithm
  const layoutNodes = useMemo(() => {
    const placed = [];
    let cursor = 0;

    const layout = (node, depth) => {
      const entry = { node, depth, x: 0, y: depth * (NODE_H + V_GAP) };
      if (!node.children || !node.children.length) {
        entry.x = cursor;
        cursor += NODE_W + H_GAP;
        placed.push(entry);
        return entry;
      }
      const childEntries = node.children.map((c) => layout(c, depth + 1));
      entry.x = (childEntries[0].x + childEntries[childEntries.length - 1].x) / 2;
      placed.push(entry);
      return entry;
    };

    allTrees.forEach((root) => { layout(root, 0); cursor += H_GAP * 2; });

    return placed;
  }, [allTrees]);

  const totalW = Math.max(600, layoutNodes.reduce((m, e) => Math.max(m, e.x + NODE_W), 0) + H_GAP);
  const totalH = layoutNodes.reduce((m, e) => Math.max(m, e.y + NODE_H), 0) + 40;

  // Build edges: parent → children
  const edges = useMemo(() => {
    const nodePos = Object.fromEntries(layoutNodes.map((e) => [e.node.id, e]));
    const lines = [];
    const walk = (node) => {
      if (!node.children) return;
      node.children.forEach((child) => {
        const p = nodePos[node.id];
        const c = nodePos[child.id];
        if (p && c) {
          const x1 = p.x + NODE_W / 2, y1 = p.y + NODE_H;
          const x2 = c.x + NODE_W / 2, y2 = c.y;
          const mid = (y1 + y2) / 2;
          lines.push({ key: `${node.id}-${child.id}`, d: `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}` });
        }
        walk(child);
      });
    };
    allTrees.forEach(walk);
    return lines;
  }, [layoutNodes, allTrees]);

  if (isNarrow) {
    return (
      <div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 10 }}>Map mode works best on larger screens. Showing outline instead.</div>
        <CanopyOutline tree={tree} navigateTo={navigateTo} levelColors={levelColors} levelLabels={{ 5: "H5 PURPOSE", 4: "H4 VISION", 3: "H3 GOAL", 2: "H2 AREA", 1: "H1 PROJECT", 0: "ACTION" }} />
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto", overflowY: "auto", borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper2)", padding: 16 }}>
      <svg width={totalW} height={totalH} style={{ display: "block" }}>
        {edges.map((e) => (
          <path key={e.key} d={e.d} fill="none" stroke="var(--line)" strokeWidth={1.5} />
        ))}
        {layoutNodes.map(({ node, x, y }) => {
          const color = levelColors[node.level] || "var(--muted)";
          return (
            <g key={node.id} style={{ cursor: "pointer" }} onClick={() => navigateTo(node)}>
              <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={8} ry={8}
                fill="var(--card)" stroke={color} strokeWidth={1.5} />
              <text x={x + NODE_W / 2} y={y + 14} textAnchor="middle"
                fontSize={9} fill={color} fontFamily="IBM Plex Mono" letterSpacing={0.5}>
                {({ 5: "PURPOSE", 4: "VISION", 3: "GOAL", 2: "AREA", 1: "PROJECT", 0: "ACTION" })[node.level] || ""}
              </text>
              <foreignObject x={x + 6} y={y + 18} width={NODE_W - 12} height={NODE_H - 20}>
                <div xmlns="http://www.w3.org/1999/xhtml" style={{ fontSize: 11.5, color: "var(--ink)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", lineHeight: 1.35 }}>
                  {node.label}
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function HorizonsView({ horizons, areas, addHorizon, updateHorizon, deleteHorizon }) {
  return (
    <div className="stagger">
      <SectionTitle sub="The higher altitudes. These aren't task lists — they're statements you read during review to keep everything below them pointed in the right direction.">Goals · Vision · Purpose <span className="subq">THE SIGNAL</span></SectionTitle>

      <HorizonHeading icon={Target} color="var(--amber)" code="H3" title="Goals" blurb="What you want to accomplish in the next 1–2 years. Link each to the area it serves and the vision it advances." />
      <HorizonList hkey="goals" list={horizons.goals} areas={areas} visions={horizons.vision} purposes={horizons.purpose} addHorizon={addHorizon} updateHorizon={updateHorizon} deleteHorizon={deleteHorizon} withArea />

      <HorizonHeading icon={Mountain} color="var(--pine)" code="H4" title="Vision" blurb="Where you're headed in 3–5 years — the longer arc your goals ladder up to. Link each to the purpose it serves." />
      <HorizonList hkey="vision" list={horizons.vision} areas={areas} visions={horizons.vision} purposes={horizons.purpose} addHorizon={addHorizon} updateHorizon={updateHorizon} deleteHorizon={deleteHorizon} />

      <HorizonHeading icon={Sparkles} color="var(--clay)" code="H5" title="Purpose & Principles" blurb="Why any of it matters, and the standards you hold. The view from the top." />
      <HorizonList hkey="purpose" list={horizons.purpose} areas={areas} visions={horizons.vision} purposes={horizons.purpose} addHorizon={addHorizon} updateHorizon={updateHorizon} deleteHorizon={deleteHorizon} />
    </div>
  );
}

// Renders an avatar. If the avatar has a src (base64 PNG), display it as a
// crisp pixel-art image. Fallback: solid tile color placeholder for avatars
// not yet drawn (future Piskel artwork). size controls the rendered square.
function AvatarPixels({ avatar, size = 56 }) {
  const a = avatar || AVATARS[0];
  if (a.src) {
    // Use background-image rather than <img> — Safari on iOS/iPadOS respects
    // image-rendering:pixelated more reliably on background images than on <img>.
    // background-size:100% 100% scales the 32x32 PNG to fill the tile without blur.
    return (
      <div style={{
        width: size, height: size, borderRadius: 10, flexShrink: 0,
        backgroundImage: `url("${a.src}")`,
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
        // Webkit vendor prefix for older Safari
        WebkitImageRendering: "pixelated",
      }} role="img" aria-label={a.name} />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: 10, flexShrink: 0,
      background: a.tile || "var(--pine)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <span style={{ fontSize: size * 0.35, opacity: 0.5 }}>?</span>
    </div>
  );
}
const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
const avatarById = (id) => AVATARS.find((a) => a.id === id) || AVATARS[0];

function Glyph() { return <span style={{ color: "var(--pine)", fontWeight: 700 }}>❀</span>; }

function StatusStrip({ lvl, rank, gtd, plants, onClick }) {
  const activePlant = plants && plants.active ? (plants.owned || []).find((p) => p.id === plants.active) : null;
  const speciesData = activePlant ? PLANT_CATALOG[activePlant.species] : null;
  const stageData = speciesData && activePlant ? speciesData.stages[activePlant.stage] : null;
  return (
    <div className="strip" onClick={onClick} title="Open the Greenhouse">
      <div className="seg" style={{ gap: 8 }}>
        <Leaf size={14} color="var(--pine)" />
        {activePlant && speciesData ? (
          <>
            <PlantSprite species={activePlant.species} stage={activePlant.stage} size={26} />
            <span style={{ color: "var(--pine)", fontWeight: 600 }}>{speciesData.name}</span>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>{stageData ? stageData.name : ""}</span>
            {stageData && stageData.xpToNext && (
              <div className="xp-bar" style={{ width: 48 }}>
                <i style={{ width: `${Math.min(100, Math.round(((activePlant.xp || 0) / stageData.xpToNext) * 100))}%` }} />
              </div>
            )}
          </>
        ) : <span style={{ color: "var(--muted)", fontSize: 12 }}>No active plant</span>}
      </div>
      <div className="seg">
        <span style={{ color: "var(--amber)", fontWeight: 600 }}>LV {lvl.level}</span>
        <div className="xp-bar" style={{ width: 54 }}><i style={{ width: `${lvl.pct}%` }} /></div>
        <span style={{ color: "var(--muted)" }}>{rank}</span>
      </div>
      <div className="seg" style={{ marginLeft: "auto" }}>
        <Glyph /><span style={{ fontWeight: 600 }}>{gtd}</span>
      </div>
      <Leaf size={13} color="var(--muted)" />
    </div>
  );
}

function PlantSprite({ species, stage, size = 64 }) {
  const speciesData = PLANT_CATALOG[species];
  if (!speciesData) return null;
  const stageData = speciesData.stages[stage] || speciesData.stages[0];
  if (stageData.src) {
    return <img src={stageData.src} alt={stageData.name} width={size} height={size} style={{ imageRendering: "pixelated", display: "block" }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: 10, background: stageData.tile, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
      <span style={{ fontSize: size * 0.38 }}>{speciesData.emoji}</span>
      <span style={{ fontSize: size * 0.13, color: "rgba(255,255,255,.8)", fontFamily: "IBM Plex Mono" }}>{stageData.name}</span>
    </div>
  );
}

function Greenhouse({ lvl, rank, game, buyCosmetic, equipCosmetic, plants, buyPlant, setActivePlant }) {
  const avatar = avatarById(game.equipped?.avatar);
  const owned = (id) => (game.ownedCosmetics || []).includes(id);
  const activePlant = plants.active ? (plants.owned || []).find((p) => p.id === plants.active) : null;
  const activeSpecies = activePlant ? PLANT_CATALOG[activePlant.species] : null;

  return (
    <div className="stagger">
      <SectionTitle sub="Your plants, your grower, your collection — a space to breathe and grow.">
        The Greenhouse
      </SectionTitle>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* ACTIVE PLANT CARD */}
        <div className="card" style={{ padding: 16 }}>
          <div className="subq" style={{ marginBottom: 10 }}>ACTIVE PLANT</div>
          {activePlant && activeSpecies ? (
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <PlantSprite species={activePlant.species} stage={activePlant.stage} size={72} />
              <div style={{ flex: 1 }}>
                <div className="serif" style={{ fontSize: 18 }}>{activePlant.nickname || activeSpecies.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  {activeSpecies.stages[activePlant.stage]?.name} · {activePlant.xp} XP
                </div>
                {!activePlant.maxed && activeSpecies.stages[activePlant.stage]?.xpToNext && (
                  <div style={{ marginTop: 8 }}>
                    <div className="xp-bar" style={{ height: 7 }}>
                      <i style={{ width: `${Math.min(100, Math.round((activePlant.xp / activeSpecies.stages[activePlant.stage].xpToNext) * 100))}%` }} />
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                      {activeSpecies.stages[activePlant.stage].xpToNext - activePlant.xp} XP to {activeSpecies.stages[activePlant.stage + 1]?.name}
                    </div>
                  </div>
                )}
                {activePlant.maxed && <div className="pill on" style={{ marginTop: 6, display: "inline-block" }}>Fully grown ✦</div>}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "16px 0" }}>No active plant — buy one in the Potting Shed below.</div>
          )}
        </div>

        {/* GROWER CARD */}
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
              <div className="subq">SEEDS</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }} className="mono">
            <span style={{ color: "var(--muted)" }}>{game.xp} XP</span>
            <span style={{ color: "var(--muted)" }}>{lvl.ceil - game.xp} to Lv {lvl.level + 1}</span>
          </div>
          <div className="xp-bar" style={{ marginTop: 5, height: 7 }}><i style={{ width: `${lvl.pct}%` }} /></div>
        </div>
      </div>

      {/* COLLECTION */}
      {(plants.owned || []).length > 1 && (
        <>
          <div className="subq" style={{ marginBottom: 8 }}>YOUR COLLECTION</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
            {(plants.owned || []).map((p) => {
              const spec = PLANT_CATALOG[p.species];
              if (!spec) return null;
              const isActive = p.id === plants.active;
              return (
                <div key={p.id} className={"gear-card" + (isActive ? " equipped" : "")} style={{ alignItems: "center", textAlign: "center", cursor: "pointer" }} onClick={() => setActivePlant(p.id)}>
                  <PlantSprite species={p.species} stage={p.stage} size={52} />
                  <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.1 }}>{p.nickname || spec.name}</span>
                  <div style={{ marginTop: "auto" }}>
                    {isActive ? <span className="pill on">active</span>
                      : <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setActivePlant(p.id); }}>Tend</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* POTTING SHED — plant + cosmetic shop */}
      <div className="subq" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <ShoppingBag size={12} /> POTTING SHED
      </div>

      {/* SEEDLINGS — buy new plants */}
      <div className="subq" style={{ marginBottom: 7, color: "var(--pine)" }}>SEEDLINGS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 18 }}>
        {Object.entries(PLANT_CATALOG).map(([key, spec]) => {
          const ownedPlant = (plants.owned || []).find((p) => p.species === key);
          const affordable = game.gtd >= spec.cost;
          return (
            <div key={key} className="gear-card" style={{ alignItems: "center", textAlign: "center" }}>
              <div style={{ margin: "4px auto" }}><PlantSprite species={key} stage={0} size={56} /></div>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{spec.name}</span>
              <span style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.3 }}>{spec.blurb}</span>
              <div style={{ marginTop: "auto" }}>
                {ownedPlant ? <span className="pill on">in your greenhouse</span>
                  : spec.cost === 0 ? <span className="pill">free (starter)</span>
                  : <button className="btn btn-sm" disabled={!affordable} onClick={() => buyPlant(key)} style={{ opacity: affordable ? 1 : .5 }}>
                      <Glyph />{spec.cost}
                    </button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* GROWERS — avatar shop */}
      <div className="subq" style={{ marginBottom: 7, color: "var(--pine)" }}>GROWERS</div>
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
                  : <button className="btn btn-sm" disabled={!affordable} onClick={() => buyCosmetic(a)} style={{ opacity: affordable ? 1 : .5 }}><Glyph />{a.cost}</button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* THEMES */}
      <div className="subq" style={{ marginBottom: 7, color: "var(--clay)" }}>THEMES — RECOLOR THE APP</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {THEMES.map((t) => {
          const isOwned = owned(t.id);
          const isEquipped = game.equipped?.theme === t.id;
          const tierLocked = rankTier(lvl.level) < t.tier;
          const affordable = game.gtd >= t.cost;
          const sw = t.vars ? [t.vars["--paper"], t.vars["--pine"], t.vars["--clay"], t.vars["--amber"]] : ["#f3efe6", "#2c6a55", "#bd5b27", "#c08a16"];
          return (
            <div key={t.id} className={"gear-card" + (isEquipped ? " equipped" : "") + (tierLocked ? " locked" : "")}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", flexShrink: 0, border: "1px solid var(--line2)" }}>
                  {sw.map((col, i) => <div key={i} style={{ width: 12, height: 22, background: col }} />)}
                </div>
                <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.1 }}>{t.name}</span>
              </div>
              <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>theme · T{t.tier}</span>
                {isEquipped ? <span className="pill on">active</span>
                  : isOwned ? <button className="btn btn-sm" onClick={() => equipCosmetic("theme", t)}>Apply</button>
                  : tierLocked ? <span className="pill" style={{ display: "inline-flex", gap: 3, alignItems: "center" }}><Lock size={9} /> tier {t.tier}</span>
                  : <button className="btn btn-sm" disabled={!affordable} onClick={() => buyCosmetic(t)} style={{ opacity: affordable ? 1 : .5 }}><Glyph />{t.cost}</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FocusModal({ item, plants, onDone, onCancel }) {
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState(null);
  const [totalPaused, setTotalPaused] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (paused) {
      clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setElapsed(Date.now() - startTime - totalPaused);
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [paused, startTime, totalPaused]);

  const minutes = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const activePlant = plants?.active ? (plants.owned || []).find((p) => p.id === plants.active) : null;
  const speciesData = activePlant ? PLANT_CATALOG[activePlant.species] : null;

  const togglePause = () => {
    if (paused) {
      setTotalPaused((t) => t + (Date.now() - pausedAt));
      setPausedAt(null);
    } else {
      setPausedAt(Date.now());
    }
    setPaused((p) => !p);
  };

  return (
    <div className="overlay" style={{ alignItems: "center" }}>
      <div className="card rise" style={{ width: 440, maxWidth: "100%", padding: 26, textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, justifyContent: "center" }}>
          <Timer size={18} color="var(--pine)" />
          <span className="serif" style={{ fontSize: 20 }}>Focus Session</span>
        </div>
        <div className="serif" style={{ fontSize: 15, color: "var(--ink2)", marginBottom: 20, lineHeight: 1.4 }}>{item?.title}</div>
        <div style={{ fontSize: 54, fontFamily: "IBM Plex Mono", fontWeight: 600, color: "var(--pine)", marginBottom: 6, letterSpacing: 2 }}>
          {String(Math.floor(elapsed / 3600000)).padStart(2, "0")}:{String(minutes % 60).padStart(2, "0")}:{String(secs).padStart(2, "0")}
        </div>
        {speciesData && activePlant && (
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>
            {speciesData.emoji} {activePlant.nickname || speciesData.name} earns 1 XP per minute
          </div>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
          <button className="btn btn-accent" onClick={() => onDone(minutes)}>
            <Check size={15} /> Done — mark complete
          </button>
          <button className="btn btn-ghost" onClick={() => onCancel(minutes)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function EvolutionModal({ data, onClose }) {
  const { plant, speciesData } = data;
  const stageData = speciesData.stages[plant.stage];
  return (
    <div className="overlay" style={{ alignItems: "center" }} onClick={onClose}>
      <div className="card rise" style={{ width: 400, maxWidth: "100%", padding: 28, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, color: "var(--pine)", marginBottom: 8 }}>✦ Your plant evolved ✦</div>
        <PlantSprite species={plant.species} stage={plant.stage} size={96} />
        <div className="serif" style={{ fontSize: 22, marginTop: 16 }}>{plant.nickname || speciesData.name}</div>
        <div className="mono" style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>reached {stageData?.name || "a new stage"}</div>
        <p style={{ fontSize: 13.5, color: "var(--ink2)", lineHeight: 1.5, marginTop: 12 }}>{speciesData.blurb}</p>
        {plant.maxed && (
          <div className="pill on" style={{ display: "inline-block", marginTop: 4 }}>Fully grown — now a collector's piece ✦</div>
        )}
        <button className="btn btn-accent" style={{ marginTop: 18 }} onClick={onClose}>Beautiful</button>
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
                <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: 1, marginTop: 3 }}>GTD · GREENHOUSE</div>
              </div>
            </div>
            <p style={{ fontSize: 14, color: "var(--ink2)", lineHeight: 1.5, marginTop: 0 }}>
              Everything unprocessed in your head goes into the inbox. Your trusted system is the greenhouse where you tend it — capture it all, clarify it, and keep your mind clear. First, what should we call you?
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
            <div className="serif" style={{ fontSize: 21, marginBottom: 4 }}>Your higher horizons, {name.trim().split(" ")[0]}</div>
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
              <button className="btn btn-accent" onClick={() => finish(false)}><Check size={15} /> Enter the greenhouse</button>
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
        {started && <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 16 }}>Growing since {started}</div>}

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
