import { useEffect, useMemo, useState } from "react";
import styles from "./SessionRoom.module.css";
import { LiveSignal } from "./LiveSignal";
import { Transcript } from "./Transcript";
import { OutputsPanel } from "./OutputsPanel";
import { FilesPanel } from "./FilesPanel";
import { RoomBrief } from "./RoomBrief";
import { TranscriptTools } from "./TranscriptTools";
import toolStyles from "./TranscriptTools.module.css";
import outputStyles from "./Outputs.module.css";
import { extractOutputs } from "../lib/outputs";
import { PresenceRail } from "./PresenceRail";
import { RoomDetails } from "./RoomDetails";
import { Composer } from "./Composer";
import { ThemeSwitcher } from "../themes/ThemeSwitcher";
import { useTheme } from "../themes/ThemeProvider";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { buildIdentityMap } from "../lib/identity";
import { isAway, useNow } from "../lib/time";
import { CONTINUE_TEXT, continuableLine } from "../lib/continue";

const RAIL_KEY = "multiplayer-ai:rail";
const readRailPref = () => {
  try {
    return localStorage.getItem(RAIL_KEY) !== "closed";
  } catch {
    return true;
  }
};

// The room as a function of its data: no network, no Realtime. SessionRoom
// feeds it live data; the QA fixture route and the marketing replay feed it
// recorded data. `readOnly` drops the composer and handoff controls;
// `embedded` sizes the room to its container instead of the window.
export function SessionRoomView({
  sessionId,
  name,
  session,
  events,
  participants,
  signalState,
  working,
  busy = false,
  handoffError = null,
  onSendDirective,
  onSendComment,
  onTakeControl,
  readOnly = false,
  notice = null,
  embedded = false,
  control = {}, // { shared, policy, iAmHost, waiting }: how taking control works in this room, for this person
  shareLink, // the link the Copy link button copies; undefined = this page's address, null = no button (a guest in a shared room has no secret to pass on)
  hostControls = null, // { onOpen, pending }: the host's panel button, only for the host
  onRetry = null, // sends the controller's last message again; given only to a controller
  onStop = null, // ends the step that is running; given only to the controller and the host
  initialView = "conversation", // which tab is open first (the QA pages open the Files tab)
  filesView = null // the room's files: null when this copy has none (Supabase storage), else what FilesPanel and the composer need
}) {
  const { meta } = useTheme();
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [desktopRailOpen, setDesktopRailOpen] = useState(readRailPref);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy link");
  const [view, setView] = useState(initialView); // "conversation" | "outputs" | "files"

  const collapsible = Boolean(meta.railCollapsible);
  // On a phone the rail is a drawer for every theme. On a desktop it is always
  // there unless the theme lets it collapse.
  const railOpen = isMobile ? drawerOpen : collapsible ? desktopRailOpen : true;

  const toggleRail = () => {
    if (isMobile) return setDrawerOpen((o) => !o);
    setDesktopRailOpen((o) => {
      try {
        localStorage.setItem(RAIL_KEY, o ? "closed" : "open");
      } catch {
        /* the choice lasts for this page only */
      }
      return !o;
    });
  };

  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!(isMobile && drawerOpen)) return;
    const onKey = (e) => e.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobile, drawerOpen]);

  // Search: only the messages that hold the words (in the text or the author's name), the same entries as before, nothing marked up.
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? events.filter((e) => String(e.content ?? "").toLowerCase().includes(needle) || String(e.author ?? "").toLowerCase().includes(needle)) : events),
    [events, needle]
  );

  const outputs = useMemo(() => extractOutputs(events), [events]);
  const hasOutputs = outputs.total > 0;
  const tabs = [
    { id: "conversation", label: "Conversation" },
    ...(hasOutputs ? [{ id: "outputs", label: `Outputs (${outputs.total})` }] : []),
    ...(filesView ? [{ id: "files", label: "Files" }] : [])
  ];
  const hasTabs = tabs.length > 1;
  const activeView = tabs.some((t) => t.id === view) ? view : "conversation";
  const onTabKey = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === activeView);
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].id;
    setView(next);
    document.getElementById(`room-tab-${next}`)?.focus();
  };

  const identityMap = useMemo(() => buildIdentityMap(events, participants), [events, participants]);
  const roleByName = useMemo(
    () => Object.fromEntries(participants.map((p) => [p.name, p.role])),
    [participants]
  );
  const controller = participants.find((p) => p.role === "controller");
  const now = useNow();
  const controllerHere = Boolean(controller) && !isAway(controller.last_seen, now);
  // The line "The reply reached its length limit" gets a Continue button, for the controller only, while it is the latest thing
  // said to the agent and the agent is idle. What it sends is a message like any other, so the server's rules for a message apply.
  const continueFor = !readOnly && !working && controller?.name === name ? continuableLine(events) : null;

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(shareLink ?? `${window.location.origin}/s/${sessionId}`);
    setCopyLabel("Copied");
    setTimeout(() => setCopyLabel("Copy link"), 1600);
  };

  return (
    <div
      className={styles.room}
      data-part="room"
      data-rail={railOpen ? "open" : "closed"}
      data-collapsible={collapsible ? "true" : "false"}
      data-readonly={readOnly ? "true" : "false"}
      data-embedded={embedded ? "true" : "false"}
    >
      <header className={styles.top} data-part="header">
        <div className={styles.signalSlot} data-part="signal-slot">
          <LiveSignal state={signalState} announce={!readOnly} />
        </div>
        <div className={styles.headRow} data-part="head-row">
          <button
            type="button"
            className={styles.railToggle}
            data-part="rail-toggle"
            aria-expanded={railOpen}
            aria-controls="room-rail"
            onClick={toggleRail}
          >
            People
          </button>
          <div className={styles.titleBlock} data-part="title-block">
            <div className={styles.title} data-part="title">{session?.title}</div>
            <div className={styles.task} data-part="task">{session?.task}</div>
          </div>
          <div className={styles.actions} data-part="header-actions">
            {!readOnly && <ThemeSwitcher />}
            {hostControls && (
              <a className={styles.hostButton} data-part="rooms-link" href="/rooms">
                Your rooms
              </a>
            )}
            {!readOnly && hostControls && (
              <button className={styles.hostButton} data-part="host-controls-button" onClick={hostControls.onOpen}>
                Host controls{hostControls.pending ? ` (${hostControls.pending})` : ""}
              </button>
            )}
            {!readOnly && shareLink !== null && (
              <button
                className={`${styles.copyLink} ${copyLabel === "Copied" ? styles.copyLinkCopied : ""}`}
                onClick={handleCopyLink}
              >
                {copyLabel}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className={styles.transcriptArea} data-part="stage">
        <div className={outputStyles.stageColumn}>
          <RoomBrief brief={session?.brief} />
          {hasTabs && (
            <div className={outputStyles.tabs} role="tablist" aria-label="Room views" data-part="tabs" onKeyDown={onTabKey}>
              {tabs.map(({ id, label }) => (
                <button
                  key={id}
                  id={`room-tab-${id}`}
                  type="button"
                  role="tab"
                  className={outputStyles.tab}
                  aria-selected={activeView === id}
                  aria-controls={`room-panel-${id}`}
                  tabIndex={activeView === id ? 0 : -1}
                  onClick={() => setView(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div id="room-panel-conversation" className={outputStyles.tabPanel} role={hasTabs ? "tabpanel" : undefined} aria-labelledby={hasTabs ? "room-tab-conversation" : undefined} hidden={activeView !== "conversation"}>
            <div className={toolStyles.conversation}>
              {!embedded && <TranscriptTools session={session} events={events} query={query} onQuery={setQuery} matches={shown.length} />}
              <div className={toolStyles.slot}>
                <Transcript events={shown} lookup={events} identityMap={identityMap} roleByName={roleByName} working={working && !needle} searching={Boolean(needle)} continueFor={continueFor} onContinue={continueFor ? () => onSendDirective(CONTINUE_TEXT) : null} />
              </div>
            </div>
          </div>
          {hasOutputs && (
            <div id="room-panel-outputs" className={outputStyles.tabPanel} role="tabpanel" aria-labelledby="room-tab-outputs" hidden={activeView !== "outputs"}>
              {activeView === "outputs" && <OutputsPanel outputs={outputs} />}
            </div>
          )}
          {filesView && (
            <div id="room-panel-files" className={outputStyles.tabPanel} role="tabpanel" aria-labelledby="room-tab-files" hidden={activeView !== "files"}>
              {activeView === "files" && <FilesPanel view={filesView} changeKey={events.at(-1)?.id ?? 0} agentCanUse={Boolean(session?.files_enabled)} />}
            </div>
          )}
        </div>
      </div>

      {isMobile && drawerOpen && (
        <button type="button" className={styles.scrim} data-part="scrim" aria-label="Close people list" onClick={() => setDrawerOpen(false)} />
      )}
      <aside id="room-rail" className={styles.rail} data-part="rail" aria-label="People and room details">
        <RoomDetails session={session} />
        <PresenceRail
          participants={participants}
          identityMap={identityMap}
          myName={name}
          onTakeControl={onTakeControl}
          busy={busy}
          error={handoffError}
          readOnly={readOnly}
          control={control}
        />
      </aside>

      {readOnly && notice && (
        <div className={styles.bottom} data-part="composer-area">
          <p className={styles.notice} role="status" data-part="room-notice">
            {notice}
          </p>
        </div>
      )}

      {!readOnly && (
        <div className={styles.bottom} data-part="composer-area">
          <Composer
            isController={controller?.name === name}
            controllerName={controller?.name}
            controllerHere={controllerHere}
            onSendDirective={onSendDirective}
            onSendComment={onSendComment}
            onTakeControl={() => onTakeControl(name)}
            busy={busy}
            control={control}
            attach={filesView?.canAttach ? filesView : null}
            onStop={onStop && working ? onStop : null}
            onRetry={onRetry}
            working={working}
          />
        </div>
      )}
    </div>
  );
}
