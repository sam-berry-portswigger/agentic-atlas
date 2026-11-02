import { createElement, Fragment } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownText, remarkCitations } from "../shared/markdown.js";
/**
 * @param {{children:string,className?:string,inline?:boolean,sources?:Array<{title?:string,project?:string,timestamp?:string}>,onCitation?:(index:number)=>void}} props
 */
export default function Markdown({
  children,
  className = "",
  inline = false,
  sources = [],
  onCitation,
}) {
  return createElement(
    inline ? "span" : "div",
    { className: `markdown ${className}`.trim() },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: onCitation ? [remarkGfm, remarkCitations] : [remarkGfm],
        skipHtml: true,
        components: {
          ...(inline
            ? { p: ({ children }) => createElement(Fragment, null, children) }
            : {}),
          a: ({ node, href, children }) => {
            const number = Number(node?.properties?.["data-citation"]);
            if (Number.isInteger(number) && number >= 0) {
              const source = sources[number - 1];
              return source && onCitation
                ? createElement(
                    "button",
                    {
                      type: "button",
                      className: "answer-citation",
                      title:
                        source.title || source.project || `Source ${number}`,
                      "aria-label": `Show source ${number}`,
                      onClick: () => onCitation(number - 1),
                    },
                    String(number),
                  )
                : createElement(
                    "span",
                    {
                      className: "citation-unavailable",
                      title: "Supporting source unavailable",
                    },
                    `[${number}]`,
                  );
            }
            return createElement(
              "a",
              { href, target: "_blank", rel: "noreferrer noopener" },
              children,
            );
          },
          img: ({ src, alt }) =>
            createElement(
              "a",
              { href: src, target: "_blank", rel: "noreferrer noopener" },
              alt || "View image",
            ),
          table: ({ children }) =>
            createElement(
              "div",
              { className: "markdown-table" },
              createElement("table", null, children),
            ),
        },
      },
      markdownText(children),
    ),
  );
}
