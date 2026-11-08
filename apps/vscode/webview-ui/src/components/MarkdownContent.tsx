import { useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { highlight } from 'sugar-high';
import { lang } from 'sugar-high/lang';

interface MarkdownContentProps {
  content: string;
}

interface CodeBlockProps {
  language: string;
  code: string;
}

const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const html = useMemo(
    () => highlight(code, { lang: lang(language) ?? 'javascript' }),
    [language, code]
  );

  return (
    <pre className="sugar-high-block">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
});

export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  const components = useMemo(
    () => ({
      code({ className, children, ...props }: React.ComponentProps<'code'>) {
        const match = /language-(\w+)/.exec(className || '');
        const codeString = String(children).replace(/\n$/, '');

        if (match) {
          return <CodeBlock language={match[1]} code={codeString} />;
        }

        return (
          <code className="inline-code" {...props}>
            {children}
          </code>
        );
      },
      pre({ children }: React.ComponentProps<'pre'>) {
        return <div className="code-block-wrapper">{children}</div>;
      },
    }),
    []
  );

  return (
    <div className="markdown-content">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
});
