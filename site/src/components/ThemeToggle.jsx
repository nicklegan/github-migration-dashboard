import { useTheme } from "../ThemeProvider.jsx";
import Icon from "./Icon.jsx";

// Two-state switch. With nothing stored the dashboard follows the operating
// system, and flipping back to whatever the system already wants returns it to
// following rather than pinning the same value.
export default function ThemeToggle() {
  const { theme, preference, toggle } = useTheme();
  const goingTo = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={`Switch to ${goingTo} mode`}
      title={
        preference === "system"
          ? `Following your system theme (${theme}). Click for ${goingTo} mode.`
          : `${theme[0].toUpperCase()}${theme.slice(1)} mode. Click for ${goingTo} mode.`
      }
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
