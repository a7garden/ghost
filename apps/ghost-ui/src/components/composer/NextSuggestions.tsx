/** The owner's likely next messages as quiet rows above an empty composer; the first is reachable with Tab, a tap puts any of them in the field. */
export function NextSuggestions({ items, onPick }: { items: readonly string[]; onPick(text: string): void }) {
  return <ul className="next-suggest" aria-label="다음 메시지 제안">
    {items.map((text, index) => <li key={text}>
      <button type="button" onClick={() => onPick(text)}><span>{text}</span>{index === 0 && <kbd aria-hidden="true">Tab</kbd>}</button>
    </li>)}
  </ul>;
}
