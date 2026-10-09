// The secret token the server issued for one room lives in localStorage, per
// room, so closing the tab does not lock you out. It is sent in the body of
// each call and in an Authorization header on the stream, never in a URL.
// Every access is wrapped: storage can be blocked (private windows, site data
// settings), and the app must still load.
const tokenKey = (sessionId) => `multiplayer-ai:token:${sessionId}`;

export function getToken(sessionId) {
  try {
    return localStorage.getItem(tokenKey(sessionId)) || null;
  } catch {
    return null;
  }
}

export function saveToken(sessionId, token) {
  try {
    localStorage.setItem(tokenKey(sessionId), token);
  } catch {
    /* the room still works for this tab */
  }
}

export function clearToken(sessionId) {
  try {
    localStorage.removeItem(tokenKey(sessionId));
  } catch {
    /* nothing to clear */
  }
}

// The display name last used in this browser. Only ever a suggestion that
// prefills a form; nobody joins or starts a room under it without confirming.
const NAME_KEY = "multiplayer-ai:name";

export function getRememberedName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberName(name) {
  try {
    name ? localStorage.setItem(NAME_KEY, name) : localStorage.removeItem(NAME_KEY);
  } catch {
    /* the name just isn't remembered */
  }
}
