import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

function App() {
  return <BrowserRouter>
    <Routes>
      <Route path="/" element={<main><h1>Welcome</h1><Link to="/about">About</Link></main>} />
      <Route path="/about" element={<main><h1>About this example</h1><Link to="/">Welcome</Link></main>} />
    </Routes>
  </BrowserRouter>;
}

createRoot(document.getElementById('root')!).render(<App />);
