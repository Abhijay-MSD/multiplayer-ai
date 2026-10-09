import { lazy, Suspense } from "react";
import { FailureScreen } from "./components/FailureScreen";
import { describeFailure } from "./lib/failures";

// Lazy so a route only loads what it uses. In particular the QA fixture route
// never imports the Supabase client, which throws without env vars.
const SessionRoom = lazy(() => import("./components/SessionRoom").then((m) => ({ default: m.SessionRoom })));

const Marketing = lazy(() => import("./marketing/Marketing"));
const StartRoom = lazy(() => import("./components/StartRoom"));
const Setup = lazy(() => import("./components/Setup"));
const Settings = lazy(() => import("./components/Settings"));
const RoomsPage = lazy(() => import("./components/RoomsPage"));

// Test pages are in the dev server and in builds made with VITE_FIXTURES=1.
// In any other build this is a constant false and the fixture code is dropped.
const FIXTURES = import.meta.env.DEV || import.meta.env.VITE_FIXTURES === "1";
const FixtureRoute = FIXTURES ? lazy(() => import("./qa/FixtureRoute")) : null;

// The landing page at /, starting a room at /new, the room at /s/:id, and the host's
// three pages: /setup (the first run), /settings and /rooms (the list of rooms). That is all the routing there is, so
// no router dependency.
function getSessionId() {
  const match = window.location.pathname.match(/^\/s\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

export default function App() {
  if (FIXTURES && window.location.pathname.startsWith("/__fixture/")) {
    return (
      <Suspense fallback={null}>
        <FixtureRoute />
      </Suspense>
    );
  }

  // Where the server sends someone whose sign-in link was refused (expired, used, or opened elsewhere).
  if (/^\/signin-expired\/?$/.test(window.location.pathname)) {
    return <FailureScreen failure={describeFailure({ code: "SIGNIN_EXPIRED" })} />;
  }

  if (/^\/setup\/?$/.test(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <Setup />
      </Suspense>
    );
  }

  if (/^\/settings\/?$/.test(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <Settings />
      </Suspense>
    );
  }

  if (/^\/rooms\/?$/.test(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <RoomsPage />
      </Suspense>
    );
  }

  if (/^\/new\/?$/.test(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <StartRoom />
      </Suspense>
    );
  }

  const sessionId = getSessionId();

  if (!sessionId) {
    return (
      <Suspense fallback={null}>
        <Marketing />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={null}>
      <SessionRoom sessionId={sessionId} />
    </Suspense>
  );
}
