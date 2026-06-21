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
  19: {
    notes: [
      "Updated the pothos avatar art.",
      "Please be patient as it is still a work in progress!"
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
