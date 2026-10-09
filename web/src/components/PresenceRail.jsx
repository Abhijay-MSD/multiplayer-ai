import styles from "./PresenceRail.module.css";
import { useNow, isAway, isStale } from "../lib/time";
import { controlView } from "../lib/control";

// Must match .row's height + .list's gap in PresenceRail.module.css —
// the traveling ring's position is computed, not measured.
const ROW_STEP = 56 + 16;

// PRD 21 right rail: presence (who is here, who is driving) + handoff.
// PRD 20.8 + 20.6: color-coded avatars, controller wears a subtle pine
// ring, and a handoff animates that ring moving to the new person rather
// than just updating instantly. The list order is stable (join order) so
// there's an actual position for the ring to travel between.
export function PresenceRail({ participants, identityMap, myName, onTakeControl, busy, error, readOnly = false, control = {} }) {
  const now = useNow();
  const joinOrder = Object.keys(identityMap);
  // Hide (never delete) people unseen for 10+ minutes. The controller and the
  // viewer themself always stay, so handoff and "Take control" keep working.
  const visible = participants.filter(
    (p) => p.role === "controller" || p.name === myName || !isStale(p.last_seen, now)
  );
  const sorted = [...visible].sort(
    (a, b) => joinOrder.indexOf(a.name) - joinOrder.indexOf(b.name)
  );

  const controller = participants.find((p) => p.role === "controller");
  const iAmController = controller?.name === myName;
  // The server lets you take the seat only when nobody holds it or the holder
  // is Away (server/tools/take_control.js), so the button says so up front.
  const controllerHere = Boolean(controller) && !isAway(controller.last_seen, now);
  const controllerIndex = sorted.findIndex((p) => p.role === "controller");
  const view = controlView({ control, controllerName: controller?.name, controllerHere });

  return (
    <div className={styles.rail} data-part="presence">
      <div>
        <div className={styles.heading}>In the room</div>
        <div className={styles.list}>
          <div
            className={`${styles.travelingRing} ${controllerIndex >= 0 ? styles.travelingRingVisible : ""}`}
            style={{ transform: `translateY(${Math.max(controllerIndex, 0) * ROW_STEP}px)` }}
          />
          {sorted.map((p) => {
            const away = isAway(p.last_seen, now);
            return (
              <div key={p.name} className={`${styles.row} ${away ? styles.away : ""}`}>
                <div className={styles.avatarWrap}>
                  <div className={styles.avatar} style={{ background: identityMap[p.name] ?? "var(--text-muted)" }}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                </div>
                <div className={styles.identity}>
                  <span className={styles.name}>
                    {p.name}
                    {p.name === myName ? " (you)" : ""}
                  </span>
                  <span className={`${styles.status} ${p.role === "controller" ? styles.statusDriving : ""}`}>
                    {p.role === "controller" ? (away ? "Driving · Away" : "Driving") : away ? "Away" : "Here"}
                  </span>
                </div>
                {!readOnly && iAmController && p.name !== myName && (
                  <span
                    className={styles.handoffWrap}
                    title={away ? `${p.name} is away. Hand off to someone who is here.` : undefined}
                  >
                    <button
                      className={styles.handoffButton}
                      disabled={busy || away || view.locked || control.waiting}
                      onClick={() => onTakeControl(p.name)}
                    >
                      {p.is_host ? "Hand off →" : view.handoffLabel}
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      {!readOnly && !iAmController && (
        <>
          <button
            className={styles.takeControl}
            disabled={busy || view.blocked}
            aria-describedby={view.reason ? "take-control-reason" : undefined}
            onClick={() => onTakeControl(myName)}
          >
            {view.label}
          </button>
          {view.reason && (
            <div id="take-control-reason" className={styles.takeReason} data-part="take-control-reason">
              {view.reason}
            </div>
          )}
        </>
      )}
    </div>
  );
}
