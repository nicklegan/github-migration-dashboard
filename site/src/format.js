// Display formatting helpers.
export function percent(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

export function percent1(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function oneDecimal(value) {
  return value == null ? "—" : value.toFixed(1);
}

export function count(value) {
  return value == null ? "—" : value.toLocaleString();
}

export function minutes(value) {
  if (value == null) return "—";
  if (value < 60) return `${Math.round(value)} min`;
  const hours = value / 60;
  return `${hours.toFixed(1)} h`;
}

export function megabytes(value) {
  if (value == null) return "—";
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

export function dateTime(value) {
  return value ? new Date(value).toLocaleString() : "—";
}
