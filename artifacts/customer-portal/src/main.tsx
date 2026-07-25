import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@/lib/api-client';

import App from './App';

import './index.css';

// The backend now lives on a separate origin (see pulsenet-api). Point the
// generated API client at it via an env var so this app can be deployed to
// Vercel independently of the monorepo/backend. Falls back to same-origin
// relative requests ("") when unset, e.g. behind a reverse proxy that
// forwards /api to the backend.
setBaseUrl(import.meta.env.VITE_API_BASE_URL || null);

createRoot(document.getElementById('root')!).render(<App />);
