import type { ReactNode } from "react";

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

export function renderAgentMarkdown(text: string): ReactNode[] {
  const lines = text.split("\n");
  const output: ReactNode[] = [];
  let codeLines: string[] | undefined;
  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (codeLines) { output.push(<pre className="agent-md-code" key={`code-${index}`}><code>{codeLines.join("\n")}</code></pre>); codeLines = undefined; }
      else codeLines = [];
      return;
    }
    if (codeLines) { codeLines.push(line); return; }
    if (!line.trim()) { output.push(<br key={`break-${index}`} />); return; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const heading = line.match(/^\s*#{1,3}\s+(.*)$/);
    if (heading) output.push(<strong className="agent-md-heading" key={index}>{renderInlineMarkdown(heading[1])}</strong>);
    else if (bullet) output.push(<span className="agent-md-list-item" key={index}><span aria-hidden="true">•</span>{renderInlineMarkdown(bullet[1])}</span>);
    else if (ordered) output.push(<span className="agent-md-list-item" key={index}><span aria-hidden="true">{line.match(/^\s*(\d+)/)?.[1]}.</span>{renderInlineMarkdown(ordered[1])}</span>);
    else if (quote) output.push(<span className="agent-md-quote" key={index}>{renderInlineMarkdown(quote[1])}</span>);
    else output.push(<span className="agent-md-line" key={index}>{renderInlineMarkdown(line)}</span>);
  });
  if (codeLines) output.push(<pre className="agent-md-code" key="code-final"><code>{codeLines.join("\n")}</code></pre>);
  return output;
}
