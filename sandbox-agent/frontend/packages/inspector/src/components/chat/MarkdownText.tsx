import type { ReactNode } from "react";

const SAFE_URL_RE = /^(https?:\/\/|mailto:)/i;

const isSafeUrl = (url: string): boolean => SAFE_URL_RE.test(url.trim());

const inlineTokenRe = /(`[^`\n]+`|\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~)/g;

const parseInline = (text: string, keyPrefix: string): ReactNode[] => {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(inlineTokenRe)) {
    const token = match[0];
    const idx = match.index ?? 0;

    if (idx > lastIndex) {
      out.push(text.slice(lastIndex, idx));
    }

    const key = `${keyPrefix}-t-${tokenIndex++}`;

    if (token.startsWith("`") && token.endsWith("`")) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("__") && token.endsWith("__")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("_") && token.endsWith("_")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      out.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      if (!linkMatch) {
        out.push(token);
      } else {
        const label = linkMatch[1];
        const href = linkMatch[2];
        if (isSafeUrl(href)) {
          out.push(
            <a key={key} href={href} target="_blank" rel="noreferrer">
              {label}
            </a>,
          );
        } else {
          out.push(label);
        }
      }
    } else {
      out.push(token);
    }

    lastIndex = idx + token.length;
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }

  return out;
};

const renderInlineLines = (text: string, keyPrefix: string): ReactNode[] => {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}-br-${idx}`} />);
    out.push(...parseInline(line, `${keyPrefix}-l-${idx}`));
  });
  return out;
};

const isUnorderedListItem = (line: string): boolean => /^\s*[-*+]\s+/.test(line);
const isOrderedListItem = (line: string): boolean => /^\s*\d+\.\s+/.test(line);

const MarkdownText = ({ text }: { text: string }) => {
  const source = text.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const nodes: ReactNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].trim().startsWith("```")) i += 1;
      nodes.push(
        <pre key={`code-${nodes.length}`} className="md-pre">
          <code className={lang ? `language-${lang}` : undefined}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const key = `h-${nodes.length}`;
      if (level === 1) nodes.push(<h1 key={key}>{renderInlineLines(content, key)}</h1>);
      else if (level === 2) nodes.push(<h2 key={key}>{renderInlineLines(content, key)}</h2>);
      else if (level === 3) nodes.push(<h3 key={key}>{renderInlineLines(content, key)}</h3>);
      else if (level === 4) nodes.push(<h4 key={key}>{renderInlineLines(content, key)}</h4>);
      else if (level === 5) nodes.push(<h5 key={key}>{renderInlineLines(content, key)}</h5>);
      else nodes.push(<h6 key={key}>{renderInlineLines(content, key)}</h6>);
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const content = quoteLines.join("\n");
      const key = `q-${nodes.length}`;
      nodes.push(<blockquote key={key}>{renderInlineLines(content, key)}</blockquote>);
      continue;
    }

    if (isUnorderedListItem(line) || isOrderedListItem(line)) {
      const ordered = isOrderedListItem(line);
      const items: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i];
        if (ordered && isOrderedListItem(candidate)) {
          items.push(candidate.replace(/^\s*\d+\.\s+/, ""));
          i += 1;
          continue;
        }
        if (!ordered && isUnorderedListItem(candidate)) {
          items.push(candidate.replace(/^\s*[-*+]\s+/, ""));
          i += 1;
          continue;
        }
        if (!candidate.trim()) {
          i += 1;
          break;
        }
        break;
      }
      const key = `list-${nodes.length}`;
      if (ordered) {
        nodes.push(
          <ol key={key}>
            {items.map((item, idx) => (
              <li key={`${key}-i-${idx}`}>{renderInlineLines(item, `${key}-i-${idx}`)}</li>
            ))}
          </ol>,
        );
      } else {
        nodes.push(
          <ul key={key}>
            {items.map((item, idx) => (
              <li key={`${key}-i-${idx}`}>{renderInlineLines(item, `${key}-i-${idx}`)}</li>
            ))}
          </ul>,
        );
      }
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      const currentTrimmed = current.trim();
      if (!currentTrimmed) break;
      if (
        currentTrimmed.startsWith("```") ||
        currentTrimmed.startsWith(">") ||
        /^(#{1,6})\s+/.test(currentTrimmed) ||
        isUnorderedListItem(current) ||
        isOrderedListItem(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      i += 1;
    }
    const content = paragraphLines.join("\n");
    const key = `p-${nodes.length}`;
    nodes.push(<p key={key}>{renderInlineLines(content, key)}</p>);
  }

  return <div className="markdown-body">{nodes}</div>;
};

export default MarkdownText;
