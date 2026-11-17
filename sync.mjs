// PSN trophy sync
// Tracks EVERY game on one PSN account automatically and writes spoiler-safe
// snapshots to data/. Only EARNED trophies are written with names and
// descriptions; unearned trophies are reduced to counts.
//
// To stay well inside PSN's rate limits it only re-reads games whose trophy
// data changed since the last run, and at most MAX_TITLES_PER_RUN per run.
// The first runs fill in the backlog a batch at a time.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  getProfileFromUserName,
  getUserTitles,
  getUserTrophiesEarnedForTitle,
  getTitleTrophies
} from "psn-api";

const DATA_DIR = "data";
const GAMES_DIR = `${DATA_DIR}/games`;
const DEFAULT_MAX_TITLES_PER_RUN = 40;
const PAUSE_BETWEEN_GAMES_MS = 400;
const STOP_AFTER_CONSECUTIVE_FAILURES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const slugify = (text) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// One file per trophy list. The PSN id keeps regional versions apart.
const fileFor = (title) =>
  `${GAMES_DIR}/${slugify(title.trophyTitleName)}-${title.trophyTitlePlatform.toLowerCase()}-${title.npCommunicationId.toLowerCase()}.json`;

async function loadConfig() {
  const config = JSON.parse(await readFile("config.json", "utf8"));
  if (!config.psnUser) throw new Error("config.json is missing psnUser");
  return {
    language: "en-GB",
    maxTitlesPerRun: DEFAULT_MAX_TITLES_PER_RUN,
    ...config
  };
}

async function authenticate() {
  const npsso = process.env.PSN_NPSSO;
  if (!npsso) {
    throw new Error(
      "PSN_NPSSO is not set. Add it as a repository secret (Settings > Secrets and variables > Actions)."
    );
  }
  try {
    const accessCode = await exchangeNpssoForAccessCode(npsso);
    const tokens = await exchangeAccessCodeForAuthTokens(accessCode);
    if (!tokens.accessToken) throw new Error("no access token returned");
    return { accessToken: tokens.accessToken };
  } catch (err) {
    throw new Error(
      `PSN sign-in failed (${err.message.trim()}). The NPSSO token has probably expired: ` +
        "sign in to playstation.com with the burner account, open " +
        "https://ca.account.sony.com/api/v1/ssocookie and save the new value as the PSN_NPSSO secret."
    );
  }
}

async function getAccountId(auth, psnUser) {
  try {
    const { profile } = await getProfileFromUserName(auth, psnUser);
    return profile.accountId;
  } catch (err) {
    throw new Error(`Could not find PSN user "${psnUser}" (${err.message}). Check psnUser in config.json.`);
  }
}

async function getAllTitles(auth, accountId) {
  const titles = [];
  let offset = 0;
  for (;;) {
    const page = await getUserTitles(auth, accountId, { limit: 800, offset });
    if (!page?.trophyTitles) {
      throw new Error(
        `Could not read the trophy list (${JSON.stringify(page?.error ?? page)}). ` +
          "Check the main account's PSN privacy setting for trophies is set to Anyone."
      );
    }
    titles.push(...page.trophyTitles);
    if (page.nextOffset == null || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return titles;
}

// Existing snapshots, keyed by PSN id, so unchanged games are skipped.
async function loadSnapshots() {
  const snapshots = new Map();
  let files = [];
  try {
    files = await readdir(GAMES_DIR);
  } catch {
    return snapshots;
  }
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const snap = JSON.parse(await readFile(`${GAMES_DIR}/${file}`, "utf8"));
      if (snap.npCommunicationId) snapshots.set(snap.npCommunicationId, snap);
    } catch {
      // A broken file is simply re-synced.
    }
  }
  return snapshots;
}

// Files from the first version of this script lived directly in data/.
async function removeLegacyFiles() {
  let files = [];
  try {
    files = await readdir(DATA_DIR);
  } catch {
    return;
  }
  for (const file of files) {
    if (file.endsWith(".json") && file !== "titles.json") {
      await rm(`${DATA_DIR}/${file}`);
      console.log(`Removed old-format file data/${file}`);
    }
  }
}

async function snapshotTitle(auth, accountId, title, language) {
  const options = { npServiceName: title.npServiceName };

  const [earnedRes, definedRes] = await Promise.all([
    getUserTrophiesEarnedForTitle(auth, accountId, title.npCommunicationId, "all", options),
    getTitleTrophies(auth, title.npCommunicationId, "all", {
      ...options,
      headerOverrides: { "Accept-Language": language }
    })
  ]);

  if (!earnedRes?.trophies || !definedRes?.trophies) {
    throw new Error(`unexpected response ${JSON.stringify(earnedRes?.error ?? definedRes?.error ?? "")}`);
  }

  const definitions = new Map(definedRes.trophies.map((t) => [t.trophyId, t]));

  const earned = earnedRes.trophies
    .filter((t) => t.earned)
    .map((t) => {
      const def = definitions.get(t.trophyId) ?? {};
      return {
        id: t.trophyId,
        name: def.trophyName ?? null,
        detail: def.trophyDetail ?? null,
        type: t.trophyType,
        earnedDateTime: t.earnedDateTime ?? null,
        rarityPercent: t.trophyEarnedRate != null ? Number(t.trophyEarnedRate) : null
      };
    })
    .sort((a, b) => String(a.earnedDateTime).localeCompare(String(b.earnedDateTime)));

  // Unearned trophies: counts only. No ids, names or descriptions.
  const unearnedByType = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  for (const t of earnedRes.trophies) {
    if (!t.earned && t.trophyType in unearnedByType) unearnedByType[t.trophyType] += 1;
  }

  return {
    game: title.trophyTitleName,
    platform: title.trophyTitlePlatform,
    npCommunicationId: title.npCommunicationId,
    progressPercent: title.progress,
    earnedCounts: title.earnedTrophies,
    definedCounts: title.definedTrophies,
    psnLastUpdated: title.lastUpdatedDateTime,
    earnedTotal: earned.length,
    unearnedTotal: earnedRes.trophies.length - earned.length,
    unearnedByType,
    earned
  };
}

function summaryMarkdown(user, titles, snapshots, pendingCount) {
  const lines = [`# Trophy sync: ${user}`, ""];

  if (pendingCount > 0) {
    lines.push(
      `Still filling in: ${pendingCount} of ${titles.length} games not synced yet. They'll be added over the next few hourly runs.`,
      ""
    );
  }

  const recent = [];
  for (const snap of snapshots.values()) {
    for (const t of snap.earned) recent.push({ ...t, game: snap.game, platform: snap.platform });
  }
  recent.sort((a, b) => String(b.earnedDateTime).localeCompare(String(a.earnedDateTime)));

  lines.push("## Recently earned", "", "| Earned (UTC) | Trophy | Type | Game |", "|---|---|---|---|");
  for (const t of recent.slice(0, 25)) {
    lines.push(`| ${t.earnedDateTime ?? ""} | ${t.name ?? `#${t.id}`} | ${t.type} | ${t.game} (${t.platform}) |`);
  }
  lines.push("");

  lines.push("## All games", "", "| Game | Platform | Progress | Earned | Platinum |", "|---|---|---|---|---|");
  const sorted = [...titles].sort((a, b) =>
    String(b.lastUpdatedDateTime).localeCompare(String(a.lastUpdatedDateTime))
  );
  for (const t of sorted) {
    const snap = snapshots.get(t.npCommunicationId);
    const earned = snap ? `${snap.earnedTotal} / ${snap.earnedTotal + snap.unearnedTotal}` : "not synced yet";
    const hasPlatinum = (t.definedTrophies?.platinum ?? 0) > 0;
    const platinum = !hasPlatinum ? "n/a" : (t.earnedTrophies?.platinum ?? 0) > 0 ? "Yes" : "No";
    lines.push(`| ${t.trophyTitleName} | ${t.trophyTitlePlatform} | ${t.progress}% | ${earned} | ${platinum} |`);
  }
  return lines.join("\n");
}

async function main() {
  const config = await loadConfig();
  const auth = await authenticate();
  const accountId = await getAccountId(auth, config.psnUser);
  const titles = await getAllTitles(auth, accountId);

  await mkdir(GAMES_DIR, { recursive: true });
  await removeLegacyFiles();

  // Every title with its exact PSN name, most recent first.
  const allTitles = [...titles]
    .sort((a, b) => String(b.lastUpdatedDateTime).localeCompare(String(a.lastUpdatedDateTime)))
    .map((t) => ({ name: t.trophyTitleName, platform: t.trophyTitlePlatform, progressPercent: t.progress }));
  await writeFile(`${DATA_DIR}/titles.json`, JSON.stringify(allTitles, null, 2) + "\n");

  const snapshots = await loadSnapshots();

  // New or changed games, most recently played first.
  const stale = titles
    .filter((t) => snapshots.get(t.npCommunicationId)?.psnLastUpdated !== t.lastUpdatedDateTime)
    .sort((a, b) => String(b.lastUpdatedDateTime).localeCompare(String(a.lastUpdatedDateTime)));
  const batch = stale.slice(0, config.maxTitlesPerRun);
  console.log(`${titles.length} games on the account, ${stale.length} new or changed, syncing ${batch.length} this run.`);

  let synced = 0;
  let consecutiveFailures = 0;
  for (const title of batch) {
    try {
      const snap = await snapshotTitle(auth, accountId, title, config.language);
      await writeFile(fileFor(title), JSON.stringify(snap, null, 2) + "\n");
      snapshots.set(title.npCommunicationId, snap);
      synced += 1;
      consecutiveFailures = 0;
      console.log(`Synced ${snap.game} (${snap.platform}): ${snap.earnedTotal} earned, ${snap.unearnedTotal} remaining`);
    } catch (err) {
      consecutiveFailures += 1;
      console.log(`Skipped ${title.trophyTitleName} (${title.trophyTitlePlatform}) for now: ${err.message}`);
      if (consecutiveFailures >= STOP_AFTER_CONSECUTIVE_FAILURES) {
        console.log("Several failures in a row, probably a PSN rate limit. Stopping; the next run carries on.");
        break;
      }
    }
    await sleep(PAUSE_BETWEEN_GAMES_MS);
  }

  const pendingCount = titles.filter((t) => !snapshots.has(t.npCommunicationId)).length;
  await writeFile(`${DATA_DIR}/summary.md`, summaryMarkdown(config.psnUser, titles, snapshots, pendingCount) + "\n");
  console.log(`Done: ${synced} synced this run, ${pendingCount} still to fill in.`);

  if (batch.length > 0 && synced === 0) {
    throw new Error("No games could be synced this run. See the messages above.");
  }
}

main().catch((err) => {
  console.error(`Sync failed: ${err.message}`);
  process.exit(1);
});
