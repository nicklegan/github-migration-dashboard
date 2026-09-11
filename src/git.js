import * as core from "@actions/core";
import { exec, getExecOutput } from "@actions/exec";

// Commits and pushes the refreshed data store so the next run can diff against
// it. Authentication rides the credentials actions/checkout persists in the
// repository config, so no token is handled here.

// The committer host follows the runner, keeping the address valid on
// github.com and ghe.com alike.
function committerEmail(serverUrl) {
  const host = new URL(serverUrl || "https://github.com").host;
  return `github-actions[bot]@users.noreply.${host}`;
}

async function isGitRepository() {
  const result = await getExecOutput("git", ["rev-parse", "--is-inside-work-tree"], {
    ignoreReturnCode: true,
    silent: true,
  });
  return result.exitCode === 0;
}

async function commitData(dataDir, message, committer) {
  if (!(await isGitRepository())) {
    core.warning(
      `Not inside a Git repository, so ${dataDir} was not committed. ` +
        `Add an actions/checkout step before this action, or set commit-data: 'false'.`,
    );
    return false;
  }

  await exec("git", ["add", "--", dataDir]);

  const diff = await getExecOutput("git", ["diff", "--cached", "--quiet", "--", dataDir], {
    ignoreReturnCode: true,
    silent: true,
  });
  if (diff.exitCode === 0) {
    core.info(`${dataDir} matches the committed copy; nothing to commit.`);
    return false;
  }

  await exec("git", [
    "-c",
    `user.name=${committer.name}`,
    "-c",
    `user.email=${committer.email}`,
    "commit",
    "-m",
    message,
    "--",
    dataDir,
  ]);

  // A concurrent run, or any commit that landed since the checkout, rejects the
  // push. Failing the job here would throw away a dashboard that is already
  // assembled, and nothing is lost by waiting: the cursors live in the same
  // commit, so the next run re-reads exactly the window this one did.
  const push = await getExecOutput("git", ["push"], { ignoreReturnCode: true });
  if (push.exitCode !== 0) {
    core.warning(
      `Could not push ${dataDir} (git push exited ${push.exitCode}); the next run picks it up again. ` +
        `Serialize runs with a workflow 'concurrency' group if this repeats.`,
    );
    return false;
  }

  return true;
}

export { commitData, committerEmail };
