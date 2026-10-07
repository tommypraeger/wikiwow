import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ServerConfig } from '../shared/types';
import { Home } from './Home';
import { Game } from './Game';
import { api, usePath, useToast } from './util';

function App() {
  const path = usePath();
  const toast = useToast();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    api<ServerConfig>('/api/config').then(setConfig, () => setConfig(null));
  }, []);

  const m = path.match(/^\/r\/([A-Za-z]{4})\/?$/);
  return (
    <>
      {m ? <Game key={m[1].toUpperCase()} code={m[1].toUpperCase()} /> : <Home config={config} />}
      <div id="toast" role="status" aria-live="polite" className={toast ? 'show' : ''}>
        {toast}
      </div>
    </>
  );
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
