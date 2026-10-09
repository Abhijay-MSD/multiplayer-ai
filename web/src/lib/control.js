// What the "take control" button says and whether it can be pressed, for the person looking at it.
//
// Not shared (or the person is the host): the old rules. You can take the seat only when nobody holds it or the
// holder is Away; the button is off, with the reason, while the controller is here.
// Shared, and the person is a guest, by the room's policy:
//   locked  only the host changes control: the button is off, and says so.
//   ask     the button asks the host (it can be pressed even while the controller is here); once asked it waits.
//   free    the old rules apply.
export function controlView({ control = {}, controllerName = null, controllerHere = false }) {
  const guest = Boolean(control.shared && !control.iAmHost);
  const policy = control.policy ?? "ask";
  const locked = guest && policy === "locked";
  const asking = guest && policy === "ask";
  const waiting = Boolean(control.waiting);
  const held = !asking && controllerHere;
  let reason = null;
  if (locked) reason = "The host has locked control";
  else if (waiting) reason = "Waiting for the host to answer";
  else if (held) reason = `${controllerName} is here and steering`;
  return {
    asking,
    locked,
    blocked: locked || waiting || held,
    reason,
    label: asking ? (waiting ? "Waiting for the host…" : "Ask the host for control") : "Take control",
    handoffLabel: guest && policy !== "free" ? "Ask the host to hand off →" : "Hand off →"
  };
}
