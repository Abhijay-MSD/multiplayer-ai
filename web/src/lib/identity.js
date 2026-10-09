// Participant identity colors, assigned in join order — PRD §20.3.
const PALETTE = [
  "var(--identity-1)",
  "var(--identity-2)",
  "var(--identity-3)",
  "var(--identity-4)",
  "var(--identity-5)"
];

// Join order is derived from real `join` events (every participant gets one,
// including the session creator — see server/tools/create_session.js), not
// invented client-side state.
export function buildIdentityMap(events, participants) {
  const order = [];
  const seen = new Set();

  for (const event of events) {
    if (event.kind === "join" && !seen.has(event.author)) {
      seen.add(event.author);
      order.push(event.author);
    }
  }
  for (const p of participants) {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      order.push(p.name);
    }
  }

  const map = {};
  order.forEach((name, i) => {
    map[name] = PALETTE[i % PALETTE.length];
  });
  return map;
}
