// Pure text helpers (no DOM), shared by pages and unit tests.

/** Up to two initials from letters only ("Dana 2 Dee" gives "DD"); falls back to "?" when there are none. */
export function initials(name: string) {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ""))
    .filter(Boolean);
  const out = words
    .slice(0, 2)
    .map((w) => [...w][0]!.toLocaleUpperCase())
    .join("");
  return out || "?";
}
