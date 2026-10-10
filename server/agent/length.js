// The two texts that go with a reply that stopped because the provider's limit on its length was reached. The web app has
// the same two (web/src/lib/continue.js) and a test checks that they match: the line is how the app finds where to put the
// Continue button, and the message is what the button sends.
export const LENGTH_LIMIT_LINE = "The reply reached its length limit";
export const CONTINUE_TEXT = "Continue from where you stopped";
