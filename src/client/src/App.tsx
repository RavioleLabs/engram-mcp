// src/client/src/App.tsx
import { Routes, Route, NavLink, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette.js';
import { SyncIndicator } from './components/SyncIndicator.js';
import { connectWebSocket } from './ws.js';
import Home from './pages/Home.js';
import Browse from './pages/Browse.js';
import Search from './pages/Search.js';
import DailyNotes from './pages/DailyNotes.js';
import Sources from './pages/Sources.js';
import Types from './pages/Types.js';
import Settings from './pages/Settings.js';
import ViewEditor from './pages/ViewEditor.js';
import Graph from './pages/Graph.js';

export default function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKeydown);
    const disconnect = connectWebSocket();
    return () => {
      window.removeEventListener('keydown', onKeydown);
      disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 border-r border-zinc-800 p-4 space-y-2">
        <div className="flex items-center justify-between mb-4">
          <Link to="/" className="block text-lg font-semibold">
            EngramMCP
          </Link>
          <SyncIndicator />
        </div>
        <NavLink to="/" end className={navClass}>
          Home
        </NavLink>
        <NavLink to="/browse" className={navClass}>
          Browse
        </NavLink>
        <NavLink to="/search" className={navClass}>
          Search
        </NavLink>
        <NavLink to="/daily" className={navClass}>
          Daily Notes
        </NavLink>
        <NavLink to="/sources" className={navClass}>
          Sources
        </NavLink>
        <NavLink to="/types" className={navClass}>
          Memory Types
        </NavLink>
        <NavLink to="/graph" className={navClass}>
          Graph
        </NavLink>
        <NavLink to="/settings" className={navClass}>
          Settings
        </NavLink>
        <button
          className="mt-8 w-full text-left text-xs text-zinc-500 hover:text-zinc-200"
          onClick={() => setPaletteOpen(true)}
        >
          ⌘K — Quick capture
        </button>
      </aside>

      <main className="flex-1 p-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/search" element={<Search />} />
          <Route path="/daily" element={<DailyNotes />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/types" element={<Types />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/views/:id" element={<ViewEditor />} />
          <Route path="/graph" element={<Graph />} />
        </Routes>
      </main>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `block px-3 py-2 rounded ${
    isActive ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
  }`;
}
