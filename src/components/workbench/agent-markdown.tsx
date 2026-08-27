import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import "streamdown/styles.css";

/** Stream-safe GFM Markdown for untrusted assistant output. */
export function renderAgentMarkdown(text: string) {
  return <Streamdown className="agent-markdown" mode="streaming" plugins={{ cjk }} skipHtml>{text}</Streamdown>;
}
