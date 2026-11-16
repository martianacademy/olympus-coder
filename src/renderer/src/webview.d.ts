import 'react';

// Electron's <webview> tag, used by the Web tab (WebPreview.tsx).
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string; allowpopups?: string };
    }
  }
}
