// The Onboarding tab's opening paragraph. The sentences come from
// onboardingSummary.js; this only sets the numbers in bold.
export default function OnboardingSummary({ sentences }) {
  if (!sentences?.length) return null;
  return (
    <p className="onboarding-summary">
      {sentences.map((parts, i) => (
        <span key={i}>
          {i > 0 && " "}
          {parts.map((part, j) => (typeof part === "string" ? part : <strong key={j}>{part.strong}</strong>))}
        </span>
      ))}
    </p>
  );
}
