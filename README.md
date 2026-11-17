# PSN trophy sync

Every hour, GitHub Actions reads the trophies of one PSN account for the games in `config.json` and saves spoiler-safe snapshots in `data/`:

- `data/<game>-<platform>.json`: earned trophies (name, description, type, time earned, rarity) plus counts of what's left. Unearned trophies are reduced to counts: no names, no descriptions.
- `data/summary.md`: the same in a readable table, handy on a phone.
- `data/titles.json`: the 30 most recent games with their exact PSN names, to copy into `config.json`.

It uses the unofficial PSN API via [psn-api](https://github.com/achievements-app/psn-api). Sony doesn't support it, and it can break if Sony changes things.

## Setup

1. **Burner PSN account.** Create a separate PSN account and sign in to playstation.com with it once. Never use your main account's token.
2. **Main account trophies visible to Anyone** (PSN privacy settings). If your PSNProfiles page shows your trophies, this is already done.
3. **Get the burner's NPSSO token.** In a private/incognito browser window, sign in to playstation.com as the burner, then open `https://ca.account.sony.com/api/v1/ssocookie` and copy the 64-character `npsso` value. Treat it like a password.
4. **Add it as a secret.** Repo > Settings > Secrets and variables > Actions > New repository secret. Name: `PSN_NPSSO`, value: the token.
5. **First run.** Actions tab > enable workflows if asked > "Sync PSN trophies" > Run workflow. After about a minute, `data/summary.md` should appear.

## Adding a game

Edit `config.json` and add the game's exact PSN name to `games` (copy it from `data/titles.json`). The match is exact, so "Grand Theft Auto V" never matches "Grand Theft Auto VI".

## When it fails

The run goes red, and GitHub emails you. The log says why. The usual cause is an expired NPSSO token (roughly every two months): repeat step 3 and update the secret.

GitHub pauses scheduled workflows in a repo with no activity for 60 days. If that happens, re-enable it in the Actions tab.
