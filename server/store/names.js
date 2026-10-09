/** What "the same name" means: letter case and compatibility forms ignored. */
export const nameKey = (name) => String(name).normalize("NFKC").toLowerCase();
