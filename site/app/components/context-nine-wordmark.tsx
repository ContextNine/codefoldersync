export function ContextNineWordmark() {
  return (
    <span className="ctx9-wordmark" aria-label="Context Nine">
      <span aria-hidden="true" className="ctx9-wordmark-mark">
        {Array.from({ length: 9 }, (_, index) => (
          <i key={index} />
        ))}
      </span>
      <span>Context Nine</span>
    </span>
  );
}
