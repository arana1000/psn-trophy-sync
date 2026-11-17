// PSN trophy sync
// Reads one PSN user's trophies for the games listed in config.json and writes
// spoiler-safe snapshots to data/. Only EARNED trophies are written with names
// and descriptions; unearned trophies are reduced to counts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  getProfileFromUserName,
  getUserTitles,
  getUserTrophiesEarnedForTitle,
  getTitleTrophies
} from "psn-api";

const DATA_DIR = "data";

// "Grand Theft Auto VI™" -> "grandtheftautovi"
// Exact match on this form, so "Grand Theft Auto V" never matches "VI".
const normalise = (name) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const slugify = (name, platform) =>
  `${name}-${platform}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function loadConfig() {
  const config = JSON.parse(await readFile("config.json", "utf8"));
  if (!config.psnUser) throw new Error("config.json is missing psnUser");
  if (!Array.isArray(config.games) || config.games.length === 0) {
    throw new Error("config.json needs at least one entry in games");
  }
  return { language: "en-GB", ...config };
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
    throw new Error(`Could not read trophies for ${title.trophyTitleName}`);
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

function summaryMarkdown(user, snapshots, missing) {
  const lines = [`# Trophy sync: ${user}`, ""];
  for (const s of snapshots) {
    lines.push(`## ${s.game} (${s.platform})`, "");
    lines.push(
      `${s.earnedTotal} earned, ${s.unearnedTotal} remaining, ${s.progressPercent}% progress. ` +
        `PSN last updated ${s.psnLastUpdated}.`,
      ""
    );
    if (s.earned.length > 0) {
      lines.push("| Earned (UTC) | Trophy | Type |", "|---|---|---|");
      for (const t of [...s.earned].reverse()) {
        lines.push(`| ${t.earnedDateTime ?? ""} | ${t.name ?? `#${t.id}`} | ${t.type} |`);
      }
      lines.push("");
    }
  }
  if (missing.length > 0) {
    lines.push(
      "## Not found yet",
      "",
      ...missing.map((g) => `- ${g} (no trophies earned yet, or the name in config.json doesn't match; see titles.json)`),
      ""
    );
  }
  return lines.join("\n");
}

async function main() {
  const config = await loadConfig();
  const auth = await authenticate();

  let accountId;
  try {
    const { profile } = await getProfileFromUserName(auth, config.psnUser);
    accountId = profile.accountId;
  } catch (err) {
    throw new Error(`Could not find PSN user "${config.psnUser}" (${err.message}). Check psnUser in config.json.`);
  }

  const titles = await getAllTitles(auth, accountId);
  await mkdir(DATA_DIR, { recursive: true });

  // Recent titles with their exact PSN names, to copy into config.json.
  const recent = titles
    .slice()
    .sort((a, b) => String(b.lastUpdatedDateTime).localeCompare(String(a.lastUpdatedDateTime)))
    .slice(0, 30)
    .map((t) => ({ name: t.trophyTitleName, platform: t.trophyTitlePlatform }));
  await writeFile(`${DATA_DIR}/titles.json`, JSON.stringify(recent, null, 2) + "\n");

  const wanted = new Map(config.games.map((g) => [normalise(g), g]));
  const matches = titles.filter((t) => wanted.has(normalise(t.trophyTitleName)));
  const foundKeys = new Set(matches.map((t) => normalise(t.trophyTitleName)));
  const missing = [...wanted].filter(([key]) => !foundKeys.has(key)).map(([, name]) => name);

  const snapshots = [];
  for (const title of matches) {
    const snap = await snapshotTitle(auth, accountId, title, config.language);
    snapshots.push(snap);
    const file = `${DATA_DIR}/${slugify(title.trophyTitleName, title.trophyTitlePlatform)}.json`;
    await writeFile(file, JSON.stringify(snap, null, 2) + "\n");
    console.log(`${snap.game} (${snap.platform}): ${snap.earnedTotal} earned, ${snap.unearnedTotal} remaining`);
  }

  await writeFile(`${DATA_DIR}/summary.md`, summaryMarkdown(config.psnUser, snapshots, missing) + "\n");
  for (const g of missing) console.log(`Not found: ${g}`);
}

main().catch((err) => {
  console.error(`Sync failed: ${err.message}`);
  process.exit(1);
});
