// SANDBOX-ONLY stand-in for @types/react / @types/react-dom, used because the npm registry was unreachable while authoring.
// It type-checks component props, hooks and domain usage strictly; intrinsic HTML elements are loosely typed (any).
// DO NOT ship in the Vite project: install the real @types/react and @types/react-dom instead (see package.json).
declare module 'react' {
  export type ReactNode = unknown;
  export interface Context<T> { Provider: (props: { value: T; children?: ReactNode }) => import('react/jsx-runtime').JSX.Element; }
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(c: Context<T>): T;
  export function useState<S>(initial: S | (() => S)): [S, (v: S | ((prev: S) => S)) => void];
  export function useEffect(f: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(f: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...a: never[]) => unknown>(f: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
  export function useId(): string;
  export function createElement(type: string, props: Record<string, unknown> | null): import('react/jsx-runtime').JSX.Element;
}
declare module 'react-dom' { export function createPortal(children: unknown, container: Element): unknown; }
declare module 'react-dom/client' { export function createRoot(el: Element): { render(n: unknown): void }; }
declare module 'react/jsx-runtime' {
  export namespace JSX {
    interface Element { readonly __jsx: true }
    type Ev = { dataTransfer: any; target: any; currentTarget: any; key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void };
    type Handlers = { onChange?: (e: Ev) => void; onInput?: (e: Ev) => void; onBlur?: (e: Ev) => void; onFocus?: (e: Ev) => void; onClick?: (e: Ev) => void; onKeyDown?: (e: Ev) => void; onMouseDown?: (e: Ev) => void; onDragOver?: (e: Ev) => void; onDragEnter?: (e: Ev) => void; onDragLeave?: (e: Ev) => void; onDrop?: (e: Ev) => void };
    interface IntrinsicElements { [tag: string]: Handlers & { [attr: string]: any } }
    interface IntrinsicAttributes { key?: string | number }
    interface ElementChildrenAttribute { children: unknown }
  }
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export const Fragment: unknown;
}

declare module '*.css' { const css: string; export default css; }
// Stand-in for vite/client (the real project gets this from `/// <reference types="vite/client" />`).
declare module '*?url' { const u: string; export default u; }
declare module 'tesseract.js' { const t: unknown; export = t; }
declare module 'pdfjs-dist' { const p: unknown; export = p; }
interface ImportMetaEnv { readonly VITE_OCR_MODE?: string; readonly VITE_OCR_ENDPOINT?: string; readonly VITE_OCR_ASSETS_BASE?: string; readonly VITE_OCR_DEBUG?: string; readonly VITE_ATTACHMENT_VIEW_PATH?: string; readonly BASE_URL: string; readonly VITE_API_BASE_URL?: string; readonly VITE_API_TIMEOUT_MS?: string; readonly VITE_DATA_MODE?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
