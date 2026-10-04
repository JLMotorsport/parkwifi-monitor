import { createRoot } from 'react-dom/client';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import { App } from './App';
import { applyTheme, loadTheme } from './derive';
import './styles.css';

applyTheme(loadTheme());
createRoot(document.getElementById('root')!).render(<App />);
