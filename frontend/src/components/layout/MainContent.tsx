import type { ReactNode } from 'react';

interface MainContentProps {
  children: ReactNode;
}

export function MainContent({ children }: MainContentProps) {
  return (
    <main className="main-content" id="main-content" role="main">
      {children}
    </main>
  );
}
