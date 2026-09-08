import { useState } from "react";
import { toCsv, csvFilename } from "../csv.js";
import Icon from "./Icon.jsx";

// Hands the browser a file without a server round trip. The object URL is
// revoked on the next frame, since revoking it synchronously can cancel the
// download in some browsers.
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

// Exports whatever the table is currently showing. `build` returns the headers
// and rows, and may be async: the workflow table has to fetch its detail before
// it can name a workflow.
export default function ExportCsvButton({ prefix, build, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const onClick = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const built = await build();
      // A null build is the caller declining, not a failure.
      if (built) download(csvFilename(prefix), toCsv(built.headers, built.rows));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="btn"
      onClick={onClick}
      disabled={disabled || busy}
      title="Download the rows currently shown, with every filter and the time range applied"
    >
      <Icon name="download" />
      {failed ? "Retry export" : busy ? "Preparing…" : "Export CSV"}
    </button>
  );
}
