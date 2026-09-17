/**
 * Ported from update_page_and_sheets.py's MANAGER_NICKNAMES / raw_manager_name
 * / build_manager_names — keep both in sync if the naming rule ever changes.
 *
 * Default: first name only, matching the Franchise page. When two managers
 * share a first name, the last initial (no period) is appended to
 * disambiguate — computed league-wide so collisions are actually detected,
 * not per-team. "nick" -> "Flanders" is a one-off override for this
 * manager's long-standing league nickname, which ESPN has no concept of.
 */
const MANAGER_NICKNAMES = {
  joseph: "Joe",
  jonathan: "Jon",
  bradley: "Brad",
  benjamin: "Ben",
  nick: "Flanders",
  tj: "TJ", // ESPN has this owner's first name on file as "Tj" (mixed case)
};

function rawManagerName(owners) {
  if (!owners || !owners.length) return { first: "", last: "" };
  const owner = owners[0];
  let first = (owner.firstName || "").trim();
  const last = (owner.lastName || "").trim();
  const override = MANAGER_NICKNAMES[first.toLowerCase()];
  if (override) first = override;
  if (first || last) return { first, last };
  return { first: owner.displayName || "", last: "" };
}

/** teams: [{ teamId, owners: [rawEspnMemberObject, ...] }]. Returns
 * Map<teamId, displayName>. */
export function buildManagerNames(teams) {
  const raw = new Map(teams.map((t) => [t.teamId, rawManagerName(t.owners)]));

  const firstNameCounts = new Map();
  for (const { first } of raw.values()) {
    if (first) firstNameCounts.set(first, (firstNameCounts.get(first) || 0) + 1);
  }

  const names = new Map();
  for (const [teamId, { first, last }] of raw.entries()) {
    if (!first) {
      names.set(teamId, last);
    } else if (firstNameCounts.get(first) > 1 && last) {
      names.set(teamId, `${first} ${last[0].toUpperCase()}`);
    } else {
      names.set(teamId, first);
    }
  }
  return names;
}
