import type { ReactNode } from 'react';

/** JSON.stringify 的输出只包含这些 token；标点和空白保留为原始文本。 */
const JSON_TOKEN_PATTERN =
  /(?<key>"(?:\\.|[^"\\])*"(?=\s*:))|(?<string>"(?:\\.|[^"\\])*")|(?<number>-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<literal>\b(?:true|false|null)\b)/g;

export function JsonCode({ source }: { source: string }) {
  const parts: ReactNode[] = [];
  let position = 0;

  for (const match of source.matchAll(JSON_TOKEN_PATTERN)) {
    const token =
      match.groups?.key !== undefined
        ? 'key'
        : match.groups?.string !== undefined
          ? 'string'
          : match.groups?.number !== undefined
            ? 'number'
            : 'literal';

    if (match.index > position) parts.push(source.slice(position, match.index));
    parts.push(
      <span className="trace-json-token" data-token={token} key={match.index}>
        {match[0]}
      </span>,
    );
    position = match.index + match[0].length;
  }

  if (position < source.length) parts.push(source.slice(position));
  return <pre className="trace-inspector-code">{parts}</pre>;
}
