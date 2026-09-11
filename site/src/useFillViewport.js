import { useEffect, useRef } from "react";

// Sizes a table's scroll area to the window: when the page is scrolled to its
// end, the table's header sits at the top of the window and the rows fill the
// rest, leaving only the page's own bottom padding as a margin. The KPI cards
// above the table take most of a laptop screen, so sizing to "whatever is left
// below them" would leave only a few rows on the first screen; sizing to the
// window gives every screen as many rows as it can show once the reader
// scrolls to the table. Re-measured on resize and when the section header
// reflows (e.g. its tools wrap onto a second line on narrow windows).
const MIN_HEIGHT = 240;

export function useFillViewport(deps = []) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const section = el.closest("section") ?? el.parentElement;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const chrome = rect.top - section.getBoundingClientRect().top;
      // Space between the table and the end of the document (page padding,
      // section margin) — independent of the table's own height.
      const below = document.documentElement.scrollHeight - (rect.bottom + window.scrollY);
      const height = Math.max(MIN_HEIGHT, window.innerHeight - chrome - below);
      el.style.maxHeight = `${Math.round(height)}px`;
    };

    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
