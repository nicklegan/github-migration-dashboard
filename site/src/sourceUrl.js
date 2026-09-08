// Splits a source repository URL into its namespace and repository name.
// Pure logic, no React, so it unit-tests directly.
//
// Shapes handled:
//   GitHub / ghe.com  https://host/owner/repo
//   GHES              https://host/owner/repo
//   GitLab            https://host/group/subgroup/.../project
//   Bitbucket Cloud   https://bitbucket.org/workspace/repo
//   Bitbucket Server  https://host/scm/PROJECT/repo
//                     https://host/projects/PROJECT/repos/repo/browse
//   Azure DevOps      https://dev.azure.com/org/project/_git/repo
//                     https://org.visualstudio.com/project/_git/repo

function segmentsOf(url) {
  const parsed = new URL(url);
  return parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function stripGitSuffix(segment) {
  return segment.replace(/\.git$/i, "");
}

// Azure DevOps puts the repository after a `_git` marker, so anything before it
// is the namespace (organization plus project, or just project on the legacy
// visualstudio.com host).
function parseAzureDevOps(segments) {
  const marker = segments.indexOf("_git");
  if (marker === -1 || marker === segments.length - 1) return null;
  return {
    namespace: segments.slice(0, marker).join("/"),
    repository: stripGitSuffix(segments[marker + 1]),
  };
}

// Bitbucket Server exposes both a clone path (/scm/KEY/repo) and a browse path
// (/projects/KEY/repos/repo/browse).
function parseBitbucketServer(segments) {
  if (segments[0] === "scm" && segments.length >= 3) {
    return {
      namespace: segments.slice(1, -1).join("/"),
      repository: stripGitSuffix(segments[segments.length - 1]),
    };
  }
  if (segments[0] === "projects" && segments[2] === "repos" && segments[3]) {
    return { namespace: segments[1], repository: stripGitSuffix(segments[3]) };
  }
  return null;
}

// Returns { namespace, repository } or null when the URL carries neither —
// placeholder values such as "https://not-used" appear in real migration data.
function parseSourceUrl(url) {
  if (!url) return null;

  let segments;
  try {
    segments = segmentsOf(url);
  } catch {
    return null;
  }
  if (segments.length === 0) return null;

  const azure = parseAzureDevOps(segments);
  if (azure) return azure;

  const bitbucket = parseBitbucketServer(segments);
  if (bitbucket) return bitbucket;

  const repository = stripGitSuffix(segments[segments.length - 1]);
  // Everything above the repository is the namespace, which keeps GitLab's
  // nested subgroups intact.
  const namespace = segments.slice(0, -1).join("/");
  return { namespace: namespace || null, repository };
}

export { parseSourceUrl };
