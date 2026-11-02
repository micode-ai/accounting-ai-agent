'use client';

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '@/lib/utils';
import { MarkdownLink } from './MarkdownLink';
import type { Components } from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  variant?: 'chat' | 'help' | 'default';
  enableFileDownloads?: boolean;
}

export function MarkdownRenderer({
  content,
  className,
  variant = 'default',
  enableFileDownloads = false,
}: MarkdownRendererProps) {
  const proseClasses = cn(
    'prose prose-sm dark:prose-invert max-w-none',
    'prose-p:my-1 prose-headings:mt-3 prose-headings:mb-2',
    'prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-2',
    'prose-code:before:content-none prose-code:after:content-none',
    variant === 'chat' && 'prose-p:leading-relaxed',
    variant === 'help' && 'prose-p:leading-relaxed prose-li:my-0.5',
    className
  );

  const components: Components = useMemo(
    () => ({
      code: ({ className, children, ...props }) => {
        // Check if this is inline code (not inside a pre tag)
        // In react-markdown v9, inline code doesn't have a language class
        const isInline = !className?.includes('language-');

        if (isInline) {
          return (
            <code
              className="bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 px-1.5 py-0.5 rounded text-xs font-mono"
              {...props}
            >
              {children}
            </code>
          );
        }

        return (
          <code className={cn('font-mono', className)} {...props}>
            {children}
          </code>
        );
      },
      pre: ({ children }) => (
        <pre className="bg-gray-800 dark:bg-gray-900 text-gray-100 rounded-lg p-3 my-2 overflow-x-auto text-xs">
          {children}
        </pre>
      ),
      a: ({ href, children }) => (
        <MarkdownLink href={href} enableFileDownloads={enableFileDownloads}>
          {children}
        </MarkdownLink>
      ),
      // Never load a remote image: chat answers can echo third-party text (e.g. AI Budget merchants),
      // and an injected `![](https://…?d=…)` would send data to that host the moment it renders.
      img: ({ alt }) => (
        <span className="text-gray-500 dark:text-gray-400">{alt ? `[image: ${alt}]` : '[image]'}</span>
      ),
      table: ({ children }) => (
        <div className="my-2 overflow-x-auto">
          <table className="border-collapse border border-gray-300 dark:border-gray-600 text-xs w-full">
            {children}
          </table>
        </div>
      ),
      th: ({ children }) => (
        <th className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 bg-gray-100 dark:bg-gray-700 font-semibold text-left">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="border border-gray-300 dark:border-gray-600 px-3 py-1.5">
          {children}
        </td>
      ),
    }),
    [enableFileDownloads]
  );

  return (
    <div className={proseClasses}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
