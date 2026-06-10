import { createRoot } from 'react-dom/client';
import { MarkdownEditor } from './MarkdownEditor';

declare global {
  interface Window {
    contentInjected: boolean | undefined;
  }
}

// On Android, react-native-webview sometimes injects the page content AFTER the
// window load event (react-native-webview#2960). TenTap's RN side sets
// window.contentInjected once it has pushed the initial content, so we wait for
// that flag before mounting — otherwise the editor renders against empty state.
// This mirrors @10play/tentap-editor's own simpleWebEditor bootstrap.
const interval = setInterval(() => {
  if (!window.contentInjected) return;
  const container = document.getElementById('root');
  if (container) {
    createRoot(container).render(<MarkdownEditor />);
  }
  clearInterval(interval);
}, 1);
