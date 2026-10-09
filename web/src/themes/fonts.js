// Waits for a theme's fonts before the switcher applies it, so text does not reflow after the switch. The faces are
// bundled and already declared (bundled-fonts.js); this asks the browser to have them ready. The promise settles when
// they are ready or the timeout passes, whichever is first, so a slow disk can't hold the switch up.

export function ensureThemeFonts(theme, timeoutMs = 1200) {
  const families = theme.fonts?.families ?? [];
  if (!families.length) return Promise.resolve();
  const work = Promise.all(families.flatMap((f) => [document.fonts.load(`400 1em "${f}"`), document.fonts.load(`600 1em "${f}"`)]));
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return Promise.race([work.catch(() => {}), timeout]);
}
