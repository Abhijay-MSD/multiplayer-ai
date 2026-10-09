import { useEffect, useRef, useState } from "react";
import styles from "./StartRoom.module.css";
import { LiveSignal } from "./LiveSignal";
import { createSession } from "../api";
import { getStatus } from "../lib/adminApi";
import { describeFailure, isFormProblem } from "../lib/failures";
import { getRememberedName, rememberName, saveToken } from "../lib/credentials";

// Six ideas to start from. Choosing one only fills the task box: nothing is sent until the person starts the room, and they
// can change the words first.
export const STARTERS = [
  "Plan a three-day trip to Lisbon, with one indoor option for each day in case it rains.",
  "Write a checklist for launching a small web app, from the first commit to the first user.",
  "Draft a rollback plan for a database change, with what to check before and after.",
  "Explain the difference between a queue and a stack, with one short example of each.",
  "Outline a short talk for a team meeting on why our tests are slow, with three things to measure first.",
  "Write a polite message asking a colleague to review my pull request by Friday."
];

// /new: give the agent a task and a name. The server makes you the room's
// controller and starts the first reply; you land in the room with a panel
// for sharing its link. The remembered name only prefills the field.
export default function StartRoom() {
  const [task, setTask] = useState("");
  const [name, setName] = useState(getRememberedName);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null); // { field: "task" | "name", message }: something to fix in the form
  const [failure, setFailure] = useState(null); // the request itself failed: from describeFailure()
  const [noKey, setNoKey] = useState(false); // this copy has no model key yet: setting one up comes first
  const [asked, setAsked] = useState(false);
  const taskRef = useRef(null);
  const [guest, setGuest] = useState(false); // the app is shared and this is not the host: only the host starts rooms

  // Ask before showing a form that can't work, so it doesn't appear and then change. Anything
  // but a clear "no key" (including no answer within 2 seconds) shows the form.
  useEffect(() => {
    getStatus().then((s) => {
      if (s?.sharing && !s.host) setGuest(true);
      else if (s?.configured === false) setNoKey(true);
      setAsked(true);
    });
  }, []);

  const ready = task.trim() !== "" && name.trim() !== "" && !busy;

  const submit = async (e) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    setFailure(null);
    try {
      const res = await createSession({ task: task.trim(), creator_name: name.trim(), auto_start: true });
      saveToken(res.session_id, res.token);
      rememberName(res.you.name);
      window.location.assign(`/s/${res.session_id}?new=1`);
    } catch (err) {
      if (isFormProblem(err)) {
        setProblem({ field: err.code === "INVALID_NAME" ? "name" : "task", message: err.message });
      } else if (err?.code === "NO_KEY") {
        setNoKey(true);
      } else if (err?.code === "HOST_ONLY") {
        setGuest(true);
      } else {
        setFailure(describeFailure(err));
      }
      setBusy(false);
    }
  };

  if (!asked) return null;

  if (guest) {
    const f = describeFailure({ code: "HOST_ONLY" });
    return (
      <div className={styles.wrap} data-part="start-room">
        <div className={styles.card}>
          <div className={styles.signal}>
            <LiveSignal state="idle" showLabel={false} />
          </div>
          <h1 className={styles.title}>{f.title}</h1>
          <p className={styles.subtitle}>{f.body}</p>
          <p className={styles.footnote}>
            <a href="/">About Multiplayer AI</a>
          </p>
        </div>
      </div>
    );
  }

  if (noKey) {
    const f = describeFailure({ code: "NO_KEY" });
    return (
      <div className={styles.wrap} data-part="start-room">
        <div className={styles.card}>
          <div className={styles.signal}>
            <LiveSignal state="idle" showLabel={false} />
          </div>
          <h1 className={styles.title}>{f.title}</h1>
          <p className={styles.subtitle}>{f.body}</p>
          <a className={styles.button} href="/setup?next=/new" style={{ alignSelf: "flex-start", textDecoration: "none" }}>
            Set up a key
          </a>
          <p className={styles.footnote}>
            <a href="/">About Multiplayer AI</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap} data-part="start-room">
      <form className={styles.card} onSubmit={submit} noValidate>
        <div className={styles.signal}>
          <LiveSignal state={busy ? "working" : "idle"} showLabel={false} />
        </div>
        <h1 className={styles.title}>Start a room</h1>
        <p className={styles.subtitle}>
          Give the agent a task. You become the controller, and you get a link to share with the people you want in the room.
        </p>

        <label className={styles.label} htmlFor="start-task">
          What should the agent work on?
        </label>
        <textarea
          ref={taskRef}
          id="start-task"
          className={styles.field}
          rows={4}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          maxLength={4000}
          autoFocus
          aria-invalid={problem?.field === "task" ? true : undefined}
          aria-describedby={problem?.field === "task" ? "start-problem" : undefined}
        />

        <div className={styles.starters} role="group" aria-labelledby="starters-label" data-part="starters">
          <span id="starters-label" className={styles.startersLabel}>Or start from an idea</span>
          {STARTERS.map((text) => (
            <button
              key={text}
              type="button"
              className={styles.starter}
              onClick={() => {
                setTask(text);
                setProblem(null);
                taskRef.current?.focus();
              }}
            >
              {text}
            </button>
          ))}
        </div>

        <label className={styles.label} htmlFor="start-name">
          Your name
        </label>
        <input
          id="start-name"
          className={styles.field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          autoComplete="nickname"
          aria-invalid={problem?.field === "name" ? true : undefined}
          aria-describedby={problem?.field === "name" ? "start-problem" : undefined}
        />

        {problem && (
          <p id="start-problem" className={styles.error} role="alert">
            {problem.message}
          </p>
        )}

        {failure && (
          <div className={styles.failure} role="alert">
            <div className={styles.failureTitle}>{failure.title}</div>
            <p className={styles.failureBody}>{failure.body}</p>
          </div>
        )}

        <button className={styles.button} type="submit" disabled={!ready}>
          {busy ? "Starting…" : failure ? "Try again" : "Start room"}
        </button>
        <p className={styles.footnote}>
          Anyone with the link can join. Rooms with no activity for a while become read-only.{" "}
          <a href="/settings">Settings</a> · <a href="/">About Multiplayer AI</a>
        </p>
      </form>
    </div>
  );
}
