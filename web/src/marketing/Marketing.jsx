import { useEffect, useState } from "react";
import styles from "./Marketing.module.css";
import { getStatus } from "../lib/adminApi";
import { ReplayRoom } from "./ReplayRoom";
import { ThemeShowcase } from "./ThemeShowcase";
import { ModeToggle } from "./ModeToggle";
import { GITHUB_URL } from "./links";

// Sizes of the cropped screenshots in /marketing (see qa/marketing-shots.spec.js).
const STEPS = [
  {
    title: "Start a room",
    body: [
      "Choose Start a room, give the agent a task and type your name. That creates the room and makes you its controller, and the agent starts on the task straight away.",
      "You get a link to share. An MCP client can start a room too, with create_session."
    ],
    image: { src: "/marketing/step-start.png", width: 1140, height: 520, alt: "A new room: the task as the first message, and the live signal above it." }
  },
  {
    title: "Share the link",
    body: [
      "Anyone who opens the link types a name and lands in the same room, with the whole transcript so far. There are no accounts, and a name that is already in the room can't be used twice.",
      "The side panel shows who is here and who is away."
    ],
    image: { src: "/marketing/step-share.png", width: 440, height: 440, alt: "The header with the copy link button, and the list of people in the room." }
  },
  {
    title: "Steer together",
    body: [
      "Only the controller can message the agent. Everyone else comments, and the agent never sees comments.",
      "The controller can hand control to someone who is here. Anyone can take it when nobody holds it or the controller is away. Each reply says which message it answers."
    ],
    image: { src: "/marketing/step-steer.png", width: 1140, height: 640, alt: "An agent reply that says which message it answers, and the composer with its two modes." }
  }
];

const WORKS = [
  "Start a room from the web app, and share its link.",
  "Join with just a name. A name already in the room is refused.",
  "A shared transcript that updates live for everyone in the room.",
  "One controller at a time. Only the controller messages the agent.",
  "Comments from anyone. The agent never reads them.",
  "Hand-off and take control. A hand-off goes to someone who is here. You can take control yourself only when nobody holds it or the controller is away.",
  "Presence: who is here, who is away, who is driving.",
  "Messages sent while the agent is working are queued per room and answered one at a time.",
  "Each reply shows which message it answers.",
  "A step limit per room, with a visible signal when it is reached.",
  "A room with no activity for a set number of days (7 by default) becomes read-only.",
  "An MCP server, so MCP clients can create and join rooms.",
  "Sharing on the same Wi-Fi: a link and a QR code, with the host choosing who may take control and how many messages guests may send.",
  "Your rooms and your key stay in a file on your computer. There is no database or account to set up.",
  "The agent can list, read and write text files kept in the room, when the host allows it. Everyone in the room can open and download them; the controller or the host can attach text files.",
  "Four themes, each with light and dark."
];

const MISSING = [
  "Accounts and sign-in. Anyone with a room's link can join, under any name that isn't taken.",
  "Private rooms. A room is open to everyone who has its link.",
  "A list of your rooms.",
  "A hosted version. You run it yourself, on your own computer, with your own model key.",
  "Sharing over the internet. Sharing works on the same Wi-Fi only.",
  "Tested on Windows or on a Linux desktop. It has been run on macOS, and its server tests have run in Linux containers.",
  "Attachments that are not text, such as pictures and PDFs.",
  "Pricing. There is none."
];

export default function Marketing() {
  // The host (signed in, on this computer's own address) gets a link to their rooms; nobody else is shown it.
  const [isHost, setIsHost] = useState(false);
  useEffect(() => {
    let live = true;
    getStatus().then((s) => live && setIsHost(s?.host === true));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">Skip to content</a>

      <header className={styles.bar}>
        <a className={styles.wordmark} href="/">Multiplayer AI</a>
        <nav className={styles.nav} aria-label="Page sections">
          <a href="/new">Start a room</a>
          {isHost && <a href="/rooms">Your rooms</a>}
          <a href="#how-it-works">How it works</a>
          <a href="#themes">Themes</a>
          <a href="#today">Today</a>
          <a href="#self-host">Run it yourself</a>
        </nav>
      </header>

      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroText}>
            <h1 id="hero-title" className={styles.heroTitle}>
              Multiplayer AI is a shared room where a whole team watches one AI agent work and steers it together.
            </h1>
            <p className={styles.heroAction}>
              <a className={styles.primary} href="/new">Start a room</a>
              <a className={styles.heroLink} href="#self-host">Run it yourself</a>
              <span className={styles.heroMeta}>Open source, MIT licensed.</span>
            </p>
          </div>
          <ReplayRoom />
        </section>

        <section id="how-it-works" className={styles.section} aria-labelledby="how-title">
          <h2 id="how-title" className={styles.h2}>How a session goes</h2>
          <ol className={styles.steps}>
            {STEPS.map((step, i) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden="true">{i + 1}</span>
                <div className={styles.stepText}>
                  <h3 className={styles.h3}>{step.title}</h3>
                  {step.body.map((p) => <p key={p}>{p}</p>)}
                </div>
                <img
                  className={styles.stepImage}
                  src={step.image.src}
                  width={step.image.width}
                  height={step.image.height}
                  alt={step.image.alt}
                  loading="lazy"
                />
              </li>
            ))}
          </ol>
        </section>

        <section id="themes" className={styles.section} aria-labelledby="themes-title">
          <h2 id="themes-title" className={styles.h2}>The same room, four ways</h2>
          <p className={styles.lead}>
            The room can be drawn in any of four themes, each with a light and a dark mode. The choice is saved in your
            browser. These are screenshots of the room replayed above.
          </p>
          <ThemeShowcase />
        </section>

        <section id="today" className={styles.section} aria-labelledby="today-title">
          <h2 id="today-title" className={styles.h2}>What exists today, and what doesn't</h2>
          <div className={styles.today}>
            <div>
              <h3 className={styles.h3}>Works now</h3>
              <ul className={styles.list}>
                {WORKS.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
            <div>
              <h3 className={styles.h3}>Not built yet</h3>
              <ul className={styles.list}>
                {MISSING.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          </div>
        </section>

        <section id="self-host" className={styles.section} aria-labelledby="self-title">
          <h2 id="self-title" className={styles.h2}>Run it yourself</h2>
          <p className={styles.lead}>
            You need Node 22.13 or newer and a key for a model provider. There is no database to set up and no
            file to edit. The README has the full steps; this is the short version.
          </p>
          <ol className={styles.runSteps}>
            <li>Get the code: <code>git clone https://github.com/Abhijay-MSD/multiplayer-ai.git</code>, or download the ZIP from <a href="https://github.com/Abhijay-MSD/multiplayer-ai">the repository's page</a>.</li>
            <li>Go into the folder it made: <code>cd multiplayer-ai</code>.</li>
            <li>Start it: <code>npm start</code>. The first start installs what it needs, which takes an internet connection and can take a minute.</li>
            <li>Open the sign-in link it prints, choose a provider and paste your key in Setup, then choose <strong>Start a room</strong>.</li>
            <li>To let people on your Wi-Fi in, start with <code>npm start -- --share=wifi</code> and use <strong>Host controls</strong> in the room. An MCP client can start a room with <code>create_session</code> instead.</li>
          </ol>
          {GITHUB_URL && (
            <p className={styles.links}>
              <a className={styles.primary} href={GITHUB_URL}>Source on GitHub</a>
            </p>
          )}
        </section>
      </main>

      <footer className={styles.footer}>
        <p>Multiplayer AI is an open-source prototype, released under the MIT license.</p>
        <ModeToggle />
      </footer>
    </div>
  );
}
