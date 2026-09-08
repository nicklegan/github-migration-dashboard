import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { STORAGE_KEY, normalizePreference, resolveTheme, nextPreference } from "./theme.js";
import { readChartTheme } from "./chartTheme.js";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext(null);

// Storage is unavailable in some embedded and privacy contexts; a theme choice
// is not worth failing the page over, it just stops surviving a reload.
function readStored() {
  try {
    return normalizePreference(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

function systemPrefersDark() {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(readStored);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const theme = resolveTheme(preference, prefersDark);
  const [chart, setChart] = useState(readChartTheme);

  // Follows the OS live, so an unpinned dashboard left open overnight switches
  // with everything else on the machine.
  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) return undefined;
    const onChange = (event) => setPrefersDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // The chart colours live in CSS, so they can only be read once the attribute
  // that selects them is on the document.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    setChart(readChartTheme());
  }, [theme]);

  useEffect(() => {
    try {
      if (preference === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* see readStored */
    }
  }, [preference]);

  const toggle = useCallback(
    () => setPreference((current) => nextPreference(current, prefersDark)),
    [prefersDark],
  );

  const value = useMemo(() => ({ theme, preference, toggle, chart }), [theme, preference, toggle, chart]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside a ThemeProvider");
  return value;
}

// The resolved chart palette for the current theme. Stable between theme
// changes, so the charts' own memos keep working.
export function useChartTheme() {
  return useTheme().chart;
}
