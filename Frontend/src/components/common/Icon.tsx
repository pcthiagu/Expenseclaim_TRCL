import { createElement } from 'react';
import { ICON_SHAPES } from './iconPaths';

/**
 * 16px line icon. Renders real SVG elements (not injected HTML), so React keeps the same DOM nodes across re-renders:
 * a button's icon is never replaced between mouse-down and mouse-up, which would make the browser drop the click.
 */
export function Icon({ name, className, size = 16 }: { name: string; className?: string; size?: number }) {
  const shapes = ICON_SHAPES[name];
  if (!shapes) return null;
  return (
    <svg className={'tc-icon' + (className ? ' ' + className : '')} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
