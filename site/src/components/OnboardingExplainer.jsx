import { dateTime } from "../format.js";
import Icon from "./Icon.jsx";

// What every number on the Onboarding tab means, in one place. Kept on the page
// rather than in the README because the people reading the dashboard are rarely
// the people who configured it, and "onboarded since when?" is the first
// question anyone asks of it.
export default function OnboardingExplainer({ windowDays, generatedAt }) {
  return (
    <details className="explainer">
      <summary>
        <Icon name="info" size={14} />
        How onboarding is measured
      </summary>
      <div className="explainer-body">
        <dl>
          <dt>Fully green</dt>
          <dd>
            Every workflow the repository is scored on has passed at least once. Scored workflows are
            the ones that came with the repository or were added inside its window; reusable workflows,
            manual-only workflows that have never been run, and workflows added after the window are
            not scored.
          </dd>

          <dt>Window</dt>
          <dd>
            Each repository gets <strong>{windowDays} days</strong> from its first successful migration
            to become fully green. The clock is that repository's own, not a calendar range, so the
            time filter does not apply here: a repository migrated a year ago is judged on the same{" "}
            {windowDays} days as one migrated last week.
          </dd>

          <dt>Statuses</dt>
          <dd>
            <ul>
              <li>
                <strong>On time</strong>: fully green within the window. Counted as soon as it happens,
                so a repository can be on time while its window is still open.
              </li>
              <li>
                <strong>Late</strong>: fully green, but only after the window closed.
              </li>
              <li>
                <strong>Not onboarded</strong>: the window has closed and a workflow is still failing or
                has never run.
              </li>
              <li>
                <strong>Still onboarding</strong>: the window is open and not every workflow is green yet.
              </li>
              <li>
                <strong>No workflows</strong>: the window closed with nothing to run. Left out of every
                rate.
              </li>
            </ul>
          </dd>

          <dt>On-time rate</dt>
          <dd>
            On time ÷ repositories whose window has closed. Repositories still inside their window are
            left out until they are decided, so the fastest repositories of a new batch cannot flatter
            it.
          </dd>

          <dt>Fair comparisons</dt>
          <dd>
            A repository only counts towards “fully green within N days” once it has had N days, so a
            recent batch is never counted as failing for days it has not reached. A figure appears once
            at least five repositories qualify and, when periods are compared, at least half of the
            period has had that many days; periods still too young are shaded. The median is the day by
            which half of the repositories were fully green.
          </dd>

          <dt>Periods</dt>
          <dd>
            The summary compares repositories migrated in the latest month with those migrated the
            month before. The trend chart and the table beneath it follow the week, month, or quarter
            you choose; the table shows up to six periods and combines older ones into{" "}
            <em>Earlier</em>.
          </dd>

          <dt>As of</dt>
          <dd>
            A snapshot from the last sync{generatedAt ? ` (${dateTime(generatedAt)})` : ""}, not a
            history. A repository that goes green after its window closed moves from{" "}
            <em>Not onboarded</em> to <em>Late</em>.
          </dd>
        </dl>
      </div>
    </details>
  );
}
