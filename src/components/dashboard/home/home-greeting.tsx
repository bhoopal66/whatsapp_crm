// The home screen's "Good morning, Sara" line. One title per page: the
// top bar's title is the page's only heading, so the greeting is an
// intro line (a <p>) with the look of a heading, never an <h1>.
export function HomeGreeting({ text }: { text: string }) {
  return <p className="text-foreground truncate text-2xl font-bold">{text}</p>;
}
