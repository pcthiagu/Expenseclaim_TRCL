import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './app/App';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(<App />);
